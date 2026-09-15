import {
	bytesToBase64,
	cre,
	hexToBase64,
	type HTTPPayload,
	ok,
	text,
	type TeeRuntime,
} from '@chainlink/cre-sdk'
import { encodeAbiParameters, type Hex, parseAbiParameters, sha256 } from 'viem'
import { z } from 'zod'

// ─── Config Schema ──────────────────────────────────────────
// The four required fields are the LexEscrow enclave contract. `aiModel` and
// `authorizedKeys` carry defaults so `config.staging.json` stays minimal:
//   - aiModel        the Messages API requires a model on every request.
//   - authorizedKeys the HTTP trigger validates the signature of the incoming
//                    request against these public keys. An empty list means any
//                    caller can invoke the enclave — pin the Tauri signer's
//                    key here before anything but staging.
export const configSchema = z.object({
	aiProviderUrl: z.string(),
	aiProviderSecretId: z.string(),
	hmacSecretId: z.string(),
	scoreThreshold: z.number(),
	aiModel: z.string().default('claude-opus-5'),
	authorizedKeys: z
		.array(
			z.object({
				type: z.enum(['KEY_TYPE_UNSPECIFIED', 'KEY_TYPE_ECDSA_EVM']),
				publicKey: z.string(),
			}),
		)
		.default([]),
})
type Config = z.infer<typeof configSchema>

// ─── Escrow payload (POSTed by the Tauri backend after Stage 4) ─────────────
// Asset classes mirror `src/lib/assetClasses.ts` in the main repo — seven, not
// six, and `natural_resources` is plural. Release paths mirror the
// `ExecutionPath` enum in `src/lexguard/types.ts`.
const ASSET_CLASSES = [
	'legal',
	'real_estate',
	'business',
	'ip',
	'art',
	'natural_resources',
	'cannabis_ind',
] as const

const RELEASE_PATHS = ['DirectSettlement', 'ArbitrationEscrow', 'StagedRelease'] as const

const escrowPayloadSchema = z.object({
	session_id: z.string().min(1),
	asset_class: z.enum(ASSET_CLASSES),
	// Integer cents only — a float here is a rejected payload, not a rounding
	// problem to paper over downstream.
	total_held_cents: z.number().int().nonnegative(),
	release_path: z.enum(RELEASE_PATHS),
	document_text: z.string().min(1),
	trust_anchors: z.object({
		parties: z.array(z.string()),
		identifiers: z.array(z.string()),
	}),
})
type EscrowPayload = z.infer<typeof escrowPayloadSchema>

// ─── AI extraction shape ────────────────────────────────────
// The enclave asks the provider for exactly this shape via
// `output_config.format`, so the response is schema-valid JSON rather than
// prose we have to scrape. `reason` is always present; empty string means the
// anomaly carries no suppression reason (structured outputs require every
// property, so there are no optional fields to model).
const aiExtractionSchema = z.object({
	parties: z.array(z.string()),
	identifiers: z.array(z.string()),
	amounts: z.object({
		total_held_cents: z.number(),
		earned_fees_cents: z.number(),
		unearned_balance_cents: z.number(),
		disputed_amount_cents: z.number(),
	}),
	conditions: z.array(z.string()),
	anomalies: z.array(
		z.object({
			description: z.string(),
			suppressed: z.boolean(),
			reason: z.string(),
		}),
	),
	recommended_release_path: z.enum(RELEASE_PATHS),
})
export type AiExtraction = z.infer<typeof aiExtractionSchema>

const AI_EXTRACTION_JSON_SCHEMA = {
	type: 'object',
	properties: {
		parties: { type: 'array', items: { type: 'string' } },
		identifiers: { type: 'array', items: { type: 'string' } },
		amounts: {
			type: 'object',
			properties: {
				total_held_cents: { type: 'integer' },
				earned_fees_cents: { type: 'integer' },
				unearned_balance_cents: { type: 'integer' },
				disputed_amount_cents: { type: 'integer' },
			},
			required: [
				'total_held_cents',
				'earned_fees_cents',
				'unearned_balance_cents',
				'disputed_amount_cents',
			],
			additionalProperties: false,
		},
		conditions: { type: 'array', items: { type: 'string' } },
		anomalies: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					description: { type: 'string' },
					suppressed: { type: 'boolean' },
					reason: { type: 'string' },
				},
				required: ['description', 'suppressed', 'reason'],
				additionalProperties: false,
			},
		},
		recommended_release_path: { type: 'string', enum: [...RELEASE_PATHS] },
	},
	required: [
		'parties',
		'identifiers',
		'amounts',
		'conditions',
		'anomalies',
		'recommended_release_path',
	],
	additionalProperties: false,
} as const

