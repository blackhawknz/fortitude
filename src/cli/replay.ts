/**
 * Verify a persisted world against its seed + intent log.
 *
 *   npm run replay -- --db data/fortitude.db --world w1
 */
import { openDb } from '../db/client.js'
import { WorldStore } from '../db/store.js'
import { replay, sameWorld } from '../sim/replay.js'
import { simFingerprint } from '../sim/state.js'
import { SIM_VERSION } from '../sim/tick.js'
import { parseArgs } from './args.js'

const args = parseArgs()
const dbPath = String(args.db ?? process.env.FORTITUDE_DB ?? 'data/fortitude.db')
const worldId = String(args.world ?? 'w1')

const store = new WorldStore(openDb(dbPath))
const live = store.load(worldId)
const version = store.simVersion(worldId)
if (version !== SIM_VERSION) console.warn(`⚠ world was created with sim v${version}, this build is v${SIM_VERSION} — divergence is expected.`)
const subs = store.submissionsByTick(worldId)
const n = [...subs.values()].reduce((sum, l) => sum + l.length, 0)
const t0 = performance.now()
const rebuilt = replay({ id: live.id, name: live.name, seed: live.seed, settings: live.settings, toTick: live.tick, submissions: subs })
const ok = sameWorld(live, rebuilt)
console.log(`world ${worldId} @ tick ${live.tick}, ${n} logged external intents, replayed in ${((performance.now() - t0) / 1000).toFixed(2)}s`)
console.log(`live     ${simFingerprint(live)}`)
console.log(`replayed ${simFingerprint(rebuilt)}`)
console.log(ok ? 'IDENTICAL ✓' : 'DIVERGED ✗')
process.exit(ok ? 0 : 1)
