/**
 * The world, running. Server-side, real time, the whole cast (spec P1).
 *
 *   npm start                                   60 s ticks, all agents on FORTITUDE_LLM_*
 *   npm start -- --tick-ms 10000 --world w2     faster, another world
 *   npm start -- --dormant                      no LLM at all: instincts only
 *
 * Ctrl+C stops cleanly: the loop halts, in-flight turns finish, and their
 * proposals land on the next start. Restarting catches up (max 60 ticks).
 */
import { mkdirSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { formatTime, SPEEDS } from '../core/clock.js'
import { CAST } from '../world/cast.js'
import { createInitialState } from '../sim/state.js'
import { formatEvent } from '../sim/log.js'
import { openDb } from '../db/client.js'
import { WorldStore } from '../db/store.js'
import { Engine } from '../engine/engine.js'
import { AgentRuntime } from '../agents/runtime.js'
import { localBackendFromEnv, type AgentBackend } from '../agents/backend.js'
import { loadEnv, parseArgs } from './args.js'
import { AlitaBackend, AlitaMemorySync, alitaClientFromEnv, castBackends } from '../agents/alita.js'

loadEnv()
const args = parseArgs()
const tickMs = Number(args['tick-ms'] ?? SPEEDS.default)
const dbPath = String(args.db ?? process.env.FORTITUDE_DB ?? 'data/fortitude.db')
const worldId = String(args.world ?? 'fortitude')
const seed = String(args.seed ?? `fortitude-${Date.now()}`)
const logFile = String(args.log ?? `out/${worldId}.log`)
mkdirSync(dirname(logFile), { recursive: true })
const out = (line: string) => {
  console.log(line)
  appendFileSync(logFile, line + '\n')
}

const store = new WorldStore(openDb(dbPath))
if (!store.exists(worldId)) {
  store.create(createInitialState({ id: worldId, seed }), tickMs)
  out(`Created world "${worldId}" with seed "${seed}".`)
}
const engine = new Engine({ store, worldId, tickMs })

let backend: AgentBackend | null = null
if (!args.dormant) {
  backend = localBackendFromEnv()
  if (!backend) out('No LLM configured (FORTITUDE_LLM_*): running dormant, instincts only.')
}
// The Queen goes through the Alita system when ALITA_URL is set (falling back to the local model).
const alitaClient = backend && !args['no-alita'] ? alitaClientFromEnv() : null
const alitaBackend = alitaClient && backend ? new AlitaBackend(alitaClient, worldId, backend) : null
const sync = alitaClient ? new AlitaMemorySync(store, worldId, alitaClient) : null
if (sync) engine.listeners.push(sync)

const runtime = backend
  ? new AgentRuntime({
      store,
      worldId,
      getState: () => engine.state,
      agents: castBackends(backend, alitaBackend),
      concurrency: Number(args.concurrency ?? 3),
      onTurn: (t) => {
        if (t.status === 'skipped') return
        if (t.kind === 'reflect') return out(`  ✎ ${t.agentId} reflected${t.status === 'ok' ? `: ${t.reflection?.summary ?? ''}` : ` (${t.status})`}`)
        if (t.status !== 'ok') return out(`  ✗ ${t.agentId} turn ${t.status}: ${t.error}`)
        if (t.parsed?.dialogue) out(`  “${t.parsed.dialogue.say}” — ${t.agentId} to ${t.parsed.dialogue.to}`)
      },
    })
  : null
if (runtime) engine.listeners.push(runtime)
engine.listeners.push({
  onTick(r) {
    for (const e of r.events) {
      if (e.type === 'station' || e.type === 'intent' || e.type === 'speech') continue
      if (e.type === 'encounter' && (e.outcome === 'connect' || e.outcome === 'cooperate')) continue
      out(formatEvent(e))
    }
  },
})

const owed = engine.ticksOwed()
out(`Fortitude "${worldId}" @ ${formatTime(engine.state.tick)} · ${tickMs / 1000}s/tick · ${runtime ? `${CAST.length} agents via ${backend!.name}` : 'dormant'}${alitaClient ? ` · Queen via Alita at ${alitaClient.url}` : ''}${owed ? ` · catching up ${owed} ticks` : ''}`)
engine.start()

let stopping = false
process.on('SIGINT', async () => {
  if (stopping) process.exit(1)
  stopping = true
  out(`\nStopping @ ${formatTime(engine.state.tick)}…`)
  engine.stop()
  await runtime?.idle()
  await sync?.idle()
  out(runtime ? `Turns ${runtime.stats.turns}, reflections ${runtime.stats.reflections}, errors ${runtime.stats.errors}. Pending proposals land on next start.` : 'Stopped.')
  process.exit(0)
})