// Minimal by design: this is a confidential *re-validation* pass, not the full
// AI parse system prompt the Tauri app runs at Stage 3.
const EXTRACTION_SYSTEM_PROMPT = [
	'You re-extract an escrow document inside a confidential enclave.',
	'Report every monetary value as integer cents — never dollars, never a decimal.',
	'`earned_fees_cents` + `unearned_balance_cents` must equal `total_held_cents`.',
	'List every party and every identifier (bar numbers, account references) exactly as written.',
	'Record each anomaly you observe. Set `suppressed` only when the document itself waives the',
	'anomaly, and then state the document’s justification in `reason`. Leave `reason` empty ("")',
	'for anomalies that are not suppressed.',
	'Report what the document says. Do not resolve discrepancies in its favour.',
].join(' ')

// ─── Deterministic LexGuard validation (runs entirely inside the enclave) ────
// Each check mirrors the corresponding stage of the LexGuard pipeline in the
// main repo, reduced to what can be decided from the parse alone.

export type ArithmeticResult = { valid: boolean; detail: string }

/**
 * Integer-only reconciliation of the parsed amounts, and of the parsed total
 * against the figure the human authorized at Stage 4. Any float, negative, or
 * unsafe value fails outright — the enclave never rounds.
 */
export const validateArithmetic = (
	parsed: AiExtraction,
	authorizedTotalCents: number,
): ArithmeticResult => {
	const { amounts } = parsed
	const fields: Array<[string, number]> = [
		['total_held_cents', amounts.total_held_cents],
		['earned_fees_cents', amounts.earned_fees_cents],
		['unearned_balance_cents', amounts.unearned_balance_cents],
		['disputed_amount_cents', amounts.disputed_amount_cents],
	]

	for (const [name, value] of fields) {
		if (!Number.isSafeInteger(value)) {
			return { valid: false, detail: `${name} is not a safe integer cent value` }
		}
		if (value < 0) {
			return { valid: false, detail: `${name} is negative` }
		}
	}

	const summed = amounts.earned_fees_cents + amounts.unearned_balance_cents
	if (summed !== amounts.total_held_cents) {
		return {
			valid: false,
			detail: `earned + unearned (${summed}) does not equal total_held_cents (${amounts.total_held_cents})`,
		}
	}

	if (amounts.total_held_cents !== authorizedTotalCents) {
		return {
			valid: false,
			detail: `parsed total (${amounts.total_held_cents}) does not equal the authorized total (${authorizedTotalCents})`,
		}
	}

	if (amounts.disputed_amount_cents > amounts.total_held_cents) {
		return { valid: false, detail: 'disputed_amount_cents exceeds total_held_cents' }
	}

	return { valid: true, detail: 'arithmetic reconciles against the authorized total' }
}

/** Lowercase, collapse whitespace runs, trim — same normalization as the app's AnchorMatcher. */
const normalizeAnchor = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim()

export type AnchorResult = { valid: boolean; mismatches: string[] }

/**
 * Every party the AI names must appear in the trust anchors collected at
 * Document Load, and every identifier it names must appear in the anchor
 * identifiers. An extraction that names nobody is a mismatch too — a parse with
 * no parties cannot have been anchored.
 */
export const validateAnchors = (
	parsed: AiExtraction,
	trustAnchors: EscrowPayload['trust_anchors'],
): AnchorResult => {
	const anchoredParties = new Set(trustAnchors.parties.map(normalizeAnchor))
	const anchoredIdentifiers = new Set(trustAnchors.identifiers.map(normalizeAnchor))
	const mismatches: string[] = []

	if (parsed.parties.length === 0) {
		mismatches.push('<no parties extracted>')
	}

	for (const party of parsed.parties) {
		if (!anchoredParties.has(normalizeAnchor(party))) {
			mismatches.push(party)
		}
	}

	for (const identifier of parsed.identifiers) {
		if (!anchoredIdentifiers.has(normalizeAnchor(identifier))) {
			mismatches.push(identifier)
		}
	}

	return { valid: mismatches.length === 0, mismatches }
}

