import type { FastifyInstance } from 'fastify'
import type { Repo } from '../../adapters/repo/contracts.js'
import type { Action } from '../../core/entities.js'
import { BadRequestError } from '../../core/errors.js'
import { validateAction } from '../../core/validators.js'

// The narrowed request shape; the aggregator speaks snake_case, mapped to camelCase here.
interface ProcessRequest {
  userId: string
  currency: string
  game?: string
  gameId?: string
  actions: Action[]
}

// Narrows one raw element to an {@link Action}; bet/win share a shape, rollback
// carries original_action_id and no amount. validateAction enforces invariants after.
function parseAction(raw: unknown): Action {
  if (typeof raw !== 'object' || raw === null) {
    throw new BadRequestError('each action must be a JSON object')
  }
  if (
    !('action' in raw) ||
    (raw.action !== 'bet' && raw.action !== 'win' && raw.action !== 'rollback')
  ) {
    throw new BadRequestError(
      'unsupported action type; only "bet", "win" and "rollback" are supported',
    )
  }
  if (!('action_id' in raw) || typeof raw.action_id !== 'string') {
    throw new BadRequestError('action_id is required and must be a string')
  }

  let action: Action
  if (raw.action === 'rollback') {
    if (!('original_action_id' in raw) || typeof raw.original_action_id !== 'string') {
      throw new BadRequestError('original_action_id is required and must be a string')
    }
    action = {
      action: 'rollback',
      actionId: raw.action_id,
      originalActionId: raw.original_action_id,
    }
  } else {
    if (!('amount' in raw) || typeof raw.amount !== 'number') {
      throw new BadRequestError('amount is required and must be a number')
    }
    action = { action: raw.action, actionId: raw.action_id, amount: raw.amount }
  }
  validateAction(action)
  return action
}

// Narrows the parsed body to {@link ProcessRequest}; absent `actions` = a balance-only request.
function parseProcessRequest(body: unknown): ProcessRequest {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestError('request body must be a JSON object')
  }
  if (!('user_id' in body) || typeof body.user_id !== 'string') {
    throw new BadRequestError('user_id is required')
  }
  if (!('currency' in body) || typeof body.currency !== 'string') {
    throw new BadRequestError('currency is required')
  }
  let game: string | undefined
  if ('game' in body) {
    if (typeof body.game !== 'string') throw new BadRequestError('game must be a string')
    game = body.game
  }
  let gameId: string | undefined
  if ('game_id' in body) {
    if (typeof body.game_id !== 'string') throw new BadRequestError('game_id must be a string')
    gameId = body.game_id
  }

  const rawActions = 'actions' in body && Array.isArray(body.actions) ? body.actions : []
  const actions = rawActions.map(parseAction)

  return { userId: body.user_id, currency: body.currency, game, gameId, actions }
}

/**
 * Registers `POST /aggregator/takehome/process`. No `actions` = a balance-only
 * lookup (0 for an unknown user); otherwise the batch is applied atomically.
 */
export function registerProcessController(app: FastifyInstance, repo: Repo): void {
  app.post('/aggregator/takehome/process', async (request, reply) => {
    const { userId, currency, game, gameId, actions } = parseProcessRequest(request.body)

    if (actions.length === 0) {
      const wallet = await repo.findWallet(userId, currency)
      return reply.code(200).send({ balance: wallet?.balance ?? 0 })
    }

    const result = await repo.processActions({ userId, currency, game, gameId, actions })
    return reply.code(200).send({
      balance: result.balance,
      transactions: result.transactions.map((t) => ({ action_id: t.actionId, tx_id: t.txId })),
      game_id: gameId,
    })
  })
}
