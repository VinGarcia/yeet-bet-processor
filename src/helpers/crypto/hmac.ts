import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * HMAC-SHA256 request signing helpers.
 *
 * Signatures are computed over the RAW request body bytes (never re-serialized
 * JSON) so that whitespace-sensitive payloads verify correctly.
 */

/** Returns the lowercase hex HMAC-SHA256 of `rawBody` keyed by `secret`. */
export function sign(secret: string, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

/** The exact bytes sent plus the `fetch` init that signs them. */
export interface SignedRequest {
  /** The raw JSON string that is both signed and POSTed. */
  raw: string
  /** `fetch` init: POST, JSON content-type, and the HMAC `authorization` header. */
  init: { method: 'POST'; headers: Record<string, string>; body: string }
}

/**
 * Serializes `body` once and builds a signed POST request for it: the signature
 * is computed over the EXACT raw bytes that are sent, so the server verifies
 * against the bytes as received — never a re-serialization. The single source of
 * truth for how this codebase frames a signed request (header name, algo label,
 * content-type); every caller (`SignedClient`, the benchmark) goes through here.
 */
export function signedJsonRequest(secret: string, body: unknown): SignedRequest {
  const raw = JSON.stringify(body)
  return {
    raw,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `HMAC-SHA256 ${sign(secret, raw)}`,
      },
      body: raw,
    },
  }
}

/**
 * Returns true iff `providedHex` is a valid signature for `rawBody`.
 *
 * The comparison is constant-time and never throws: a malformed or
 * wrong-length hex string yields `false` rather than an error.
 */
export function verify(secret: string, rawBody: Buffer, providedHex: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  const provided = Buffer.from(providedHex, 'hex')
  // `Buffer.from(..., 'hex')` silently drops invalid/odd nibbles, so a mismatch
  // in length cheaply rejects non-hex or truncated input before the compare.
  if (provided.length !== expected.length) {
    return false
  }
  return timingSafeEqual(expected, provided)
}
