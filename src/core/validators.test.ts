import { describe, it, expect } from 'vitest'
import { validateAction } from './validators.js'
import { BadRequestError } from './errors.js'
import type { Action } from './entities.js'

const VALID = '3b42f070-dab5-4d6c-8bc6-7241b68f00bd'
const VALID_2 = '7c8affbf-53fd-4fcc-b1ca-18118c5dd287'

describe('validateAction', () => {
  it('accepts a well-formed bet, win, and rollback', () => {
    const ok: Action[] = [
      { action: 'bet', actionId: VALID, amount: 100 },
      { action: 'win', actionId: VALID, amount: 250 },
      { action: 'rollback', actionId: VALID, originalActionId: VALID_2 },
    ]
    for (const action of ok) expect(() => validateAction(action)).not.toThrow()
  })

  it('accepts an upper-case UUID (case-insensitive)', () => {
    expect(() =>
      validateAction({ action: 'bet', actionId: VALID.toUpperCase(), amount: 1 }),
    ).not.toThrow()
  })

  // The 8-4-4-4-12 hex shape is the boundary the UUID regex defends; integration
  // tests only graze it with one bad string, so pin the shapes directly here.
  const badUuids: Array<[string, string]> = [
    ['not-a-uuid', 'free text'],
    ['', 'empty string'],
    ['3b42f070dab54d6c8bc67241b68f00bd', 'missing hyphens'],
    ['3b42f070-dab5-4d6c-8bc6-7241b68f00b', 'last segment too short (11)'],
    ['3b42f070-dab5-4d6c-8bc6-7241b68f00bdd', 'last segment too long (13)'],
    ['3b42f070-dab5-4d6c-8bc6-7241b68f00bg', 'non-hex char'],
    ['3b42f070_dab5_4d6c_8bc6_7241b68f00bd', 'underscores not hyphens'],
  ]
  it.each(badUuids)('rejects a malformed actionId (%s — %s)', (actionId) => {
    expect(() => validateAction({ action: 'bet', actionId, amount: 100 })).toThrow(BadRequestError)
  })

  it('rejects a rollback whose originalActionId is not a UUID', () => {
    expect(() =>
      validateAction({ action: 'rollback', actionId: VALID, originalActionId: 'nope' }),
    ).toThrow(BadRequestError)
  })

  // amount invariants apply to bet/win only; a rollback carries no amount.
  const badAmounts: Array<[number, string]> = [
    [0, 'zero'],
    [-5, 'negative'],
    [1.5, 'non-integer'],
    [Number.NaN, 'NaN'],
  ]
  it.each(badAmounts)('rejects a bet with a non-positive-integer amount (%s — %s)', (amount) => {
    expect(() => validateAction({ action: 'bet', actionId: VALID, amount })).toThrow(
      BadRequestError,
    )
  })

  it('does not require an amount on a rollback', () => {
    expect(() =>
      validateAction({ action: 'rollback', actionId: VALID, originalActionId: VALID_2 }),
    ).not.toThrow()
  })
})
