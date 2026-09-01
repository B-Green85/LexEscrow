/**
 * LexEscrow — Chainlink CRE workflow.
 *
 * Two-handler pattern (mirrors the tokenized-asset-servicing reference):
 *
 *   onHTTPTrigger — receives a LexGuard-validated retainer payload from the
 *     LexEscrow desktop app. Verifies the attorney's CA State Bar status via a
 *     Chainlink Functions HTTP call (hard stop if inactive), converts the USD
 *     balances to USDC base units, encodes a signed settlement report, and
 *     writes it to the RetainerRelease receiver contract — directSettle (Path A)
 *     or lockArbitration (Path B) depending on the validated recommendation.
 *
 *   onLogTrigger — catches the on-chain RetainerReleased event and POSTs the
 *     settlement details to the notification endpoint, which triggers the
 *     post-settlement client email / SMS.
 *
 * Financial values arrive as integer-cent strings (BigInt can't be JSON
 * serialized) and are converted to USDC 6-decimal base units on chain-write.
 */

import {
  cre,
  Runner,
  type Runtime,
  getNetwork,
  type HTTPPayload,
  type HTTPSendRequester,
  ok,
  consensusIdenticalAggregation,
  type EVMLog,
  hexToBase64,
} from "@chainlink/cre-sdk";
import {
  bytesToHex,
  decodeEventLog,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  parseAbiParameters,
} from "viem";
import { z } from "zod";

// ── Config ──────────────────────────────────────────────────────────────────

const configSchema = z.object({
  // GET {bar} → HTTP 200 means an active CA licensee (an adapter wrapping the
  // CA State Bar portal; the V2 roadmap adds one adapter per state).
  barVerifyUrl: z.string(),
  // POST target that triggers the post-settlement client notification.
  notificationUrl: z.string(),
  evms: z.array(
    z.object({
      retainerReleaseAddress: z.string(),
      chainSelectorName: z.string(),
      gasLimit: z.string(),
      // Chainlink USDC/USD Data Feed (AggregatorV3 proxy) on this chain.
      // Optional: when absent the conversion falls back to a 1:1 peg, loudly.
      usdcUsdFeedAddress: z.string().optional(),
    }),
  ),
});

type Config = z.infer<typeof configSchema>;

/** LexGuard-validated payload delivered on the HTTP trigger. */
type RetainerPayload = {
  barNumber: string;
  clientId: string;
  clientWallet: `0x${string}`;
  lawFirmWallet: `0x${string}`;
  // integer cents, as strings
  totalHeldCents: string;
  earnedFeesCents: string;
  unearnedBalanceCents: string;
  disputedAmountCents: string;
  recommendedPath: "DirectSettlement" | "ArbitrationEscrow";
  documentHash: `0x${string}`; // 32-byte hex
};

type BarStatus = { active: boolean };
type PostResponse = { statusCode: number };

// USDC has 6 decimals; 1 cent = 1e4 base units at an exact 1:1 USD/USDC peg.
// The live Chainlink USDC/USD rate (8-decimal fixed point) scales that: at
// rate r USD per USDC, X cents of USD buy X·1e4·1e8/r base units of USDC.
// All-integer arithmetic — floats are banned from settlement math.
const E8 = 100_000_000n; // 1.0 in the feed's 8-decimal fixed point
const usdcFromCents = (cents: string, usdcUsdRateE8: bigint): bigint =>
  (BigInt(cents) * 10_000n * E8) / usdcUsdRateE8;

// Chainlink AggregatorV3Interface — the only read the conversion needs.
const aggregatorV3Abi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

/** A round older than this is a stalled feed (the feed's heartbeat is 24h). */
const MAX_FEED_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Live USDC/USD rate (8-decimal fixed point) from the chain's Chainlink Data
 * Feed, read through the same EVM client capability the settlement write uses
 * (a consensus-observed `callContract`, i.e. an on-chain `eth_call`).
 *
 * Any failure — no feed configured, unreadable return data, a non-positive
 * answer, a stale round — logs a warning and falls back to the exact 1:1 peg:
 * a broken price feed must not break settlement, and with USDC at the peg the
 * fallback is the conservative choice. The fallback is always labelled as the
 * peg in the log; nothing downstream presents it as a feed reading.
 */
