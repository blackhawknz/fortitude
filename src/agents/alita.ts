import { timeOf } from '../core/clock.js'
import type { AgentId } from '../core/types.js'
import type { WorldStore } from '../db/store.js'
import type { TickListener } from '../engine/engine.js'
import type { TickResult } from '../sim/tick.js'
import { CAST } from '../world/cast.js'
import type { AgentBackend, BackendReply } from './backend.js'
import type { ContextPacket } from './packet.js'
import { systemPrompt, userPrompt } from './prompt.js'
import { reflectionSystemPrompt, reflectionUserPrompt, type ReflectionPacket } from './reflection.js'
import { extractJson } from './response.js'

/**
 * The Alita adapter (spec §4.6, Phase 3).
 *
 * The Queen's turns are served by the external Alita system — same persona,
 * same memory store as home — through POST /agent/turn and /agent/reflect.
 * Fortitude still owns the response contract: it sends its own system and
 * user prompts; Alita adds her persona, what she knows about the user, and
 * her scoped memories of this world.
 *
 * Fallback is mandatory. If Alita is unreachable or errors, the turn is
 * served by the local model with a reduced packet, and a circuit breaker
 * stops every later turn paying the timeout. Her memories are mirrored to
 * her store through an outbox (AlitaMemorySync), so anything written while
 * she was down reconciles when she returns. The world never waits.
 */

export interface AlitaClientOptions {
  url: string
  token?: string
  /** Per-request timeout. */
  timeoutMs?: number
  /** After a failure, don't try Alita again for this long. */
  cooldownMs?: number
  now?: () => number
}

export interface AlitaHealth {
  up: boolean
  downUntil: number
  failures: number
  lastError: string | null
}

export class AlitaUnavailable extends Error {
  override name = 'AlitaUnavailable'
}

export class AlitaClient {
  readonly health: AlitaHealth = { up: true, downUntil: 0, failures: 0, lastError: null }
  private readonly now: () => number

  constructor(private readonly opts: AlitaClientOptions) {
    this.now = opts.now ?? Date.now
  }

  get url(): string {
    return this.opts.url.replace(/\/+$/, '')
  }

  /** Inside the cooldown after a failure: callers should go straight to fallback. */
  get coolingDown(): boolean {
    return this.now() < this.health.downUntil
  }

  private markDown(err: unknown): void {
    this.health.up = false
    this.health.failures++
    this.health.lastError = err instanceof Error ? err.message : String(err)
    this.health.downUntil = this.now() + (this.opts.cooldownMs ?? 30_000)
  }

  private markUp(): void {
    this.health.up = true
    this.health.downUntil = 0
    this.health.lastError = null
  }

  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.coolingDown) throw new AlitaUnavailable(`Alita unavailable (cooling down after: ${this.health.lastError})`)
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 30_000)
    try {
      const res = await fetch(this.url + path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (!res.ok) throw new Error(`Alita ${method} ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`)
      const json = (await res.json()) as T
      this.markUp()
      return json
    } catch (err) {
      this.markDown(err)
      throw err
    }
  }

  completion(kind: 'turn' | 'reflect', body: { scope: string; system: string; user: string; recall_query?: string; max_tokens?: number; temperature?: number }, signal?: AbortSignal) {
    return this.request<{ content: string; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string }>('POST', `/agent/${kind}`, body, signal)
  }

  writeMemory(body: { scope: string; content: string; external_ref: string; importance: number; category?: string }) {
    return this.request<{ status: string; id: number }>('POST', '/agent/memory', body)
  }

  readMemory(scope: string, limit = 24) {
    return this.request<{ memories: { id: number; content: string }[] }>('GET', `/agent/memory?scope=${encodeURIComponent(scope)}&limit=${limit}`)
  }

  retract(scope: string) {
    return this.request<{ retracted: number }>('POST', '/agent/memory/retract', { scope })
  }
}

export function alitaClientFromEnv(env = process.env): AlitaClient | null {
  if (!env.ALITA_URL) return null
  return new AlitaClient({
    url: env.ALITA_URL,
    token: env.ALITA_API_TOKEN || undefined,
    timeoutMs: Number(env.ALITA_TIMEOUT_MS ?? 30_000),
    cooldownMs: Number(env.ALITA_COOLDOWN_MS ?? 30_000),
  })
}

export const scopeFor = (worldId: string) => `fortitude:${worldId}`

/** The spec's "reduced context packet" for fallback turns: less history, same contract. */
export function reducePacket(p: ContextPacket): ContextPacket {
  return { ...p, recent_events: p.recent_events.slice(-8), private_memory: p.private_memory.slice(-8), recent_days: p.recent_days.slice(-2) }
}

export class AlitaBackend implements AgentBackend {
  readonly name = 'alita'
  fallbacks = 0
  served = 0

