/**
 * Run the world with LLM-backed agents.
 *
 *   npm run agent -- --agent sera --days 3 --lockstep            one agent (Phase 1)
 *   npm run agent -- --agent all --days 2 --lockstep --quiet     the whole cast (Phase 2)
 *   npm run agent -- --agent sera --days 3 --lockstep --mock     no API key: heuristic stand-in
 *   npm run agent -- --agent all --days 1 --tick-ms 10000        real time; the loop never waits
 *
 * Options: --db --world --seed --concurrency N --no-reflect --verbose --quiet --log FILE
 *
 * --lockstep waits for in-flight turns between ticks. Debug only: the real
 * engine never waits for an LLM (spec §2). Determinism is unaffected — the
 * intent log replays either way.
 */
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentId } from '../core/types.js'
import { formatTime, HOURS_PER_DAY, SPEEDS, timeOf } from '../core/clock.js'
import { CAST, castMember, isAgent } from '../world/cast.js'
import { createInitialState } from '../sim/state.js'
import { formatEvent } from '../sim/log.js'
import { openDb } from '../db/client.js'
import { WorldStore } from '../db/store.js'
import { Engine } from '../engine/engine.js'
import { AgentRuntime, type TurnRecord } from '../agents/runtime.js'
import { reflectionDay } from '../agents/reflection.js'
import { MockBackend, heuristicScript, localBackendFromEnv, type AgentBackend } from '../agents/backend.js'
import { loadEnv, parseArgs } from './args.js'
import { AlitaBackend, AlitaMemorySync, alitaClientFromEnv, castBackends } from '../agents/alita.js'

loadEnv()
const args = parseArgs()
const agentIds = args.agent === 'all' ? CAST.map((c) => c.id) : String(args.agent ?? 'sera').split(',').map((s) => s.trim())
for (const id of agentIds) if (!isAgent(id)) throw new Error(`Unknown agent "${id}"`)
const days = Number(args.days ?? 2)
const tickMs = Number(args['tick-ms'] ?? SPEEDS.default)
const lockstep = !!args.lockstep
const dbPath = String(args.db ?? process.env.FORTITUDE_DB ?? 'data/fortitude.db')
const worldId = String(args.world ?? 'phase1')
const seed = String(args.seed ?? 'fortitude-1')
const verbose = !!args.verbose
const quiet = !!args.quiet
const logFile = typeof args.log === 'string' ? args.log : null
if (logFile) {
  mkdirSync(dirname(logFile), { recursive: true })
  writeFileSync(logFile, '')
}
const out = (line: string) => {
  console.log(line)
  if (logFile) appendFileSync(logFile, line + '\n')
}

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

const name = (id: AgentId) => castMember(id).name.split(' ')[0]!
const callsByDay = new Map<number, { turns: number; reflections: number }>()

function printReflection(t: TurnRecord): void {
  const when = formatTime(t.tickAnswered)
  if (t.status !== 'ok') return void out(`\n✎ ${when}  ${name(t.agentId)} — reflection failed: ${t.error}`)
  const r = t.reflection!
  out(`\n✎ ${when}  ${name(t.agentId)}${t.servedBy && t.servedBy !== backend.name ? ` [via ${t.servedBy}]` : ''} reflects. ${r.summary ?? ''}`)
  for (const o of r.opinions) out(`│ of ${o.agentId} (${o.stance >= 0 ? '+' : ''}${o.stance.toFixed(1)}): ${o.view}`)
  for (const b of r.beliefs) out(`│ believes: ${b.text}`)
  for (const g of r.goals) out(`│ goal ${g.id} [${g.status}] ${g.text ?? ''} ${g.note ? '— ' + g.note : ''}`)
  if (r.journal) out(`│ journal: ${quiet ? r.journal.replace(/\s+/g, ' ').slice(0, 300) + (r.journal.length > 300 ? '…' : '') : r.journal.replace(/\n+/g, '\n│          ')}`)
  out(`└ ${t.notes?.join('; ')} · ${t.latencyMs} ms`)
}

