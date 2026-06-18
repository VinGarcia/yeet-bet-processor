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
 * HMAC-SHA256 auth on an encapsulated scope: requests must carry
 * `Authorization: HMAC-SHA256 <hex>` over the RAW body bytes. Scope-local only —
 * the raw-body parser it installs would otherwise leak onto sibling routes.
 */
export function registerHmacAuth(scope: FastifyInstance, opts: { secret: string }): void {
  // Reject before the body parser runs. Rejections go via done(err) to reach the
  // central setErrorHandler; a synchronous throw here would surface as a 500.
  scope.addHook('onRequest', (request, _reply, done) => {
    const header = request.headers.authorization
    if (header === undefined || !header.startsWith(AUTH_PREFIX)) {
      done(new ForbiddenError())
      return
    }

    request.hmacSignature = header.slice(AUTH_PREFIX.length)
    done()
  })

  // Verify against the raw bytes BEFORE JSON.parse, so a bad signature never
  // reaches the parser and a re-serialization can't change what was signed.
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
