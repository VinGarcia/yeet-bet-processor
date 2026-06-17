import { describe, expect, it } from 'vitest'
import { sign, verify } from './hmac.js'

// Known-answer vectors from the spec (secret = 'test'). The two raw bodies
// differ only by whitespace, which yields different signatures — proving we
// sign the raw bytes, not re-serialized JSON.
const SECRET = 'test'
const BODY_WITH_SPACES = '{"user_id": "8|USDT|USD","currency": "USD","game": "acceptance:test"}'
const BODY_NO_SPACES = '{"user_id":"8|USDT|USD","currency":"USD","game":"acceptance:test"}'
const HEX_WITH_SPACES = '7376e78d5f65ca750c9719d2163daffa129e8a07ba9a1abe12241b3b1de51295'
const HEX_NO_SPACES = '442c4cd8926008096225416b21f5a1862fbf4fc4e5224362e3b463e85a39f40a'

describe('sign', () => {
  it('matches the known-answer vector for the spaced body', () => {
    expect(sign(SECRET, BODY_WITH_SPACES)).toBe(HEX_WITH_SPACES)
  })

  it('matches the known-answer vector for the compact body', () => {
    expect(sign(SECRET, BODY_NO_SPACES)).toBe(HEX_NO_SPACES)
  })
})

describe('verify', () => {
  it('returns true for a correct signature', () => {
    expect(verify(SECRET, Buffer.from(BODY_WITH_SPACES), HEX_WITH_SPACES)).toBe(true)
  })

  it('returns false for a tampered signature', () => {
    const tampered = HEX_WITH_SPACES.replace(/^7/, '8')
    expect(verify(SECRET, Buffer.from(BODY_WITH_SPACES), tampered)).toBe(false)
  })

  it('returns false (does not throw) for a malformed/short signature', () => {
    expect(() => verify(SECRET, Buffer.from(BODY_WITH_SPACES), 'nothex')).not.toThrow()
    expect(verify(SECRET, Buffer.from(BODY_WITH_SPACES), 'nothex')).toBe(false)
  })

  it('returns false for a well-formed hex of the wrong byte length', () => {
    // 60 hex chars → 30 bytes, valid hex but shorter than the 32-byte digest.
    const wrongLength = 'a'.repeat(60)
    expect(verify(SECRET, Buffer.from(BODY_WITH_SPACES), wrongLength)).toBe(false)
  })
})