function printTurn(t: TurnRecord): void {
  if (t.status !== 'skipped') {
    const d = t.kind === 'reflect' ? reflectionDay(t.tickAsked) : timeOf(t.tickAsked).day
    const row = callsByDay.get(d) ?? { turns: 0, reflections: 0 }
    if (t.kind === 'reflect') row.reflections++
    else row.turns++
    callsByDay.set(d, row)
  }
  if (t.kind === 'reflect') return printReflection(t)
  const when = formatTime(t.tickAnswered)
  if (t.status === 'skipped') {
    if (verbose) out(`  · ${name(t.agentId)} stayed dormant (${t.trigger.kind}): ${t.error}`)
    return
  }
  if (t.status !== 'ok') return void out(`\n┌ ${when}  ${name(t.agentId)} woke — ${t.trigger.kind}\n└ ✗ ${t.status}: ${t.error}`)
  const p = t.parsed!
  if (quiet) {
    const acts = p.intents.map((i) => `${i.kind}${i.target ? ' ' + i.target : ''}${i.to ? '→' + i.to : ''}${i.fact ? ' [' + i.fact + ']' : ''}`).join(', ') || '—'
    const says = p.dialogue ? `  says to ${p.dialogue.to}${p.dialogue.reveals ? ' [reveals ' + p.dialogue.reveals + ']' : ''}: “${p.dialogue.say}”` : ''
    const via = t.servedBy && t.servedBy !== backend.name ? ` [via ${t.servedBy}]` : ''
    return void out(`┌ ${when}  ${name(t.agentId)}${via} (${t.trigger.kind}) → ${acts}${says}`)
  }
  out(`\n┌ ${when}  ${name(t.agentId)} woke — ${t.trigger.kind} (${t.trigger.urgency.toFixed(2)}): ${t.trigger.detail.slice(0, 160)}`)
  for (const i of p.intents) out(`│ intent  ${i.kind}${i.target ? ' ' + i.target : ''}${i.to ? ' → ' + i.to : ''}${i.fact ? ' [' + i.fact + ']' : ''} (w${i.weight.toFixed(2)}, until ${formatTime(i.expiresTick)}) — ${i.reason}`)
  if (p.dialogue) out(`│ says    to ${p.dialogue.to} [${p.dialogue.register}${p.dialogue.reveals ? ', reveals ' + p.dialogue.reveals : ''}]: “${p.dialogue.say}”`)
  for (const m of p.memoryWrites) out(`│ notes   (${m.importance}) ${m.text}`)
  if (p.mood) out(`│ mood    ${p.mood}`)
  for (const g of p.goalUpdates) out(`│ goal    ${g.id} ≈ ${g.progress ?? '?'} ${g.note ?? ''}`)
  for (const v of p.violations) out(`│ ⚠ ${v}`)
  out(`└ ${t.latencyMs} ms, asked at ${formatTime(t.tickAsked)}`)
}

// The Queen goes through the Alita system when ALITA_URL is set (falling back to the local model).
const alitaClient = args.mock || args['no-alita'] ? null : alitaClientFromEnv()
const alitaBackend = alitaClient ? new AlitaBackend(alitaClient, worldId, backend) : null
if (alitaClient) {
  out(`Alita adapter: ${alitaClient.url} (fallback: ${backend.name})`)
  engine.listeners.push(new AlitaMemorySync(store, worldId, alitaClient))
}

const runtime = new AgentRuntime({
  store,
  worldId,
  getState: () => engine.state,
  agents: castBackends(backend, alitaBackend, agentIds),
  onTurn: printTurn,
  concurrency: Number(args.concurrency ?? 4),
  reflection: !args['no-reflect'],
})
engine.listeners.push(runtime)

// What happens to their proposals, and the events they're part of.
engine.listeners.push({
  onTick(r) {
    for (const i of r.intents) {
      if (i.source !== 'agent' || !agentIds.includes(i.agentId)) continue
      if (i.status === 'rejected') out(`  ✗ ${formatTime(r.state.tick)} rejected: ${name(i.agentId)} ${i.kind}${i.target ? ' ' + i.target : ''} — ${i.rejectReason}`)
      if (!quiet && i.status === 'committed') out(`  ✓ ${formatTime(r.state.tick)} committed: ${name(i.agentId)} ${i.kind}${i.target ? ' ' + i.target : ''}${i.to ? ' → ' + i.to : ''}`)
      if (!quiet && i.status === 'fulfilled') out(`  ★ ${formatTime(r.state.tick)} fulfilled: ${name(i.agentId)} ${i.kind}${i.target ? ' ' + i.target : ''}`)
    }
    for (const e of r.events) {
      if (e.type === 'station' || e.type === 'intent') continue
      if (e.type === 'encounter' && quiet && (e.outcome === 'connect' || e.outcome === 'cooperate')) continue
      if (e.type === 'incident' || agentIds.some((id) => e.actorId === id || e.targetId === id)) out(`  ${formatEvent(e)}`)
    }
  },
})

const startTick = engine.state.tick
const endTick = startTick + days * HOURS_PER_DAY
out(`World "${worldId}" @ ${formatTime(startTick)} → ${formatTime(endTick)}. Agents: ${agentIds.join(', ')} via ${backend.name}. ${lockstep ? 'Lockstep.' : `Real time, ${tickMs} ms/tick.`}`)

async function main(): Promise<void> {
  const t0 = Date.now()
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
  out(`\nDone @ ${formatTime(engine.state.tick)} in ${((Date.now() - t0) / 1000).toFixed(0)}s. Turns ${s.turns} + ${s.reflections} reflections (ok ${s.ok}, invalid ${s.invalid}, errors ${s.errors}), dormant-by-budget ${s.skippedBudget}, coalesced ${s.coalesced}, violations ${s.violations}.`)
  out('LLM calls per in-world day: ' + [...callsByDay].map(([d, r]) => `Day ${d}: ${r.turns} turns + ${r.reflections} reflections`).join(' · '))
  out(`Replay check: npm run replay -- --db ${dbPath} --world ${worldId}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
