/**
 * Base domain error classes. Each carries a machine-readable numeric `code`
 * and a human-readable `message`. The core deliberately knows nothing about
 * HTTP: mapping a domain error to a transport status lives in the adapter
 * (the `setErrorHandler` in `apps/api/app.ts`).
 *
 * The numeric codes below are placeholder domain codes (documented in the
 * README as needing alignment with Yeet) and must NOT be read as HTTP status.
 */
export class DomainError extends Error {
  readonly code: number

  constructor(message: string, code: number) {
    super(message)
    this.name = new.target.name
    this.code = code
  }
}

export class NotFoundError extends DomainError {
  constructor(message = 'Not found') {
    super(message, 404)
  }
}

export class BadRequestError extends DomainError {
  constructor(message = 'Bad request') {
    super(message, 400)
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'Forbidden') {
    super(message, 403)
  }
}

export class InternalError extends DomainError {
  constructor(message = 'Internal error') {
    super(message, 500)
  }
}

/**
 * Raised when a player's wallet cannot cover the net debit of a batch. Carries
 * the spec's domain code `100`. The whole request is rolled back: no wallet
 * change and no ledger rows are written.
 */
export class InsufficientFundsError extends DomainError {
  constructor(message = 'Player has not enough funds to process an action') {
    super(message, 100)
  }
}
