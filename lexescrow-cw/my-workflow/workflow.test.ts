import { describe, expect } from 'bun:test'
import type { HTTPPayload, TeeRuntime } from '@chainlink/cre-sdk'
import { test } from '@chainlink/cre-sdk/test'
import {
	type AiExtraction,
	canonicalJson,
	hmacSha256,
	initWorkflow,
	onHttpTrigger,
	validateAnchors,
	validateAnomalies,
	validateArithmetic,
} from './workflow'

const AI_KEY = 'test-ai-provider-key'
const HMAC_KEY = 'test-hmac-vault-key'
const DOCUMENT_TEXT = 'CONFIDENTIAL RETAINER — Ridgeline LLP holds $12,500.00 for Dana Okonkwo.'

const makeConfig = () => ({
	aiProviderUrl: 'https://api.anthropic.com/v1/messages',
	aiProviderSecretId: 'AI_PROVIDER_KEY',
	hmacSecretId: 'HMAC_VAULT_KEY',
	scoreThreshold: 600,
	aiModel: 'claude-opus-5',
	authorizedKeys: [] as Array<{ type: 'KEY_TYPE_ECDSA_EVM'; publicKey: string }>,
})

type Config = ReturnType<typeof makeConfig>

/** A well-formed escrow payload: totals reconcile, parties are anchored, no anomalies. */
const makeEscrowPayload = (overrides: Record<string, unknown> = {}) => ({
	session_id: 'sess-0001',
	asset_class: 'legal',
	total_held_cents: 1_250_000,
	release_path: 'DirectSettlement',
	document_text: DOCUMENT_TEXT,
	trust_anchors: {
		parties: ['Ridgeline LLP', 'Dana Okonkwo'],
		identifiers: ['CA-284417'],
	},
	...overrides,
})

/** The extraction the enclave expects back from the provider. */
const makeExtraction = (overrides: Partial<AiExtraction> = {}): AiExtraction => ({
	parties: ['Ridgeline LLP', 'Dana Okonkwo'],
	identifiers: ['CA-284417'],
	amounts: {
		total_held_cents: 1_250_000,
		earned_fees_cents: 400_000,
		unearned_balance_cents: 850_000,
		disputed_amount_cents: 0,
	},
	conditions: ['Unearned balance returns to the client on termination.'],
	anomalies: [],
	recommended_release_path: 'DirectSettlement',
	...overrides,
})

/** Wrap an extraction in the Anthropic Messages response envelope. */
const asMessagesResponse = (extraction: AiExtraction | string) =>
	JSON.stringify({
		id: 'msg_test',
		type: 'message',
		role: 'assistant',
		stop_reason: 'end_turn',
		content: [
			{
				type: 'text',
				text: typeof extraction === 'string' ? extraction : JSON.stringify(extraction),
			},
		],
	})

const encodeTriggerPayload = (body: unknown): HTTPPayload =>
	({ input: new TextEncoder().encode(JSON.stringify(body)) }) as unknown as HTTPPayload

// The public test surface does not yet ship a TEE runtime factory
// (`newTestRuntime` returns a DON `Runtime`), so we stand up the small slice of
// `TeeRuntime` the handler actually uses: config, getSecret, callCapability
// (which HTTPClient.sendRequest goes through), now, log, and usingTheDons.
type FakeTeeRuntimeOptions = {
	statusCode?: number
	responseBody?: string
	config?: Partial<Config>
}

const makeFakeTeeRuntime = ({
	statusCode = 200,
	responseBody = asMessagesResponse(makeExtraction()),
	config = {},
}: FakeTeeRuntimeOptions = {}) => {
	const requests: Array<{ url: string; method: string; headers: string[]; body: string }> = []
	const reports: unknown[] = []
	const logs: string[] = []

	const runtime = {
		config: { ...makeConfig(), ...config },
		getSecret: (request: { id?: string }) => ({
			result: () => ({
				id: request.id,
				value: request.id === 'HMAC_VAULT_KEY' ? HMAC_KEY : AI_KEY,
			}),
		}),
		callCapability: ({
			payload,
		}: {
			payload: {
				url: string
				method: string
				body: Uint8Array
				multiHeaders?: Record<string, { values?: string[] }>
			}
		}) => {
			const headers = Object.entries(payload.multiHeaders ?? {}).map(
				([name, value]) => `${name}: ${(value.values ?? []).join(',')}`,
			)
			requests.push({
				url: payload.url,
				method: payload.method,
				headers,
				body: new TextDecoder().decode(payload.body),
			})
			return {
				result: () => ({
					statusCode,
					body: new TextEncoder().encode(responseBody),
				}),
			}
		},
		now: () => new Date('2026-09-01T00:00:00.000Z'),
		log: (message: string) => logs.push(message),
		usingTheDons: () => ({
			report: (input: unknown) => {
				reports.push(input)
				return { result: () => ({}) }
			},
		}),
	}

	return {
		runtime: runtime as unknown as TeeRuntime<Config>,
		requests,
		reports,
		logs,
	}
}

