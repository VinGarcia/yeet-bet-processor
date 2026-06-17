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