  constructor(
    private readonly client: AlitaClient,
    private readonly worldId: string,
    private readonly fallback: AgentBackend | null,
  ) {}

  private async viaAlita(kind: 'turn' | 'reflect', system: string, user: string, recall: string, maxTokens: number, signal?: AbortSignal): Promise<BackendReply> {
    const res = await this.client.completion(kind, { scope: scopeFor(this.worldId), system, user, recall_query: recall.slice(0, 1500), max_tokens: maxTokens }, signal)
    this.served++
    return { json: extractJson(res.content), raw: res.content, promptTokens: res.usage?.prompt_tokens, completionTokens: res.usage?.completion_tokens, backend: 'alita' }
  }

  private async degrade(err: unknown, run: (b: AgentBackend) => Promise<BackendReply>): Promise<BackendReply> {
    if (!this.fallback) throw err
    this.fallbacks++
    const reply = await run(this.fallback)
    return { ...reply, backend: `alita→${this.fallback.name}` }
  }

  async turn(packet: ContextPacket, signal?: AbortSignal): Promise<BackendReply> {
    try {
      if (this.client.coolingDown) throw new AlitaUnavailable('cooling down')
      return await this.viaAlita('turn', systemPrompt(packet), userPrompt(packet), `${packet.trigger.detail} ${packet.self_state.location.name}`, 900, signal)
    } catch (err) {
      return this.degrade(err, (b) => b.turn(reducePacket(packet), signal))
    }
  }

  async reflect(packet: ReflectionPacket, signal?: AbortSignal): Promise<BackendReply> {
    try {
      if (this.client.coolingDown) throw new AlitaUnavailable('cooling down')
      const recall = packet.todays_events.slice(-6).map((e) => e.text).join(' ')
      return await this.viaAlita('reflect', reflectionSystemPrompt(packet), reflectionUserPrompt(packet), recall, 2200, signal)
    } catch (err) {
      return this.degrade(err, (b) => b.reflect(packet, signal))
    }
  }
}

/**
 * Mirrors an agent's Fortitude memories into the Alita store. Runs after
 * ticks (phase 7, fire-and-forget), throttled; pushes the outbox oldest
 * first and stops at the first failure. Idempotent by external_ref, so a
 * crash between "sent" and "marked" just resends harmlessly.
 */
export class AlitaMemorySync implements TickListener {
  private busy: Promise<void> | null = null
  private lastRun = 0
  pushed = 0

  constructor(
    private readonly store: WorldStore,
    private readonly worldId: string,
    private readonly client: AlitaClient,
    private readonly opts: { agentId?: AgentId; minIntervalMs?: number; batch?: number; minImportance?: number; now?: () => number } = {},
  ) {}

  onTick(_r: TickResult): void {
    const now = (this.opts.now ?? Date.now)()
    if (this.busy || now - this.lastRun < (this.opts.minIntervalMs ?? 5_000) || this.client.coolingDown) return
    this.lastRun = now
    this.busy = this.flush()
      .then(() => undefined)
      .finally(() => {
        this.busy = null
      })
  }

  /** Push one batch. Returns how many were acknowledged. */
  async flush(): Promise<number> {
    const agentId = this.opts.agentId ?? 'alita'
    const rows = this.store.unsyncedMemories(this.worldId, agentId, this.opts.minImportance ?? 3, this.opts.batch ?? 20)
    let n = 0
    for (const m of rows) {
      const ref = `${scopeFor(this.worldId)}:${m.tick}:${agentId}:${m.kind === 'summary' ? 's' : 'e'}${m.id}`
      const content = m.kind === 'summary' ? m.text : `Day ${timeOf(m.tick).day}: ${m.text}`
      try {
        await this.client.writeMemory({ scope: scopeFor(this.worldId), content, external_ref: ref, importance: m.importance, category: 'event' })
      } catch {
        break // down: keep the backlog for later
      }
      this.store.markSynced(this.worldId, m.kind, m.id, ref)
      n++
    }
    this.pushed += n
    return n
  }

  /** Drain everything that can be drained now (tests, shutdown). */
  async drain(): Promise<number> {
    await this.busy
    let total = 0
    for (;;) {
      const n = await this.flush()
      total += n
      if (n === 0) return total
    }
  }

  idle(): Promise<void> {
    return this.busy ?? Promise.resolve()
  }
}

/** Build per-agent backends: the Queen via Alita (falling back to local), everyone else local. */
export function castBackends(local: AgentBackend, alita: AlitaBackend | null, only?: readonly AgentId[]): Record<AgentId, AgentBackend> {
  const out: Record<AgentId, AgentBackend> = {}
  for (const c of CAST) {
    if (only && !only.includes(c.id)) continue
    if (c.backend === 'none') continue // the player is never LLM-driven
    out[c.id] = c.backend === 'alita' && alita ? alita : local
  }
  return out
}
