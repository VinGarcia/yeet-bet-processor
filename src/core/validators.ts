import type { Action } from './entities.js'
import { BadRequestError } from './errors.js'

/**
 * Validates a domain {@link Action}'s invariants — the single source of truth
 * for what makes an action well-formed. Inbound adapters call this after
 * narrowing the wire shape; the core and repo then trust the contract.
 *
 * `amount` is a positive integer in the smallest currency unit: the direction
 * (debit vs credit) is encoded by `action`, never by the sign, so a zero or
 * negative amount is always a bad request.
 */
export function validateAction(action: Action): void {
  if (!Number.isInteger(action.amount) || action.amount <= 0) {
    throw new BadRequestError('amount must be a positive integer')
  }
}
