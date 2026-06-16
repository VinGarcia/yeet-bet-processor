import { config as loadEnv } from 'dotenv'

loadEnv({ path: 'config.env' })

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

export interface Config {
  port: number
  databaseUrl: string
}

export const config: Config = {
  port: process.env.PORT !== undefined && process.env.PORT !== '' ? Number(process.env.PORT) : 3000,
  databaseUrl: required('DATABASE_URL'),
}
