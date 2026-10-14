import { randomUUID } from 'node:crypto'
import type { AgentId, IntentProposal, WorldState } from '../core/types.js'
import { timeOf } from '../core/clock.js'
import { CAST, castMember } from '../world/cast.js'
import type { TickResult } from '../sim/tick.js'
import type { TickListener } from '../engine/engine.js'
import type { WorldStore } from '../db/store.js'
import type { AgentBackend } from './backend.js'
import { BudgetLedger, DEFAULT_BUDGETS, DEFAULT_GLOBAL_PER_REAL_HOUR, type AgentBudget } from './budget.js'
import { buildContextPacket, type Trigger } from './packet.js'
import { parseResponse, type ParsedResponse } from './response.js'
import { coalesce, deriveTriggers } from './triggers.js'
import { applyReflection, buildReflectionPacket, parseReflection, reflectionDay, reflectionHour, type EdgeSnapshot, type ParsedReflection } from './reflection.js'

export interface RuntimeOptions {
  store: WorldStore
  worldId: string
  /** Read the engine's current state (never mutated by the runtime). */
  getState: () => WorldState
  /** LLM-backed agents. Everyone else stays dormant (instincts only). */
  agents: Partial<Record<AgentId, AgentBackend>>
  budgets?: Partial<Record<AgentId, Partial<AgentBudget>>>
  globalPerRealHour?: number
  concurrency?: number
  turnTimeoutMs?: number
  /** Daily reflection pass (default on). */
  reflection?: boolean
  onTurn?: (t: TurnRecord) => void
  /** Injected for tests. */
  now?: () => number
  driftRoll?: () => number
}

export interface TurnRecord {
  agentId: AgentId
  kind: 'turn' | 'reflect'
  reflection?: ParsedReflection
  notes?: string[]
  trigger: Trigger
  status: 'ok' | 'invalid' | 'error' | 'timeout' | 'skipped'
  tickAsked: number
  tickAnswered: number
  parsed?: ParsedResponse
  submittedIntentIds: string[]
  error?: string
  latencyMs: number
}

export interface RuntimeStats {
  turns: number
  ok: number
  invalid: number
  errors: number
  skippedBudget: number
  reflections: number
  coalesced: number
  violations: number
}

/**
 * The agent runtime (spec §4). Listens to ticks (phase 7), decides who
 * wakes, runs their turns asynchronously, and turns their responses into
 * PROPOSALS on the intent queue. It has no other way to affect the world.
 */
export class AgentRuntime implements TickListener {
  readonly ledger: BudgetLedger
  readonly stats: RuntimeStats = { turns: 0, ok: 0, invalid: 0, errors: 0, skippedBudget: 0, reflections: 0, coalesced: 0, violations: 0 }
  private inFlight = new Set<AgentId>()
  private pending = new Map<AgentId, Trigger>()
  private pendingReflect = new Set<AgentId>()
  private reflectedDay = new Map<AgentId, number>()
  private lastReflectTick = new Map<AgentId, number>()
  private snapshots = new Map<AgentId, Record<AgentId, EdgeSnapshot>>()
  private readonly reflection: boolean
  private queue: (() => void)[] = []
  private active = 0
  private idleWaiters: (() => void)[] = []
  private readonly concurrency: number
  private readonly timeoutMs: number

  constructor(private readonly opts: RuntimeOptions) {
    const budgets: Record<AgentId, AgentBudget> = {}
    for (const id of Object.keys(opts.agents)) {
      const base = DEFAULT_BUDGETS[castMember(id).priority]
      budgets[id] = { ...base, ...opts.budgets?.[id] }
    }
    this.ledger = new BudgetLedger(budgets, opts.globalPerRealHour ?? DEFAULT_GLOBAL_PER_REAL_HOUR, opts.now)
    this.concurrency = opts.concurrency ?? 2
    this.timeoutMs = opts.turnTimeoutMs ?? 60_000
    this.reflection = opts.reflection ?? true
  }

  get enabledAgents(): AgentId[] {
    return Object.keys(this.opts.agents)
  }

  /** PHASE 7. Never awaits; never throws into the engine. */
  onTick(result: TickResult): void {
    const { hour } = timeOf(result.state.tick)
    const day = reflectionDay(result.state.tick)
    for (const agentId of this.enabledAgents) {
      // Once a day, the hour before sleep: reflection.
      if (this.reflection && hour === reflectionHour(agentId) && this.reflectedDay.get(agentId) !== day && result.state.agents[agentId]!.alive) {
        this.reflectedDay.set(agentId, day)
        if (this.inFlight.has(agentId)) this.pendingReflect.add(agentId)
        else this.startReflection(agentId)
        continue
      }
      const trigger = coalesce(deriveTriggers(agentId, result.state, result.events, this.opts.driftRoll?.() ?? Math.random()))
      if (!trigger) continue
      if (this.inFlight.has(agentId)) {
        // Already thinking: keep the most urgent thing for when they finish.
        const prev = this.pending.get(agentId)
        if (!prev || trigger.urgency > prev.urgency) this.pending.set(agentId, trigger)
        this.stats.coalesced++
        continue
      }
      this.wake(agentId, trigger)
    }
  }

