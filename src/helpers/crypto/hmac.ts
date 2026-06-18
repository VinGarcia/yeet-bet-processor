import { createHmac, timingSafeEqual } from 'node:crypto'

// HMAC-SHA256 signing over the RAW body bytes (never re-serialized JSON), so
// whitespace-sensitive payloads verify against exactly what was sent.

/** Lowercase hex HMAC-SHA256 of `rawBody` keyed by `secret`. */
export function sign(secret: string, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

export interface SignedRequest {
  /** The raw JSON string that is both signed and POSTed. */
  raw: string
  init: { method: 'POST'; headers: Record<string, string>; body: string }
}

/**
 * Serializes `body` once and signs those EXACT bytes. Single source of truth for
 * how this codebase frames a signed request (header name, algo label, content-type).
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

/** Constant-time signature check; a malformed/wrong-length hex yields false, never throws. */
export function verify(secret: string, rawBody: Buffer, providedHex: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  const provided = Buffer.from(providedHex, 'hex')
  // Buffer.from(hex) drops invalid/odd nibbles, so a length mismatch cheaply
  // rejects non-hex or truncated input before the compare.
  if (provided.length !== expected.length) {
    return false
  }
  return timingSafeEqual(expected, provided)
}
