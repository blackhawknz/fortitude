/**
 * Manage the Queen's link to the Alita system.
 *
 *   npm run alita -- --world fortitude                status: reachable? memories mirrored? backlog?
 *   npm run alita -- --world fortitude --sync         push the backlog now
 *   npm run alita -- --world fortitude --retract      remove this world from Alita's memory (reset/delete)
 */
import { openDb } from '../db/client.js'
import { WorldStore } from '../db/store.js'
import { AlitaMemorySync, alitaClientFromEnv, scopeFor } from '../agents/alita.js'
import { loadEnv, parseArgs } from './args.js'

loadEnv()
const args = parseArgs()
const worldId = String(args.world ?? 'fortitude')
const store = new WorldStore(openDb(String(args.db ?? process.env.FORTITUDE_DB ?? 'data/fortitude.db')))
const client = alitaClientFromEnv()
if (!client) {
  console.error('ALITA_URL is not set.')
  process.exit(1)
}

async function main(): Promise<void> {
  const scope = scopeFor(worldId)
  if (args.retract) {
    const r = await client!.retract(scope)
    store.clearSync(worldId)
    console.log(`Retracted ${r.retracted} memories from ${scope}; local outbox reset.`)
    return
  }
  if (args.sync) {
    const n = await new AlitaMemorySync(store, worldId, client!).drain()
    console.log(`Pushed ${n} memories to ${scope}.`)
  }
  const backlog = store.unsyncedMemories(worldId, 'alita', 3, 10_000).length
  try {
    const r = await client!.readMemory(scope, 200)
    console.log(`Alita at ${client!.url}: reachable. ${r.memories.length} memories in ${scope}. Mirrored locally: ${store.syncedCount(worldId)}. Backlog: ${backlog}.`)
  } catch (err) {
    console.log(`Alita at ${client!.url}: NOT reachable (${(err as Error).message}). Backlog: ${backlog} — will reconcile when she's back.`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