  private wake(agentId: AgentId, trigger: Trigger): void {
    const day = timeOf(this.opts.getState().tick).day
    const decision = this.ledger.check(agentId, day, trigger.urgency)
    if (!decision.ok) {
      this.stats.skippedBudget++
      this.opts.onTurn?.({ agentId, kind: 'turn', trigger, status: 'skipped', tickAsked: trigger.tick, tickAnswered: trigger.tick, submittedIntentIds: [], error: decision.reason, latencyMs: 0 })
      return
    }
    this.ledger.spend(agentId, day)
    this.inFlight.add(agentId)
    this.schedule(() => this.turn(agentId, trigger).finally(() => this.afterJob(agentId)))
  }

  /** When an agent finishes thinking: a waiting reflection first, then the most urgent waiting trigger. */
  private afterJob(agentId: AgentId): void {
    this.inFlight.delete(agentId)
    if (this.pendingReflect.delete(agentId)) {
      this.startReflection(agentId)
    } else {
      const next = this.pending.get(agentId)
      this.pending.delete(agentId)
      if (next) this.wake(agentId, next)
    }
    this.checkIdle()
  }

  private startReflection(agentId: AgentId): void {
    const day = timeOf(this.opts.getState().tick).day
    const decision = this.ledger.check(agentId, day, 0.6, 'reflect')
    if (!decision.ok) {
      this.stats.skippedBudget++
      return
    }
    this.ledger.spend(agentId, day, 'reflect')
    this.inFlight.add(agentId)
    this.schedule(() => this.reflect(agentId).finally(() => this.afterJob(agentId)))
  }

