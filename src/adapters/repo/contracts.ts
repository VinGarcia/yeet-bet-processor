/**
 * The Repo port. Concrete implementations (e.g. the Kysely repo) satisfy this
 * interface so the application core depends on the abstraction, not the driver.
 */
export interface Repo {
  checkConnection(): Promise<void>
}
