import { signedJsonRequest } from '../../helpers/crypto/hmac.js'

// Thin signed HTTP client; signing lives in `signedJsonRequest`, this adds path
// resolution and JSON/error handling.
export class SignedClient {
  constructor(
    private readonly baseURL: string,
    private readonly secret: string,
  ) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    const { init } = signedJsonRequest(this.secret, body)
    const res = await fetch(`${this.baseURL}${path}`, init)
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`POST ${path} → ${res.status}: ${text}`)
    }
    return text === '' ? undefined : JSON.parse(text)
  }

  /** Sends one `process` batch (a bet, optionally followed by a win). */
  async process(body: {
    user_id: string
    currency: string
    game: string
    game_id: string
    finished: boolean
    actions: Array<Record<string, unknown>>
  }): Promise<void> {
    await this.post('/aggregator/takehome/process', body)
  }

  /** Fetches every casino-wide RTP row in `[from, to)`, following the cursor. */
  async casinoRtp(from: string, to: string): Promise<CasinoRtpItem[]> {
    return this.pagedReport('/aggregator/takehome/reports/rtp/casino', from, to)
  }

  /** Fetches every per-user RTP row in `[from, to)`, following the cursor. */
  async usersRtp(from: string, to: string): Promise<UserRtpItem[]> {
    return this.pagedReport('/aggregator/takehome/reports/rtp/users', from, to)
  }

  private async pagedReport<Row>(path: string, from: string, to: string): Promise<Row[]> {
    const items: Row[] = []
    let cursor: string | null = null
    do {
      const page = (await this.post(path, { from, to, cursor: cursor ?? undefined })) as {
        items: Row[]
        cursor: string | null
      }
      items.push(...page.items)
      cursor = page.cursor
    } while (cursor !== null)
    return items
  }
}

export interface CasinoRtpItem {
  currency: string
  rounds: number
  total_bet: number
  total_win: number
  rtp: number | null
  rolled_back_bet: number
  rolled_back_win: number
}

export interface UserRtpItem extends CasinoRtpItem {
  user_id: string
}
