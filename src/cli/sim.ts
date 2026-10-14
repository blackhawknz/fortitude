/**
 * Phase 0 headless run.
 *
 *   npm run sim -- --days 30 --seed fortitude-1            in memory, prints report
 *   npm run sim -- --days 30 --db data/w1.db --world w1    persisted (resumes if the world exists)
 *   npm run sim -- --days 30 --log out/log.txt             also write the full event log
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SimEvent, WorldState } from '../core/types.js'
import { HOURS_PER_DAY } from '../core/clock.js'
import { createInitialState } from '../sim/state.js'
import { advanceTick } from '../sim/tick.js'
import { formatEvent } from '../sim/log.js'
import { storyReport } from '../sim/report.js'
import { loadEnv, parseArgs } from './args.js'
import { openDb } from '../db/client.js'
import { WorldStore } from '../db/store.js'

loadEnv()
const args = parseArgs()
const days = Number(args.days ?? 30)
const seed = String(args.seed ?? 'fortitude-1')
const worldId = String(args.world ?? 'w1')
const dbPath = typeof args.db === 'string' ? args.db : null

let state: WorldState
let store: WorldStore | null = null
if (dbPath) {
  store = new WorldStore(openDb(dbPath))
  state = store.exists(worldId) ? store.load(worldId) : store.create(createInitialState({ id: worldId, seed }))
} else {
  state = createInitialState({ id: worldId, seed })
}

const start = structuredClone(state)
const events: SimEvent[] = []
const t0 = performance.now()
for (let i = 0; i < days * HOURS_PER_DAY; i++) {
  const r = advanceTick(state, [])
  state = r.state
  events.push(...r.events)
  store?.persistTick(r)
}
const ms = performance.now() - t0

if (typeof args.log === 'string') {
  mkdirSync(dirname(args.log), { recursive: true })
  writeFileSync(args.log, events.filter((e) => e.type !== 'station').map(formatEvent).join('\n') + '\n')
}
if (!args.quiet) console.log(storyReport(start, state, events))
console.log(`\n${events.length} events in ${(ms / 1000).toFixed(2)}s${store ? ` → ${dbPath}` : ' (in memory)'}`)
