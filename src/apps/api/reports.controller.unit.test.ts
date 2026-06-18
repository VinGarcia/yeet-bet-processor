import { describe, it, expect } from 'vitest'
import { parseIsoDatetime } from './reports.controller.js'
import { BadRequestError } from '../../core/errors.js'

// parseIsoDatetime is the acceptance boundary for `from`/`to`. The integration
// suite only grazes it with one 'not-a-date' case, so pin the ISO-8601 shapes
// the regex must accept/reject directly here (no DB / testcontainers needed).
describe('parseIsoDatetime', () => {
  const accepted: Array<[string, string]> = [
    ['2026-01-10T00:00:00Z', 'seconds + Z'],
    ['2026-01-10T00:00:00.000Z', 'fractional seconds + Z'],
    ['2026-01-10T12:30:45.123456Z', 'microsecond fraction + Z'],
    ['2026-01-10T00:00:00+02:00', 'positive offset'],
    ['2026-01-10T00:00:00-05:30', 'negative offset'],
    ['2026-01-10T00:00:00.500+00:00', 'fraction + offset'],
  ]
  it.each(accepted)('accepts %s (%s)', (value) => {
    const d = parseIsoDatetime(value, 'from')
    expect(d).toBeInstanceOf(Date)
    expect(Number.isNaN(d.getTime())).toBe(false)
    expect(d.getTime()).toBe(Date.parse(value))
  })

  const rejected: Array<[unknown, string]> = [
    ['2026-01-10', 'bare date, no T'],
    ['2026-01-10T00:00', 'missing seconds'],
    ['2026-01-10T00:00:00', 'no offset/Z'],
    ['2026-01-10T00:00:00+0200', 'offset missing colon'],
    ['2026-01-10T00:00:00+2:00', 'offset hours not two digits'],
    ['2026-01-10T00:00:00z', 'lowercase z'],
    ['2026-01-10 00:00:00Z', 'space instead of T'],
    ['not-a-date', 'free text'],
    ['', 'empty string'],
    ['2026-13-10T00:00:00Z', 'invalid month (passes regex, fails Date.parse)'],
    [123, 'non-string number'],
    [null, 'null'],
    [undefined, 'undefined'],
    [{ from: '2026-01-10T00:00:00Z' }, 'object'],
  ]
  it.each(rejected)('rejects %s (%s)', (value) => {
    expect(() => parseIsoDatetime(value, 'from')).toThrow(BadRequestError)
  })

  it('uses the field name in the thrown message', () => {
    expect(() => parseIsoDatetime('nope', 'to')).toThrow(/^to /)
  })
})
