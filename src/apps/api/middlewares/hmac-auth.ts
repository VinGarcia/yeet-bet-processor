import type { FastifyInstance } from 'fastify'
import { BadRequestError, ForbiddenError } from '../../../core/errors.js'
import { verify } from '../../../helpers/crypto/hmac.js'

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer
    hmacSignature?: string
  }
}

const AUTH_PREFIX = 'HMAC-SHA256 '

/**
 * Registers HMAC-SHA256 authentication on the given (encapsulated) Fastify
 * scope. Every request handled by this scope must carry an
 * `Authorization: HMAC-SHA256 <hex>` header whose signature matches an
 * HMAC-SHA256 over the RAW request body bytes.
 *
 * Apply this to a protected sub-scope only; the body parser it installs
 * preserves raw bytes and would otherwise leak onto sibling routes.
 */
export function registerHmacAuth(scope: FastifyInstance, opts: { secret: string }): void {
  // Reject unauthenticated/malformed requests before the body parser runs, so a
  // missing or garbage Authorization header never reaches JSON parsing.
  // Rejections go to `done(err)` so they reach the central setErrorHandler;
  // a synchronous `throw` in a callback hook would surface as an unmapped 500.
  scope.addHook('onRequest', (request, _reply, done) => {
    const header = request.headers.authorization
    if (header === undefined || !header.startsWith(AUTH_PREFIX)) {
      done(new ForbiddenError())
      return
    }

    request.hmacSignature = header.slice(AUTH_PREFIX.length)
    done()
  })

  // Preserve the raw bytes so the signature is verified against exactly what
  // the client sent, not a re-serialized JSON representation. The signature is
  // verified BEFORE JSON.parse so a bad signature can never reach the parser.
  scope.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      req.rawBody = body

      if (!verify(opts.secret, body, req.hmacSignature ?? '')) {
        done(new ForbiddenError())
        return
      }

      try {
        const parsed: unknown = JSON.parse(body.toString('utf8'))
        done(null, parsed)
      } catch {
        done(new BadRequestError('invalid JSON body'))
      }
    },
  )
}
