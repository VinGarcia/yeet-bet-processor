/**
 * Base domain error: a numeric domain `code` + message. The core knows nothing
 * about HTTP — status mapping lives in `apps/api/app.ts`'s setErrorHandler. The
 * codes are domain codes, NOT HTTP status (placeholders pending Yeet alignment).
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

// Wallet can't cover the batch's net debit; carries the spec's domain code 100.
export class InsufficientFundsError extends DomainError {
  constructor(message = 'Player has not enough funds to process an action') {
    super(message, 100)
  }
}