describe('onHttpTrigger', () => {
	test('APPROVEs a clean payload with a full lexguardScore', () => {
		const { runtime } = makeFakeTeeRuntime()

		expect(onHttpTrigger(runtime, encodeTriggerPayload(makeEscrowPayload()))).toBe(
			'APPROVED (lexguardScore: 1000)',
		)
	})

	test('reduces the score when the parsed amounts do not reconcile', () => {
		// earned + unearned = 1_249_999, one cent short of the total.
		const { runtime } = makeFakeTeeRuntime({
			responseBody: asMessagesResponse(
				makeExtraction({
					amounts: {
						total_held_cents: 1_250_000,
						earned_fees_cents: 400_000,
						unearned_balance_cents: 849_999,
						disputed_amount_cents: 0,
					},
				}),
			),
		})

		expect(onHttpTrigger(runtime, encodeTriggerPayload(makeEscrowPayload()))).toBe(
			'APPROVED (lexguardScore: 800)',
		)
	})

	test('REJECTs when the parsed total contradicts the authorized total', () => {
		// Arithmetic and anchors both fail: 1000 - 200 - 200 = 600 clears the
		// threshold, so drop the threshold to prove the REJECT path too.
		const { runtime } = makeFakeTeeRuntime({
			config: { scoreThreshold: 1000 },
			responseBody: asMessagesResponse(
				makeExtraction({
					amounts: {
						total_held_cents: 9_900_000,
						earned_fees_cents: 4_000_000,
						unearned_balance_cents: 5_900_000,
						disputed_amount_cents: 0,
					},
				}),
			),
		})

		expect(onHttpTrigger(runtime, encodeTriggerPayload(makeEscrowPayload()))).toBe(
			'REJECTED (lexguardScore: 800)',
		)
	})

	test('reduces the score when a parsed party is not in the trust anchors', () => {
		const { runtime } = makeFakeTeeRuntime({
			responseBody: asMessagesResponse(
				makeExtraction({ parties: ['Ridgeline LLP', 'Someone Else Entirely'] }),
			),
		})

		expect(onHttpTrigger(runtime, encodeTriggerPayload(makeEscrowPayload()))).toBe(
			'APPROVED (lexguardScore: 800)',
		)
	})

	test('reduces the score when an anomaly is suppressed without a reason', () => {
		const { runtime } = makeFakeTeeRuntime({
			responseBody: asMessagesResponse(
				makeExtraction({
					anomalies: [
						{ description: 'Fee schedule contradicts the trust ledger', suppressed: true, reason: '' },
					],
				}),
			),
		})

		expect(onHttpTrigger(runtime, encodeTriggerPayload(makeEscrowPayload()))).toBe(
			'APPROVED (lexguardScore: 800)',
		)
	})

	test('keeps the full score when a suppressed anomaly carries its reason', () => {
		const { runtime } = makeFakeTeeRuntime({
			responseBody: asMessagesResponse(
				makeExtraction({
					anomalies: [
						{
							description: 'Fee schedule contradicts the trust ledger',
							suppressed: true,
							reason: 'Amendment 2 supersedes the original fee schedule.',
						},
					],
				}),
			),
		})

		expect(onHttpTrigger(runtime, encodeTriggerPayload(makeEscrowPayload()))).toBe(
			'APPROVED (lexguardScore: 1000)',
		)
	})

	test('throws a descriptive error when a required payload field is missing', () => {
		const { runtime, reports } = makeFakeTeeRuntime()
		const payload = makeEscrowPayload()
		delete (payload as Record<string, unknown>).total_held_cents

		expect(() => onHttpTrigger(runtime, encodeTriggerPayload(payload))).toThrow(
			/invalid escrow payload.*total_held_cents/,
		)
		expect(reports).toHaveLength(0)
	})

	test('throws when total_held_cents is a float rather than integer cents', () => {
		const { runtime } = makeFakeTeeRuntime()

		expect(() =>
			onHttpTrigger(runtime, encodeTriggerPayload(makeEscrowPayload({ total_held_cents: 1250.5 }))),
		).toThrow(/invalid escrow payload.*total_held_cents/)
	})

	test('throws on an asset class the platform does not define', () => {
		const { runtime } = makeFakeTeeRuntime()

		expect(() =>
			onHttpTrigger(
				runtime,
				encodeTriggerPayload(makeEscrowPayload({ asset_class: 'crypto_derivative' })),
			),
		).toThrow(/invalid escrow payload.*asset_class/)
	})

	test('throws on an empty trigger payload', () => {
		const { runtime } = makeFakeTeeRuntime()

		expect(() => onHttpTrigger(runtime, { input: new Uint8Array() } as unknown as HTTPPayload)).toThrow(
			'HTTP trigger payload was empty',
		)
	})

	test('sends the document to the configured provider with Anthropic auth headers', () => {
		const { runtime, requests } = makeFakeTeeRuntime()

		onHttpTrigger(runtime, encodeTriggerPayload(makeEscrowPayload()))

		expect(requests).toHaveLength(1)
		expect(requests[0].url).toBe('https://api.anthropic.com/v1/messages')
		expect(requests[0].method).toBe('POST')
		expect(requests[0].headers).toContain(`x-api-key: ${AI_KEY}`)
		expect(requests[0].headers).toContain('anthropic-version: 2023-06-01')
		expect(requests[0].body).toContain(DOCUMENT_TEXT)
		expect(requests[0].body).toContain('"model":"claude-opus-5"')
	})

	test('uses bearer auth for an OpenAI-compatible endpoint', () => {
		const { runtime, requests } = makeFakeTeeRuntime({
			config: { aiProviderUrl: 'https://gateway.internal/v1/messages' },
		})

		onHttpTrigger(runtime, encodeTriggerPayload(makeEscrowPayload()))

		expect(requests[0].headers).toContain(`Authorization: Bearer ${AI_KEY}`)
	})

	test('crosses back to the DON to generate a report', () => {
		const { runtime, reports } = makeFakeTeeRuntime()

		onHttpTrigger(runtime, encodeTriggerPayload(makeEscrowPayload()))

		expect(reports).toHaveLength(1)
		expect(reports[0]).toMatchObject({
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
	})

	test('throws on a non-2xx provider response and never reaches the DON', () => {
		const { runtime, reports } = makeFakeTeeRuntime({ statusCode: 401 })

		expect(() => onHttpTrigger(runtime, encodeTriggerPayload(makeEscrowPayload()))).toThrow(
			'status 401',
		)
		expect(reports).toHaveLength(0)
	})

	test('throws when the provider declines the extraction', () => {
		const { runtime } = makeFakeTeeRuntime({
			responseBody: JSON.stringify({ stop_reason: 'refusal', content: [] }),
		})

		expect(() => onHttpTrigger(runtime, encodeTriggerPayload(makeEscrowPayload()))).toThrow(
			'declined the extraction request',
		)
	})

	test('throws when the extraction does not match the expected shape', () => {
		const { runtime } = makeFakeTeeRuntime({
			responseBody: asMessagesResponse('{"parties":["Ridgeline LLP"]}'),
		})

		expect(() => onHttpTrigger(runtime, encodeTriggerPayload(makeEscrowPayload()))).toThrow(
			/AI extraction did not match the expected shape/,
		)
	})

	test('logs exactly once, and leaks neither a secret nor the document', () => {
		const { runtime, logs } = makeFakeTeeRuntime()

		onHttpTrigger(runtime, encodeTriggerPayload(makeEscrowPayload()))

		expect(logs).toEqual(['LexEscrow enclave validation complete'])
		for (const line of logs) {
			expect(line).not.toContain(AI_KEY)
			expect(line).not.toContain(HMAC_KEY)
			expect(line).not.toContain(DOCUMENT_TEXT)
		}
	})

	test('the returned verdict carries no document text or party names', () => {
		const { runtime } = makeFakeTeeRuntime()

		const verdict = onHttpTrigger(runtime, encodeTriggerPayload(makeEscrowPayload()))

		expect(verdict).not.toContain(DOCUMENT_TEXT)
		expect(verdict).not.toContain('Dana Okonkwo')
		expect(verdict).not.toContain(HMAC_KEY)
	})
})

describe('validateArithmetic', () => {
	test('accepts amounts that reconcile against the authorized total', () => {
		expect(validateArithmetic(makeExtraction(), 1_250_000).valid).toBe(true)
	})

	test('rejects a non-integer cent value without rounding it', () => {
		const result = validateArithmetic(
			makeExtraction({
				amounts: {
					total_held_cents: 1_250_000.5,
					earned_fees_cents: 400_000,
					unearned_balance_cents: 850_000.5,
					disputed_amount_cents: 0,
				},
			}),
			1_250_000,
		)

		expect(result.valid).toBe(false)
		expect(result.detail).toContain('total_held_cents')
	})

	test('rejects a disputed amount larger than the total held', () => {
		const result = validateArithmetic(
			makeExtraction({
				amounts: {
					total_held_cents: 1_250_000,
					earned_fees_cents: 400_000,
					unearned_balance_cents: 850_000,
					disputed_amount_cents: 2_000_000,
				},
			}),
			1_250_000,
		)

		expect(result.valid).toBe(false)
	})
})

describe('validateAnchors', () => {
	const anchors = { parties: ['Ridgeline  LLP', 'Dana Okonkwo'], identifiers: ['CA-284417'] }

	test('matches case-insensitively and collapses whitespace', () => {
		const result = validateAnchors(
			makeExtraction({ parties: ['  ridgeline llp ', 'DANA OKONKWO'] }),
			anchors,
		)

		expect(result).toEqual({ valid: true, mismatches: [] })
	})

	test('reports an unanchored identifier', () => {
		const result = validateAnchors(makeExtraction({ identifiers: ['CA-000000'] }), anchors)

		expect(result.valid).toBe(false)
		expect(result.mismatches).toContain('CA-000000')
	})

	test('treats an extraction with no parties as unanchored', () => {
		const result = validateAnchors(makeExtraction({ parties: [] }), anchors)

		expect(result.valid).toBe(false)
	})
})

describe('validateAnomalies', () => {
	test('counts suppressed anomalies and passes when each states a reason', () => {
		const result = validateAnomalies(
			makeExtraction({
				anomalies: [
					{ description: 'a', suppressed: true, reason: 'superseded by amendment 2' },
					{ description: 'b', suppressed: false, reason: '' },
				],
			}),
		)

		expect(result).toEqual({ valid: true, suppressedCount: 1 })
	})

	test('fails when a suppressed anomaly carries only whitespace as its reason', () => {
		const result = validateAnomalies(
			makeExtraction({ anomalies: [{ description: 'a', suppressed: true, reason: '   ' }] }),
		)

		expect(result).toEqual({ valid: false, suppressedCount: 1 })
	})
})

describe('canonicalJson', () => {
	test('orders keys so the seal covers a reproducible byte sequence', () => {
		expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
			'{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
		)
	})
})

describe('hmacSha256', () => {
	// RFC 4231 test vectors — proof this is real HMAC-SHA256, not SHA256(key + message).
	test('matches RFC 4231 test case 1', () => {
		expect(hmacSha256('\x0b'.repeat(20), 'Hi There')).toBe(
			'0xb0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
		)
	})

	test('matches RFC 4231 test case 2', () => {
		expect(hmacSha256('Jefe', 'what do ya want for nothing?')).toBe(
			'0x5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
		)
	})

	test('is key-dependent', () => {
		expect(hmacSha256('key-a', 'payload')).not.toBe(hmacSha256('key-b', 'payload'))
	})
})

describe('initWorkflow', () => {
	test('registers the HTTP handler with a Nitro TEE constraint', () => {
		const handlers = initWorkflow(makeConfig())

		expect(handlers).toHaveLength(1)
		expect(handlers[0].fn).toBe(onHttpTrigger)

		// handlerInTee attaches TEE requirements; cre.handler does not.
		expect(handlers[0].requirements).toBeDefined()
	})
})
