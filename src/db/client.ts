import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from './schema.js'

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database }

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle')

/** Open (and migrate) a world database. Pass ':memory:' for tests. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true })
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema }) as Db
  migrate(db, { migrationsFolder: MIGRATIONS })
  return db
}
