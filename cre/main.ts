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
  encodeAbiParameters,
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

// USDC has 6 decimals; 1 cent = 1e4 base units at the USD/USDC 1:1 peg.
// (Chainlink Price Feeds would supply the exact rate; the peg is exact here.)
const usdcFromCents = (cents: string): bigint => BigInt(cents) * 10_000n;

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
  const url = config.barVerifyUrl.replace("{bar}", encodeURIComponent(barNumber));
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
  action: "RetainerReleased";
  documentHash: string;
  clientWallet: string;
  clientAmount: string;
  firmAmount: string;
  path: string;
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

  // 2) USD → USDC base units.
  const clientUsdc = usdcFromCents(p.unearnedBalanceCents);
  const firmUsdc = usdcFromCents(p.earnedFeesCents);
  const totalUsdc = usdcFromCents(p.totalHeldCents);
  const disputedUsdc = usdcFromCents(p.disputedAmountCents);

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

const eventAbi = parseAbi([
  "event RetainerReleased(bytes32 indexed documentHash, address indexed clientWallet, uint256 clientAmount, uint256 firmAmount, uint8 path)",
]);

const onLogTrigger = (runtime: Runtime<Config>, log: EVMLog): string => {
  const topics = log.topics.map((topic) => bytesToHex(topic)) as [
    `0x${string}`,
    ...`0x${string}`[],
  ];
  const decoded = decodeEventLog({ abi: eventAbi, data: bytesToHex(log.data), topics });

  if (decoded.eventName !== "RetainerReleased") {
    return "No key event detected";
  }

  const { documentHash, clientWallet, clientAmount, firmAmount, path } = decoded.args;
  runtime.log(`RetainerReleased detected for ${clientWallet} (${documentHash})`);

  const httpClient = new cre.capabilities.HTTPClient();
  const result = httpClient
    .sendRequest(runtime, postNotification, consensusIdenticalAggregation<PostResponse>())(
      runtime.config,
      {
        action: "RetainerReleased",
        documentHash: documentHash as string,
        clientWallet: clientWallet as string,
        clientAmount: (clientAmount as bigint).toString(),
        firmAmount: (firmAmount as bigint).toString(),
        path: (path as number).toString(),
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