const readUsdcUsdRateE8 = (
  runtime: Runtime<Config>,
  evmClient: InstanceType<typeof cre.capabilities.EVMClient>,
  feedAddress: string | undefined,
): bigint => {
  if (!feedAddress) {
    runtime.log("WARN: no usdcUsdFeedAddress configured — converting at the 1:1 USD/USDC peg");
    return E8;
  }
  try {
    const reply = evmClient
      .callContract(runtime, {
        call: {
          to: hexToBase64(feedAddress),
          data: hexToBase64(
            encodeFunctionData({ abi: aggregatorV3Abi, functionName: "latestRoundData" }),
          ),
        },
      })
      .result();
    const [, answer, , updatedAt] = decodeFunctionResult({
      abi: aggregatorV3Abi,
      functionName: "latestRoundData",
      data: bytesToHex(reply.data),
    });
    if (answer <= 0n) {
      throw new Error(`non-positive answer ${answer}`);
    }
    const ageMs = runtime.now().getTime() - Number(updatedAt) * 1000;
    if (ageMs > MAX_FEED_AGE_MS) {
      throw new Error(`stale round — updated ${Math.round(ageMs / 1000)}s ago`);
    }
    runtime.log(`Chainlink USDC/USD feed ${feedAddress}: rate ${answer} (e8)`);
    return answer;
  } catch (e) {
    runtime.log(`WARN: USDC/USD feed read failed (${e}) — converting at the 1:1 USD/USDC peg`);
    return E8;
  }
};

// ── HTTP capability functions (run under DON consensus) ─────────────────────

/**
 * Attorney bar verification. The adapter returns HTTP 200 for an active
 * licensee and a non-2xx status otherwise, so only the status code is read.
 */
const verifyBar = (
  sendRequester: HTTPSendRequester,
  config: Config,
  barNumber: string,
): BarStatus => {
  // Support both a `{bar}` template and a base URL the bar number is appended
  // to (e.g. the mock adapter's `http://localhost:3001/calbar/`).
  const encoded = encodeURIComponent(barNumber);
  const url = config.barVerifyUrl.includes("{bar}")
    ? config.barVerifyUrl.replace("{bar}", encoded)
    : config.barVerifyUrl.replace(/\/?$/, "/") + encoded;
  const resp = sendRequester
    .sendRequest({
      url,
      method: "GET" as const,
      cacheSettings: { store: true, maxAge: "60s" },
    })
    .result();
  return { active: ok(resp) && resp.statusCode === 200 };
};

type NotificationData = {
  action: string; // on-chain event name: RetainerSettled | ArbitrationResolved
  documentHash: string;
  clientWallet: string;
  clientAmount: string;
  firmAmount: string;
};

const postNotification = (
  sendRequester: HTTPSendRequester,
  config: Config,
  data: NotificationData,
): PostResponse => {
  const bodyBytes = new TextEncoder().encode(JSON.stringify(data));
  const body = Buffer.from(bodyBytes).toString("base64");
  const resp = sendRequester
    .sendRequest({
      url: config.notificationUrl,
      method: "POST" as const,
      body,
      headers: { "Content-Type": "application/json" },
      cacheSettings: { store: true, maxAge: "60s" },
    })
    .result();
  if (!ok(resp)) {
    throw new Error(`Notification POST failed with status: ${resp.statusCode}`);
  }
  return { statusCode: resp.statusCode };
};

// ── Handlers ────────────────────────────────────────────────────────────────