  /** Run a backend call with a hard timeout the backend can't ignore. */
  private withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ac = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort()
        reject(Object.assign(new Error(`turn exceeded ${this.timeoutMs} ms`), { name: 'TimeoutError' }))
      }, this.timeoutMs)
    })
    return Promise.race([fn(ac.signal), timeout]).finally(() => clearTimeout(timer))
  }

  private async reflect(agentId: AgentId): Promise<void> {
    const { store, worldId } = this.opts
    const backend = this.opts.agents[agentId]!
    const state = this.opts.getState()
    const since = this.lastReflectTick.get(agentId) ?? store.lastReflectTick(worldId, agentId) ?? 0
    const packet = buildReflectionPacket(store, state, agentId, since, this.snapshots.get(agentId) ?? null)
    const started = Date.now()
    const trigger: Trigger = { kind: 'routine_check', detail: `End of Day ${packet.day}: reflection`, urgency: 0.6, tick: state.tick }
    const record: TurnRecord = { agentId, kind: 'reflect', trigger, status: 'error', tickAsked: state.tick, tickAnswered: state.tick, submittedIntentIds: [], latencyMs: 0 }
    let raw: string | null = null
    let tokens: { p?: number; c?: number } = {}
    this.stats.reflections++
    try {
      const reply = await this.withTimeout((signal) => backend.reflect(packet, signal))
      raw = reply.raw
      tokens = { p: reply.promptTokens, c: reply.completionTokens }
      const parsed = parseReflection(reply.json, packet, agentId)
      const now = this.opts.getState()
      record.tickAnswered = now.tick
      record.reflection = parsed
      record.notes = applyReflection(store, worldId, agentId, parsed, now.tick, packet.day)
      record.status = 'ok'
      this.lastReflectTick.set(agentId, state.tick)
      this.snapshots.set(agentId, Object.fromEntries(this.enabledAgentsAll().filter((o) => o !== agentId).map((o) => {
        const e = state.edges[`${agentId}>${o}`]!
        return [o, { trust: e.trust, warmth: e.warmth, tension: e.tension }]
      })))
      this.stats.violations += parsed.violations.length
    } catch (err) {
      const e = err as Error & { raw?: string }
      raw ??= e.raw ?? null
      record.error = e.message
      record.status = e.name === 'TimeoutError' ? 'timeout' : /response|JSON|envelope|unparseable/i.test(e.message) ? 'invalid' : 'error'
      this.stats.errors++
    }
    record.latencyMs = Date.now() - started
    store.logTurn({
      worldId,
      agentId,
      tick: record.tickAsked,
      kind: 'reflect',
      backend: backend.name,
      triggerJson: JSON.stringify(trigger),
      packetJson: JSON.stringify(packet),
      responseJson: raw,
      status: record.status,
      error: record.error ?? (record.reflection?.violations.length ? 'violations: ' + record.reflection.violations.join(' | ') : null),
      latencyMs: record.latencyMs,
      promptTokens: tokens.p ?? null,
      completionTokens: tokens.c ?? null,
    })
    this.opts.onTurn?.(record)
  }

  private enabledAgentsAll(): AgentId[] {
    return CAST.map((c) => c.id)
  }

  private schedule(job: () => Promise<void>): void {
    const run = () => {
      this.active++
      job().finally(() => {
        this.active--
        this.queue.shift()?.()
        this.checkIdle()
      })
    }
    if (this.active < this.concurrency) run()
    else this.queue.push(run)
  }

  private checkIdle(): void {
    if (this.active === 0 && this.queue.length === 0 && this.inFlight.size === 0) {
      const waiters = this.idleWaiters
      this.idleWaiters = []
      for (const w of waiters) w()
    }
  }

  /** Resolves when no turns are running or queued. For lockstep runs and tests. */
  idle(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0 && this.inFlight.size === 0) return Promise.resolve()
    return new Promise((r) => this.idleWaiters.push(r))
  }

  private async turn(agentId: AgentId, trigger: Trigger): Promise<void> {
    const { store, worldId } = this.opts
    const backend = this.opts.agents[agentId]!
    const asked = this.opts.getState()
    const started = Date.now()
    const packet = buildContextPacket(store, asked, agentId, trigger)
    const record: TurnRecord = { agentId, kind: 'turn', trigger, status: 'error', tickAsked: asked.tick, tickAnswered: asked.tick, submittedIntentIds: [], latencyMs: 0 }
    let raw: string | null = null
    let tokens: { p?: number; c?: number } = {}
    this.stats.turns++

    try {
      // Enforce the timeout ourselves: a backend that ignores the signal must not hold a turn slot forever.
      const reply = await this.withTimeout((signal) => backend.turn(packet, signal))
      raw = reply.raw
      tokens = { p: reply.promptTokens, c: reply.completionTokens }
      // The world moved on while they were thinking. Their intents start from NOW.
      const now = this.opts.getState()
      record.tickAnswered = now.tick
      const goalIds = store.agentGoals(worldId, agentId).map((g) => g.id)
      const parsed = parseResponse(reply.json, now.tick, goalIds)
      record.parsed = parsed
      record.submittedIntentIds = this.apply(agentId, parsed, now.tick)
      record.status = 'ok'
      this.stats.ok++
      this.stats.violations += parsed.violations.length
    } catch (err) {
      const e = err as Error & { raw?: string }
      raw ??= e.raw ?? null
      record.error = e.message
      record.status = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : /response|JSON|envelope|unparseable/i.test(e.message) ? 'invalid' : 'error'
      if (record.status === 'invalid') this.stats.invalid++
      else this.stats.errors++
    }

    record.latencyMs = Date.now() - started
    store.logTurn({
      worldId,
      agentId,
      tick: record.tickAsked,
      kind: 'turn',
      backend: backend.name,
      triggerJson: JSON.stringify(trigger),
      packetJson: JSON.stringify(packet),
      responseJson: raw,
      status: record.status,
      error: record.error ?? (record.parsed?.violations.length ? 'violations: ' + record.parsed.violations.join(' | ') : null),
      latencyMs: record.latencyMs,
      promptTokens: tokens.p ?? null,
      completionTokens: tokens.c ?? null,
    })
    this.opts.onTurn?.(record)
  }

  /**
   * Turn a parsed response into effects. The ONLY world-facing effect is
   * submitting proposals; everything else is agent-owned annotation.
   */
  private apply(agentId: AgentId, r: ParsedResponse, tick: number): string[] {
    const { store, worldId } = this.opts
    const ids: string[] = []
    const submit = (p: Omit<IntentProposal, 'agentId' | 'source'>) => {
      const id = `a.${agentId}.${tick}.${randomUUID().slice(0, 8)}`
      store.submitIntent(worldId, { ...p, agentId, source: 'agent' }, tick, id)
      ids.push(id)
    }
    for (const i of r.intents) submit(i)
    if (r.dialogue) {
      submit({
        kind: 'speak',
        target: r.dialogue.to,
        say: r.dialogue.say,
        register: r.dialogue.register,
        reason: 'said aloud',
        weight: 0.8,
        expiresTick: tick + 3,
        ...(r.dialogue.reveals ? { fact: r.dialogue.reveals } : {}),
      })
    }
    for (const m of r.memoryWrites) store.addAgentMemory(worldId, agentId, tick, m.text, m.importance, m.private)
    if (r.mood) store.setAgentMood(worldId, agentId, r.mood)
    for (const g of r.goalUpdates) {
      const own = store.agentGoals(worldId, agentId).find((x) => x.id === g.id)
      if (own?.origin === 'agent') store.upsertAgentGoal(worldId, agentId, { id: g.id, text: own.text, weight: own.weight, status: 'active', note: g.note ?? own.note ?? undefined, perceived: g.progress }, tick)
      else store.setGoalBelief(worldId, agentId, g.id, g.progress, g.note)
    }
    return ids
  }
}
