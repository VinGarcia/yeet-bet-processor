import type { Action } from './entities.js'
import { BadRequestError } from './errors.js'

// ids map to Postgres `uuid` columns; validating here turns a malformed id into
// a clean 400 instead of a raw 22P02 ("invalid input syntax for type uuid") 500.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Single source of truth for a well-formed {@link Action}. Inbound adapters call
 * this after narrowing the wire shape; the core and repo then trust the contract.
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
