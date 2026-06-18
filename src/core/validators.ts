import type { Action } from './entities.js'
import { BadRequestError } from './errors.js'

// `action_id` and `original_action_id` are Postgres `uuid` columns, so an id
// that isn't a well-formed UUID can never be a real row — validating it here
// turns it into a clean 400 instead of letting the malformed value reach the DB
// and surface as a raw 22P02 (`invalid input syntax for type uuid`) HTTP 500.
// The 8-4-4-4-12 hex shape mirrors exactly what Postgres' `uuid` type accepts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Validates a domain {@link Action}'s invariants — the single source of truth
 * for what makes an action well-formed. Inbound adapters call this after
 * narrowing the wire shape; the core and repo then trust the contract.
 *
 * `actionId` (and, for a `rollback`, `originalActionId`) must be a valid UUID:
 * both map to `uuid` storage columns, so a non-UUID is always a bad request.
 * For `bet`/`win`, `amount` is a positive integer in the smallest currency
 * unit: the direction (debit vs credit) is encoded by `action`, never by the
 * sign, so a zero or negative amount is always a bad request. A `rollback`
 * carries no `amount` (it is derived from the referenced original).
 */
export function validateAction(action: Action): void {
  if (typeof action.actionId !== 'string' || !UUID_RE.test(action.actionId)) {
    throw new BadRequestError('action_id must be a valid UUID')
  }
  if (action.action === 'rollback') {
    if (typeof action.originalActionId !== 'string' || !UUID_RE.test(action.originalActionId)) {
      throw new BadRequestError('original_action_id must be a valid UUID')
    }
    return
  }
  if (!Number.isInteger(action.amount) || action.amount <= 0) {
    throw new BadRequestError('amount must be a positive integer')
  }
}