export type AnomalyResult = { valid: boolean; suppressedCount: number }

/**
 * Anomaly suppression without a stated reason is the failure mode this check
 * exists for: a flagged anomaly silently waived is how a bad settlement reaches
 * a human who thinks nothing was flagged.
 */
export const validateAnomalies = (parsed: AiExtraction): AnomalyResult => {
	const suppressed = parsed.anomalies.filter((anomaly) => anomaly.suppressed)
	const unjustified = suppressed.filter((anomaly) => anomaly.reason.trim().length === 0)

	return { valid: unjustified.length === 0, suppressedCount: suppressed.length }
}

// ─── Canonical JSON + HMAC seal ─────────────────────────────

/**
 * Deterministic JSON: object keys sorted, no incidental whitespace. The seal is
 * only verifiable off-enclave if the byte sequence it covers is reproducible,
 * and `JSON.stringify` alone preserves insertion order.
 */
export const canonicalJson = (value: unknown): string => {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value)
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(',')}]`
	}
	const entries = Object.keys(value as Record<string, unknown>)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
	return `{${entries.join(',')}}`
}

/**
 * Real HMAC-SHA256 (RFC 2104), not the keyed-hash fallback.
 *
 * `node:crypto` is unavailable in the CRE WASM runtime (every export is typed
 * `never` — see the SDK's restricted-node-modules declarations) and the SDK
 * exposes no HMAC of its own, but viem — already a dependency for
 * `encodeAbiParameters` — ships a pure-JS `sha256`. HMAC is a construction over
 * a hash, so building it here gives the real primitive rather than
 * `SHA256(key + ':' + message)`, which is length-extendable and not an HMAC.
 */
export const hmacSha256 = (key: string, message: string): Hex => {
	const BLOCK_SIZE = 64
	const encoder = new TextEncoder()

	// Widened to `Uint8Array` so viem's `ByteArray` reassignment below typechecks
	// under both the workflow tsconfig (`types: []`) and a DOM/node lib.
	let keyBytes: Uint8Array = encoder.encode(key)
	if (keyBytes.length > BLOCK_SIZE) {
		keyBytes = sha256(keyBytes, 'bytes')
	}

	const paddedKey = new Uint8Array(BLOCK_SIZE)
	paddedKey.set(keyBytes)

	const innerPad = new Uint8Array(BLOCK_SIZE)
	const outerPad = new Uint8Array(BLOCK_SIZE)
	for (let i = 0; i < BLOCK_SIZE; i++) {
		innerPad[i] = paddedKey[i] ^ 0x36
		outerPad[i] = paddedKey[i] ^ 0x5c
	}

	const messageBytes = encoder.encode(message)
	const innerInput = new Uint8Array(BLOCK_SIZE + messageBytes.length)
	innerInput.set(innerPad)
	innerInput.set(messageBytes, BLOCK_SIZE)
	const innerHash = sha256(innerInput, 'bytes')

	const outerInput = new Uint8Array(BLOCK_SIZE + innerHash.length)
	outerInput.set(outerPad)
	outerInput.set(innerHash, BLOCK_SIZE)

	return sha256(outerInput, 'hex')
}

// ─── Provider request helpers ───────────────────────────────

/**
 * Anthropic authenticates with `x-api-key` and requires `anthropic-version`; it
 * does not accept a plain API key on `Authorization: Bearer` (the main repo's
 * `src-tauri/src/ai.rs` carries the same note). OpenAI-compatible endpoints use
 * `Authorization: Bearer`, so the header set follows the configured host.
 */
const authHeaders = (url: string, apiKey: string): Record<string, { values: string[] }> => {
	const isAnthropic = url.includes('api.anthropic.com')
	return isAnthropic
		? {
				'content-type': { values: ['application/json'] },
				'x-api-key': { values: [apiKey] },
				'anthropic-version': { values: ['2023-06-01'] },
			}
		: {
				'content-type': { values: ['application/json'] },
				Authorization: { values: [`Bearer ${apiKey}`] },
			}
}

/** Pull the first text block out of an Anthropic Messages response. */
const extractResponseText = (body: string): string => {
	let envelope: unknown
	try {
		envelope = JSON.parse(body)
	} catch {
		throw new Error('LexEscrow enclave: AI provider returned a non-JSON response')
	}

	const message = envelope as {
		stop_reason?: string
		content?: Array<{ type?: string; text?: string }>
	}

	if (message.stop_reason === 'refusal') {
		throw new Error('LexEscrow enclave: AI provider declined the extraction request')
	}
	if (message.stop_reason === 'max_tokens') {
		throw new Error('LexEscrow enclave: AI extraction was truncated at max_tokens')
	}

	const block = (message.content ?? []).find((entry) => entry.type === 'text' && entry.text)
	if (!block?.text) {
		throw new Error('LexEscrow enclave: AI response carried no text block')
	}
	return block.text
}

/**
 * Render a zod failure as paths + constraint codes. Field values never appear.
 *
 * `invalid_enum_value` is the one code whose default message quotes the value it
 * rejected ("Invalid enum value. Expected 'legal' | … , received 'x'"). These
 * strings go into thrown errors, and a throw leaves the enclave — so letting
 * that message through would carry caller input across the confidentiality
 * boundary into execution logs. It reports its bare code instead, on the same
 * principle as the AI-provider failure below, which reports a status code and
 * never the response body. Every other code's message describes a constraint
 * rather than a value, so it passes through unchanged.
 */
const describeIssues = (error: z.ZodError): string =>
	error.issues
		.map((issue) => {
			const path = issue.path.join('.') || '<root>'
			return issue.code === z.ZodIssueCode.invalid_enum_value
				? `${path}: ${issue.code}`
				: `${path}: ${issue.message}`
		})
		.join('; ')

// ─── TEE HTTP Callback ──────────────────────────────────────
// Receives a `TeeRuntime`, not a `Runtime`. Everything here runs inside the
// enclave until we explicitly cross back with `usingTheDons()`.
//
// The enclave is architecturally incapable of settling: it produces a sealed
// verdict, and nothing more. The on-chain write stays behind Stage 5 human
// authorization in the Tauri app.
export const onHttpTrigger = (runtime: TeeRuntime<Config>, payload: HTTPPayload): string => {
	const config = runtime.config

	// ── Step 1: Fetch both secrets inside the enclave ──
	// The Vault DON releases these only into an attested enclave; they are
	// decrypted at the moment `getSecret()` runs and never reach node operators.
	const aiKey = runtime.getSecret({ id: config.aiProviderSecretId }).result().value
	const hmacKey = runtime.getSecret({ id: config.hmacSecretId }).result().value

	// ── Step 2: Decode and validate the escrow payload ──
	// The HTTP trigger delivers its body as the handler's second argument
	// (`payload.input`, raw JSON bytes) — there is no `runtime.trigger`.
	if (!payload?.input || payload.input.length === 0) {
		throw new Error('LexEscrow enclave: HTTP trigger payload was empty')
	}

	let rawBody: unknown
	try {
		rawBody = JSON.parse(new TextDecoder().decode(payload.input))
	} catch {
		throw new Error('LexEscrow enclave: HTTP trigger payload was not valid JSON')
	}

	const parsedPayload = escrowPayloadSchema.safeParse(rawBody)
	if (!parsedPayload.success) {
		throw new Error(
			`LexEscrow enclave: invalid escrow payload — ${describeIssues(parsedPayload.error)}`,
		)
	}
	const escrow = parsedPayload.data

	// ── Step 3: Call the AI provider from inside the enclave ──
	// `HTTPClient.sendRequest()` has a `TeeRuntime` overload, so the request and
	// response payloads — the document text and the extraction — stay
	// confidential from node operators. Do NOT reach for
	// `ConfidentialHTTPClient`: it has no `TeeRuntime` overload.
	const requestBody = JSON.stringify({
		model: config.aiModel,
		// Bounded by the extraction schema; kept small because the enclave's HTTP
		// response buffer is finite.
		max_tokens: 4096,
		system: EXTRACTION_SYSTEM_PROMPT,
		messages: [
			{
				role: 'user',
				content: `Extract the escrow terms from the document below.\n\n${escrow.document_text}`,
			},
		],
		// Schema-constrained output: the response is valid JSON of this shape, so
		// the enclave validates a parse rather than scraping prose.
		output_config: {
			effort: 'medium',
			format: { type: 'json_schema', schema: AI_EXTRACTION_JSON_SCHEMA },
		},
	})

	const response = new cre.capabilities.HTTPClient()
		.sendRequest(runtime, {
			url: config.aiProviderUrl,
			method: 'POST',
			multiHeaders: authHeaders(config.aiProviderUrl, aiKey),
			// Protobuf `bytes` fields take base64 in their JSON form.
			body: bytesToBase64(new TextEncoder().encode(requestBody)),
			// Note: production limits set `HTTPAction.ConnectionTimeout` to 10s
			// (`cre workflow limits export`). If that ceiling turns out to cap the
			// whole request rather than connection setup, an extraction over a long
			// document will not fit and this value is unenforceable.
			timeout: '120s',
		})
		.result()

	if (!ok(response)) {
		// Status only — the error body may echo request content back.
		throw new Error(`LexEscrow enclave: AI provider returned status ${response.statusCode}`)
	}

	const extraction = aiExtractionSchema.safeParse(JSON.parse(extractResponseText(text(response))))
	if (!extraction.success) {
		throw new Error(
			`LexEscrow enclave: AI extraction did not match the expected shape — ${describeIssues(extraction.error)}`,
		)
	}
	const parsed = extraction.data

	// ── Step 4: LexGuard-style deterministic validation ──
	const arithmetic = validateArithmetic(parsed, escrow.total_held_cents)
	const anchors = validateAnchors(parsed, escrow.trust_anchors)
	const anomalies = validateAnomalies(parsed)

	let lexguardScore = 1000
	if (!arithmetic.valid) lexguardScore -= 200
	if (!anchors.valid) lexguardScore -= 200
	if (!anomalies.valid) lexguardScore -= 200

	const validated = lexguardScore >= config.scoreThreshold
	const enclaveTimestamp = runtime.now().toISOString()

	// ── Step 5: Seal the verdict inside the enclave ──
	// Canonical (sorted-key) JSON over exactly the fields that cross the
	// boundary, so the Tauri app can recompute the seal from the DON report
	// alone and confirm nothing was altered in transit.
	const sealInput = canonicalJson({
		session_id: escrow.session_id,
		asset_class: escrow.asset_class,
		total_held_cents: escrow.total_held_cents,
		release_path: escrow.release_path,
		validated,
		lexguardScore,
		timestamp: enclaveTimestamp,
	})
	const hmacSeal = hmacSha256(hmacKey, sealInput)

	// ── Step 6: Cross back to the DON for consensus ──
	// `usingTheDons()` returns a regular `Runtime`. Everything passed into a
	// capability call on it executes on Workflow DON nodes and is NO LONGER
	// confidential — so only the sealed verdict crosses. No document text, no
	// AI key, no intermediate parse state, no trust-anchor PII.
	const donRuntime = runtime.usingTheDons()

	const encodedPayload = encodeAbiParameters(
		parseAbiParameters(
			'string sessionId, string assetClass, uint256 totalHeldCents, string releasePath, bool validated, uint256 lexguardScore, bytes32 hmacSeal, string enclaveTimestamp',
		),
		[
			escrow.session_id,
			escrow.asset_class,
			BigInt(escrow.total_held_cents),
			escrow.release_path,
			validated,
			BigInt(lexguardScore),
			hmacSeal,
			enclaveTimestamp,
		],
	)

	donRuntime
		.report({
			encodedPayload: hexToBase64(encodedPayload),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		.result()

	// The signed report is now a normal CRE report. Stage 5 hands it to
	// `evmClient.writeReport(donRuntime, report)` against RetainerRelease only
	// after a human authorizes the settlement.
	return `${validated ? 'APPROVED' : 'REJECTED'} (lexguardScore: ${lexguardScore})`
}

// ─── Workflow Init ──────────────────────────────────────────
export function initWorkflow(config: Config) {
	const httpTrigger = new cre.capabilities.HTTPCapability()

	return [
		// ── Register a TEE handler ──
		// `cre.handlerInTee` instead of `cre.handler`. The third argument is a
		// `TeeConstraint` describing which enclaves this handler will accept.
		// AWS Nitro in us-west-2 is currently the only registered TEE type and
		// region.
		cre.handlerInTee(
			httpTrigger.trigger({ authorizedKeys: config.authorizedKeys }),
			onHttpTrigger,
			[{ tee: 'nitro', regions: ['us-west-2'] }],
		),
	]
}