const onHTTPTrigger = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  runtime.log("HTTP trigger received (LexGuard-validated payload)");

  if (!payload.input || payload.input.length === 0) {
    throw new Error("Payload is empty");
  }

  const p = JSON.parse(Buffer.from(payload.input).toString("utf-8")) as RetainerPayload;
  if (!p.barNumber || !p.clientWallet || !p.lawFirmWallet || !p.documentHash) {
    throw new Error("Payload missing required fields");
  }

  const httpClient = new cre.capabilities.HTTPClient();

  // 1) Verify CA State Bar status — hard stop before any funds move.
  const bar = httpClient
    .sendRequest(runtime, verifyBar, consensusIdenticalAggregation<BarStatus>())(
      runtime.config,
      p.barNumber,
    )
    .result();
  if (!bar.active) {
    throw new Error(`Attorney bar number ${p.barNumber} inactive — execution halted`);
  }
  runtime.log(`Attorney bar ${p.barNumber} verified active`);

  // 2) USD → USDC base units at the live Chainlink USDC/USD rate. The EVM
  // client is constructed here rather than at step 4 because the price read
  // and the settlement write share it.
  const evmConfig = runtime.config.evms[0];
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: evmConfig.chainSelectorName,
    isTestnet: true,
  });
  if (!network) {
    throw new Error(`Network not found: ${evmConfig.chainSelectorName}`);
  }
  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);

  const usdcUsdRateE8 = readUsdcUsdRateE8(runtime, evmClient, evmConfig.usdcUsdFeedAddress);
  const clientUsdc = usdcFromCents(p.unearnedBalanceCents, usdcUsdRateE8);
  const firmUsdc = usdcFromCents(p.earnedFeesCents, usdcUsdRateE8);
  const totalUsdc = usdcFromCents(p.totalHeldCents, usdcUsdRateE8);
  const disputedUsdc = usdcFromCents(p.disputedAmountCents, usdcUsdRateE8);

  // 3) Encode the settlement report. path 0 = DirectSettlement, 1 = Arbitration.
  const path = p.recommendedPath === "DirectSettlement" ? 0 : 1;
  const reportData = encodeAbiParameters(
    parseAbiParameters(
      "uint8 path, address clientWallet, address firmWallet, uint256 clientAmount, uint256 firmAmount, uint256 totalAmount, uint256 disputedAmount, bytes32 documentHash",
    ),
    [
      path,
      p.clientWallet,
      p.lawFirmWallet,
      path === 0 ? clientUsdc : 0n,
      path === 0 ? firmUsdc : 0n,
      path === 0 ? 0n : totalUsdc,
      disputedUsdc,
      p.documentHash,
    ],
  );

  // 4) Sign the report and write it to the RetainerRelease receiver.
  const reportResponse = runtime
    .report({
      encodedPayload: hexToBase64(reportData),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();

  const writeResult = evmClient
    .writeReport(runtime, {
      receiver: evmConfig.retainerReleaseAddress,
      report: reportResponse,
      gasConfig: { gasLimit: evmConfig.gasLimit },
    })
    .result();

  const txHash = bytesToHex(writeResult.txHash || new Uint8Array(32));
  runtime.log(`RetainerRelease settlement submitted (${p.recommendedPath}): ${txHash}`);
  return txHash;
};

// Events emitted by the RetainerRelease contract on settlement.
const eventAbi = parseAbi([
  "event RetainerSettled(bytes32 indexed documentHash, address indexed clientWallet, address indexed firmWallet, uint256 clientAmount, uint256 firmAmount, uint256 timestamp)",
  "event ArbitrationResolved(bytes32 indexed documentHash, address indexed resolvedBy, uint256 clientAmount, uint256 firmAmount, uint256 timestamp)",
]);

const onLogTrigger = (runtime: Runtime<Config>, log: EVMLog): string => {
  const topics = log.topics.map((topic) => bytesToHex(topic)) as [
    `0x${string}`,
    ...`0x${string}`[],
  ];

  let decoded;
  try {
    decoded = decodeEventLog({ abi: eventAbi, data: bytesToHex(log.data), topics });
  } catch {
    return "No key event detected";
  }
  if (decoded.eventName !== "RetainerSettled" && decoded.eventName !== "ArbitrationResolved") {
    return "No key event detected";
  }

  const args = decoded.args as unknown as {
    documentHash: `0x${string}`;
    clientWallet?: `0x${string}`;
    clientAmount: bigint;
    firmAmount: bigint;
  };
  runtime.log(`${decoded.eventName} detected (${args.documentHash})`);

  const httpClient = new cre.capabilities.HTTPClient();
  const result = httpClient
    .sendRequest(runtime, postNotification, consensusIdenticalAggregation<PostResponse>())(
      runtime.config,
      {
        action: decoded.eventName,
        documentHash: args.documentHash as string,
        clientWallet: (args.clientWallet ?? "0x") as string,
        clientAmount: args.clientAmount.toString(),
        firmAmount: args.firmAmount.toString(),
      },
    )
    .result();

  runtime.log(`Client notification triggered. Status ${result.statusCode}`);
  return "Success";
};

// ── Workflow wiring ─────────────────────────────────────────────────────────

const initWorkflow = (config: Config) => {
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: config.evms[0].chainSelectorName,
    isTestnet: true,
  });
  if (!network) {
    throw new Error(
      `Network not found for chain selector name: ${config.evms[0].chainSelectorName}`,
    );
  }

  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const httpTrigger = new cre.capabilities.HTTPCapability();

  return [
    cre.handler(
      evmClient.logTrigger({
        addresses: [hexToBase64(config.evms[0].retainerReleaseAddress)],
      }),
      onLogTrigger,
    ),
    cre.handler(httpTrigger.trigger({}), onHTTPTrigger),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}

main();
