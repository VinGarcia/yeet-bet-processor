/**
 * Base domain error classes. Each carries an `httpStatus` so the HTTP layer
 * can map domain failures to responses without leaking transport concerns
 * into the core.
 */
export class DomainError extends Error {
  readonly httpStatus: number

  constructor(message: string, httpStatus: number) {
    super(message)
    this.name = new.target.name
    this.httpStatus = httpStatus
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

export class InternalError extends DomainError {
  constructor(message = 'Internal error') {
    super(message, 500)
  }
}
