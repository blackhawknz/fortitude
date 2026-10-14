/**
 * Phase 1: run the world with one (or a few) LLM-backed agents.
 *
 *   npm run agent -- --agent sera --days 3 --lockstep            uses FORTITUDE_LLM_* from .env
 *   npm run agent -- --agent sera --days 3 --lockstep --mock     no API key: heuristic stand-in
 *   npm run agent -- --agent sera --days 1 --tick-ms 5000        real time, the loop never waits
 *
 * --lockstep waits for in-flight turns between ticks. Debug only: the real
 * engine never waits for an LLM (spec §2). It does not affect determinism —
 * the intent log is replayable either way.
 */
import type { AgentId } from '../core/types.js'
import { formatTime, HOURS_PER_DAY } from '../core/clock.js'
import { castMember, isAgent } from '../world/cast.js'
import { createInitialState } from '../sim/state.js'
import { formatEvent } from '../sim/log.js'
import { openDb } from '../db/client.js'
import { WorldStore } from '../db/store.js'
import { Engine } from '../engine/engine.js'
import { AgentRuntime, type TurnRecord } from '../agents/runtime.js'
import { MockBackend, heuristicScript, localBackendFromEnv, type AgentBackend } from '../agents/backend.js'
import { loadEnv, parseArgs } from './args.js'

loadEnv()
const args = parseArgs()
const agentIds = String(args.agent ?? 'sera').split(',').map((s) => s.trim())
for (const id of agentIds) if (!isAgent(id)) throw new Error(`Unknown agent "${id}"`)
const days = Number(args.days ?? 2)
const tickMs = Number(args['tick-ms'] ?? 5000)
const lockstep = !!args.lockstep
const dbPath = String(args.db ?? process.env.FORTITUDE_DB ?? 'data/fortitude.db')
const worldId = String(args.world ?? 'phase1')
const seed = String(args.seed ?? 'fortitude-1')
const verbose = !!args.verbose

let backend: AgentBackend
if (args.mock) backend = new MockBackend(heuristicScript, 50)
else {
  const local = localBackendFromEnv()
  if (!local) {
    console.error('No LLM configured. Set FORTITUDE_LLM_BASE_URL / FORTITUDE_LLM_MODEL (and _API_KEY) in .env, or pass --mock.')
    process.exit(1)
  }
  backend = local
}

const store = new WorldStore(openDb(dbPath))
if (!store.exists(worldId)) store.create(createInitialState({ id: worldId, seed }), tickMs)
const engine = new Engine({ store, worldId, tickMs })

const name = (id: AgentId) => castMember(id).name.split(' ')[0]
function printTurn(t: TurnRecord): void {
  const when = formatTime(t.tickAnswered)
  if (t.status === 'skipped') {
    if (verbose) console.log(`  · ${name(t.agentId)} stayed dormant (${t.trigger.kind}): ${t.error}`)
    return
  }
  console.log(`\n┌ ${when}  ${name(t.agentId)} woke — ${t.trigger.kind} (${t.trigger.urgency.toFixed(2)}): ${t.trigger.detail.slice(0, 160)}`)
  if (t.status !== 'ok') return void console.log(`└ ✗ ${t.status}: ${t.error}`)
  const p = t.parsed!
  for (const i of p.intents) console.log(`│ intent  ${i.kind}${i.target ? ' ' + i.target : ''}${i.to ? ' → ' + i.to : ''} (w${i.weight.toFixed(2)}, until ${formatTime(i.expiresTick)}) — ${i.reason}`)
  if (p.dialogue) console.log(`│ says    to ${p.dialogue.to} [${p.dialogue.register}]: “${p.dialogue.say}”`)
  for (const m of p.memoryWrites) console.log(`│ notes   (${m.importance}) ${m.text}`)
  if (p.mood) console.log(`│ mood    ${p.mood}`)
  for (const g of p.goalUpdates) console.log(`│ goal    ${g.id} ≈ ${g.progress ?? '?'} ${g.note ?? ''}`)
  for (const v of p.violations) console.log(`│ ⚠ ${v}`)
  console.log(`└ ${t.latencyMs} ms, asked at ${formatTime(t.tickAsked)}`)
}

const runtime = new AgentRuntime({ store, worldId, getState: () => engine.state, agents: Object.fromEntries(agentIds.map((id) => [id, backend])), onTurn: printTurn })
engine.listeners.push(runtime)

// Show what happens to the watched agents' intents and the events they're part of.
engine.listeners.push({
  onTick(r) {
    for (const i of r.intents) {
      if (i.source !== 'agent' || !agentIds.includes(i.agentId)) continue
      if (i.status === 'committed') console.log(`  ✓ ${formatTime(r.state.tick)} committed: ${name(i.agentId)} ${i.kind}${i.target ? ' ' + i.target : ''}${i.to ? ' → ' + i.to : ''}`)
      if (i.status === 'rejected') console.log(`  ✗ ${formatTime(r.state.tick)} rejected: ${name(i.agentId)} ${i.kind} — ${i.rejectReason}`)
      if (i.status === 'fulfilled') console.log(`  ★ ${formatTime(r.state.tick)} fulfilled: ${name(i.agentId)} ${i.kind}${i.target ? ' ' + i.target : ''}`)
    }
    for (const e of r.events) {
      if (e.type === 'station' || e.type === 'intent') continue
      if (agentIds.some((id) => e.actorId === id || e.targetId === id)) console.log(`  ${formatEvent(e)}`)
    }
  },
})

const startTick = engine.state.tick
const endTick = startTick + days * HOURS_PER_DAY
console.log(`World "${worldId}" @ ${formatTime(startTick)} → ${formatTime(endTick)}. Agents: ${agentIds.join(', ')} via ${backend.name}. ${lockstep ? 'Lockstep.' : `Real time, ${tickMs} ms/tick.`}`)

async function main(): Promise<void> {
  if (lockstep) {
    while (engine.state.tick < endTick) {
      engine.step()
      await runtime.idle()
    }
  } else {
    engine.start()
    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (engine.state.tick >= endTick) {
          clearInterval(iv)
          resolve()
        }
      }, 250)
    })
    engine.stop()
    await runtime.idle()
    if (store.pendingIntents(worldId).length) engine.step() // land the last proposals
  }
  const s = runtime.stats
  console.log(`\nDone @ ${formatTime(engine.state.tick)}. Turns ${s.turns} (ok ${s.ok}, invalid ${s.invalid}, errors ${s.errors}), dormant-by-budget ${s.skippedBudget}, coalesced ${s.coalesced}, violations ${s.violations}.`)
  console.log(`Budget: ${JSON.stringify(runtime.ledger.usage())}`)
  console.log(`Replay check: npm run replay -- --db ${dbPath} --world ${worldId}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
