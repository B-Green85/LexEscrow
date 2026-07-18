// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReceiverTemplate} from "../interfaces/ReceiverTemplate.sol";

/// @title RetainerRelease — LexEscrow on-chain execution layer.
/// @notice The Chainlink CRE workflow writes a signed report to this contract
///         via the KeystoneForwarder; `onReport` (from ReceiverTemplate) verifies
///         the forwarder and hands the report to `_processReport`, which decodes
///         the settlement payload and dispatches to one of two paths:
///
///           Path A — DirectSettlement: atomically pays the client and the firm.
///           Path B — ArbitrationEscrow: locks the total and requires a 2-of-3
///                    (client / firm / arbitrator) resolution to release.
///
///         Path C — StagedRelease (`stagedDeposit` / `releaseMilestone`) pays out
///         a milestone schedule incrementally. It is not reachable through
///         `onReport`: every stage needs independent human authorization off
///         chain (spec §6 Path C), so it is `onlyWorkflow`-invoked per milestone
///         rather than driven by a single CRE report.
///
///         The same paths are exposed as `onlyWorkflow` functions for direct /
///         test invocation. All amounts are USDC base units (integer, 6 decimals)
///         — there are no floats anywhere on chain.
contract RetainerRelease is ReceiverTemplate {
    using SafeERC20 for IERC20;

    /// @dev Report path discriminator (matches the CRE workflow encoding).
    uint8 private constant PATH_DIRECT = 0;
    uint8 private constant PATH_ARBITRATION = 1;

    /// @notice The settlement token (USDC on the target network).
    IERC20 public immutable usdc;

    /// @notice The address permitted to call `directSettle` / `lockArbitration`
    ///         directly (the CRE workflow owner, or the deployer for testing).
    ///         CRE itself arrives through `onReport`, gated by the forwarder.
    address public workflow;

    /// @notice The third party to the 2-of-3 arbitration multisig.
    address public arbitrator;

    struct Arbitration {
        address clientWallet;
        address firmWallet;
        uint256 totalAmount;
        uint256 disputedAmount;
        uint256 proposedClientAmount;
        uint256 proposedFirmAmount;
        bool proposalSet;
        bool resolved;
    }

    /// @notice Upper bound on milestones per session, mirroring the app's
    ///         definition form. Bounds nothing on chain except griefing.
    uint256 public constant MAX_MILESTONES = 10;

    struct StagedRelease {
        uint256 totalAmount;
        uint256 milestoneCount;
        uint256 releasedAmount;
        uint256 releasedCount;
        mapping(uint256 => bool) milestoneReleased;
    }

    /// @notice sessionId → milestone-based escrow record (Path C).
    mapping(bytes32 => StagedRelease) internal stagedReleases;

    /// @notice documentHash → locked arbitration record.
    mapping(bytes32 => Arbitration) public arbitrations;
    /// @notice documentHash → signer → has signed the resolution.
    mapping(bytes32 => mapping(address => bool)) public disputeSignatures;
    /// @notice documentHash → number of distinct party signatures.
    mapping(bytes32 => uint8) public signatureCount;

    event RetainerSettled(
        bytes32 indexed documentHash,
        address indexed clientWallet,
        address indexed firmWallet,
        uint256 clientAmount,
        uint256 firmAmount,
        uint256 timestamp
    );
    event ArbitrationLocked(
        bytes32 indexed documentHash,
        address indexed clientWallet,
        address indexed firmWallet,
        uint256 totalAmount,
        uint256 disputedAmount,
        uint256 timestamp
    );
    event ArbitrationResolved(
        bytes32 indexed documentHash,
        address indexed resolvedBy,
        uint256 clientAmount,
        uint256 firmAmount,
        uint256 timestamp
    );
    event StagedDepositReceived(
        bytes32 indexed sessionId,
        uint256 totalAmount,
        uint256 milestoneCount,
        uint256 timestamp
    );
    event MilestoneReleased(
        bytes32 indexed sessionId,
        uint256 indexed milestoneIndex,
        address indexed recipient,
        uint256 amount,
        uint256 timestamp
    );
    event StagedReleaseCompleted(bytes32 indexed sessionId, uint256 totalReleased, uint256 timestamp);
    event WorkflowUpdated(address indexed previous, address indexed current);
    event ArbitratorUpdated(address indexed previous, address indexed current);

    error NotWorkflow(address sender);
    error NotAParty(address sender);
    error ZeroAddress();
    error InvalidPath(uint8 path);
    error ArbitrationExists(bytes32 documentHash);
    error UnknownArbitration(bytes32 documentHash);
    error AlreadyResolved(bytes32 documentHash);
    error SplitExceedsEscrow();
    error SplitMismatch();
    error InvalidStagedDeposit();
    error TooManyMilestones(uint256 count);
    error StagedReleaseExists(bytes32 sessionId);
    error UnknownStagedRelease(bytes32 sessionId);
    error BadMilestoneIndex(uint256 milestoneIndex);
    error MilestoneAlreadyReleased(uint256 milestoneIndex);
    error ReleaseExceedsDeposit();

    modifier onlyWorkflow() {
        if (msg.sender != workflow) revert NotWorkflow(msg.sender);
        _;
    }

    /// @param _forwarder  Chainlink KeystoneForwarder (verifies CRE reports).
    /// @param _usdc       USDC token address on the target network.
    /// @param _arbitrator Third arbitration signer. The deployer is the owner
    ///                    and the initial `workflow`.
    constructor(address _forwarder, address _usdc, address _arbitrator) ReceiverTemplate(_forwarder) {
        if (_usdc == address(0) || _arbitrator == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        arbitrator = _arbitrator;
        workflow = msg.sender;
        emit WorkflowUpdated(address(0), msg.sender);
        emit ArbitratorUpdated(address(0), _arbitrator);
    }

    // ── CRE entrypoint ───────────────────────────────────────────────────────

    /// @inheritdoc ReceiverTemplate
    /// @dev Decodes the CRE report. The tuple layout MUST match the workflow's
    ///      `encodeAbiParameters` in `cre/main.ts`.
    function _processReport(bytes calldata report) internal override {
        (
            uint8 path,
            address clientWallet,
            address firmWallet,
            uint256 clientAmount,
            uint256 firmAmount,
            uint256 totalAmount,
            uint256 disputedAmount,
            bytes32 documentHash
        ) = abi.decode(report, (uint8, address, address, uint256, uint256, uint256, uint256, bytes32));

        if (path == PATH_DIRECT) {
            _directSettle(clientWallet, firmWallet, clientAmount, firmAmount, documentHash);
        } else if (path == PATH_ARBITRATION) {
            _lockArbitration(clientWallet, firmWallet, totalAmount, documentHash, disputedAmount);
        } else {
            revert InvalidPath(path);
        }
    }

    // ── Path A — DirectSettlement ─────────────────────────────────────────────

    function directSettle(
        address clientWallet,
        address firmWallet,
        uint256 clientAmountUsdc,
        uint256 firmAmountUsdc,
        bytes32 documentHash
    ) external onlyWorkflow {
        _directSettle(clientWallet, firmWallet, clientAmountUsdc, firmAmountUsdc, documentHash);
    }

    function _directSettle(
        address clientWallet,
        address firmWallet,
        uint256 clientAmount,
        uint256 firmAmount,
        bytes32 documentHash
    ) internal {
        if (clientWallet == address(0) || firmWallet == address(0)) revert ZeroAddress();
        // Both transfers happen in one transaction: if either reverts (e.g. the
        // escrow is underfunded), the whole settlement reverts — all or nothing.
        if (clientAmount > 0) usdc.safeTransfer(clientWallet, clientAmount);
        if (firmAmount > 0) usdc.safeTransfer(firmWallet, firmAmount);
        emit RetainerSettled(documentHash, clientWallet, firmWallet, clientAmount, firmAmount, block.timestamp);
    }

    // ── Path B — ArbitrationEscrow ────────────────────────────────────────────

    function lockArbitration(
        address clientWallet,
        address firmWallet,
        uint256 totalAmount,
        bytes32 documentHash,
        uint256 disputedAmount
    ) external onlyWorkflow {
        _lockArbitration(clientWallet, firmWallet, totalAmount, documentHash, disputedAmount);
    }

    function _lockArbitration(
        address clientWallet,
        address firmWallet,
        uint256 totalAmount,
        bytes32 documentHash,
        uint256 disputedAmount
    ) internal {
        if (clientWallet == address(0) || firmWallet == address(0)) revert ZeroAddress();
        Arbitration storage arb = arbitrations[documentHash];
        if (arb.totalAmount != 0 || arb.resolved) revert ArbitrationExists(documentHash);
        arb.clientWallet = clientWallet;
        arb.firmWallet = firmWallet;
        arb.totalAmount = totalAmount;
        arb.disputedAmount = disputedAmount;
        // The USDC is assumed already held by this contract (funded escrow); the
        // total is now earmarked pending a 2-of-3 resolution.
        emit ArbitrationLocked(documentHash, clientWallet, firmWallet, totalAmount, disputedAmount, block.timestamp);
    }

    /// @notice Resolve a locked arbitration. Any of the three parties (client,
    ///         firm, arbitrator) signs a proposed split; the first signature
    ///         fixes the split and the funds release once a second party agrees
    ///         to the same split (2-of-3).
    /// @param documentHash The locked arbitration key.
    /// @param clientAmount USDC to the client (must equal the fixed proposal).
    /// @param firmAmount   USDC to the firm (must equal the fixed proposal).
    function resolveArbitration(bytes32 documentHash, uint256 clientAmount, uint256 firmAmount) external {
        Arbitration storage arb = arbitrations[documentHash];
        if (arb.totalAmount == 0) revert UnknownArbitration(documentHash);
        if (arb.resolved) revert AlreadyResolved(documentHash);
        if (msg.sender != arb.clientWallet && msg.sender != arb.firmWallet && msg.sender != arbitrator) {
            revert NotAParty(msg.sender);
        }
        if (clientAmount + firmAmount > arb.totalAmount) revert SplitExceedsEscrow();

        // First signer fixes the split; subsequent signers must match it.
        if (!arb.proposalSet) {
            arb.proposalSet = true;
            arb.proposedClientAmount = clientAmount;
            arb.proposedFirmAmount = firmAmount;
        } else if (clientAmount != arb.proposedClientAmount || firmAmount != arb.proposedFirmAmount) {
            revert SplitMismatch();
        }

        if (!disputeSignatures[documentHash][msg.sender]) {
            disputeSignatures[documentHash][msg.sender] = true;
            signatureCount[documentHash] += 1;
        }

        if (signatureCount[documentHash] >= 2) {
            arb.resolved = true;
            if (clientAmount > 0) usdc.safeTransfer(arb.clientWallet, clientAmount);
            if (firmAmount > 0) usdc.safeTransfer(arb.firmWallet, firmAmount);
            emit ArbitrationResolved(documentHash, msg.sender, clientAmount, firmAmount, block.timestamp);
        }
    }

    // ── Path C — StagedRelease ────────────────────────────────────────────────

    /// @notice Record a milestone-based escrow (spec §6 Path C, §10
    ///         `stagedRelease()`). The USDC is assumed already held by this
    ///         contract; this earmarks the total against a milestone schedule.
    /// @dev Milestone *definitions* (labels, conditions, evidence) live off
    ///      chain in SQLite — only the count and the released tally are
    ///      consensus-critical, because they are what bound the payouts.
    function stagedDeposit(bytes32 sessionId, uint256 totalAmount, uint256 milestoneCount)
        external
        onlyWorkflow
    {
        if (totalAmount == 0 || milestoneCount == 0) revert InvalidStagedDeposit();
        if (milestoneCount > MAX_MILESTONES) revert TooManyMilestones(milestoneCount);
        StagedRelease storage sr = stagedReleases[sessionId];
        if (sr.totalAmount != 0) revert StagedReleaseExists(sessionId);
        sr.totalAmount = totalAmount;
        sr.milestoneCount = milestoneCount;
        emit StagedDepositReceived(sessionId, totalAmount, milestoneCount, block.timestamp);
    }

    /// @notice Release one milestone's funds to `recipient`.
    /// @dev Two invariants make partial release safe:
    ///        1. a milestone index can be released at most once, and
    ///        2. the cumulative released amount can never exceed the deposit.
    ///      Without (2), rounding or an off-chain bug in the milestone schedule
    ///      could drain more than was ever deposited for this session.
    function releaseMilestone(
        bytes32 sessionId,
        uint256 milestoneIndex,
        address payable recipient,
        uint256 amount
    ) external onlyWorkflow {
        if (recipient == address(0)) revert ZeroAddress();
        StagedRelease storage sr = stagedReleases[sessionId];
        if (sr.totalAmount == 0) revert UnknownStagedRelease(sessionId);
        if (milestoneIndex >= sr.milestoneCount) revert BadMilestoneIndex(milestoneIndex);
        if (sr.milestoneReleased[milestoneIndex]) revert MilestoneAlreadyReleased(milestoneIndex);
        if (sr.releasedAmount + amount > sr.totalAmount) revert ReleaseExceedsDeposit();

        sr.milestoneReleased[milestoneIndex] = true;
        sr.releasedAmount += amount;
        sr.releasedCount += 1;

        if (amount > 0) usdc.safeTransfer(recipient, amount);
        emit MilestoneReleased(sessionId, milestoneIndex, recipient, amount, block.timestamp);

        if (sr.releasedCount == sr.milestoneCount) {
            emit StagedReleaseCompleted(sessionId, sr.releasedAmount, block.timestamp);
        }
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function setWorkflow(address _workflow) external onlyOwner {
        if (_workflow == address(0)) revert ZeroAddress();
        emit WorkflowUpdated(workflow, _workflow);
        workflow = _workflow;
    }

    function setArbitrator(address _arbitrator) external onlyOwner {
        if (_arbitrator == address(0)) revert ZeroAddress();
        emit ArbitratorUpdated(arbitrator, _arbitrator);
        arbitrator = _arbitrator;
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /// @notice USDC held by the escrow.
    function escrowBalance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice Progress of a milestone-based escrow.
    /// @dev `stagedReleases` holds a nested mapping, so Solidity cannot
    ///      synthesize a public getter for it — hence these explicit views.
    function stagedReleaseOf(bytes32 sessionId)
        external
        view
        returns (uint256 totalAmount, uint256 milestoneCount, uint256 releasedAmount, uint256 releasedCount)
    {
        StagedRelease storage sr = stagedReleases[sessionId];
        return (sr.totalAmount, sr.milestoneCount, sr.releasedAmount, sr.releasedCount);
    }

    /// @notice Has a specific milestone index already paid out?
    function isMilestoneReleased(bytes32 sessionId, uint256 milestoneIndex) external view returns (bool) {
        return stagedReleases[sessionId].milestoneReleased[milestoneIndex];
    }
}
