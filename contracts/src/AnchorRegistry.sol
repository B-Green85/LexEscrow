// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD
pragma solidity ^0.8.24;

/// @title AnchorRegistry — public, permissionless document-hash anchoring for AnchorReceipt.
/// @notice Records the first time a document fingerprint was anchored. Re-anchoring an
///         already-anchored hash emits a fresh event but never moves the original timestamp,
///         so the provenance claim ("this document existed by T") cannot be pushed later.
contract AnchorRegistry {
    /// @notice documentHash → block.timestamp of its first anchoring (0 = never anchored).
    mapping(bytes32 => uint256) public anchoredAt;

    event Anchored(bytes32 indexed documentHash, uint256 timestamp, address indexed registrar);

    function anchor(bytes32 documentHash) external {
        if (anchoredAt[documentHash] == 0) anchoredAt[documentHash] = block.timestamp;
        emit Anchored(documentHash, block.timestamp, msg.sender);
    }

    function isAnchored(bytes32 documentHash) external view returns (bool) {
        return anchoredAt[documentHash] != 0;
    }
}
