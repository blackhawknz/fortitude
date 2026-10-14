import { randomUUID } from 'node:crypto'
import type { AgentId, IntentKind, IntentProposal, SimEvent } from '../core/types.js'
import { INTENT_KINDS } from '../core/types.js'
import { formatTime, timeOf } from '../core/clock.js'
import { CAST, castMember, isAgent, PLAYER_ID } from '../world/cast.js'
import { LOCATIONS, isLocation, locationDef } from '../world/locations.js'
import { factVersion } from '../world/facts.js'
import { RELATIONSHIP_LABEL } from '../sim/relationships.js'
import { canEnter, validateIntent } from '../sim/intents.js'
import type { Engine } from '../engine/engine.js'
import type { WorldStore } from '../db/store.js'
import type { AgentBackend } from '../agents/backend.js'
import { buildContextPacket } from '../agents/packet.js'
import { parseResponse } from '../agents/response.js'
import { applyResponse } from '../agents/runtime.js'

/**
 * The player's door into the world (spec §7).
 *
 * The player is a character with a body: one place at a time, limited
 * perception, relationships like anyone else. Everything here is read
 * through the player's own visibility — the journal is built from
 * event_visibility rows for the player, never from the god's-eye log.
 *
 * Conversation is real time: the player speaks, the addressed resident
 * answers immediately in their own voice. What the conversation CHANGES —
 * facts revealed, intents formed — is submitted as intents and adjudicated
 * on the next tick, like everything else. The words are immediate; the
 * consequences keep the world's clock.
 */

export interface JournalEntry {
  id: string
  tick: number
  when: string
  type: string
  outcome?: string
  place?: string
  text: string
  /** You were one of the parties (not just present). */
  involved: boolean
  /** Only you know this happened (as far as you know). */
  privateToYou: boolean
}

export interface PlayerView {
  world: { name: string; tick: number; day: number; hour: number; time: string; boardHull: number; morale: number; nextTickInMs: number; tickMs: number }
  you: { name: string; location: { id: string; name: string; description: string }; activity: string; asleep: boolean; health: number; stress: number; mood: string; inventory: string[] }
  here: { id: string; name: string; role: string; pronouns: string; activity: string; asleep: boolean; relationship: string }[]
  places: { id: string; name: string; open: boolean; here: boolean }[]
  knows: { id: string; text: string; how: string }[]
  intents: { id: string; kind: string; target?: string; to?: string; until: string }[]
  /** Actions you've chosen that the world hasn't got to yet (they happen at the next tick). */
  pending: { kind: string; target?: string; to?: string; label: string; at: string }[]
  people: { id: string; name: string; role: string; relationship: string; met: boolean }[]
}

export type PlayerAction = { kind: Exclude<IntentKind, 'speak'>; to?: string; target?: string; fact?: string; hours?: number }

export interface SayResult {
  ok: boolean
  error?: string
  from?: AgentId
  reply?: string | null
  register?: string
  /** A fact they chose to tell you — lands in your journal at the next tick. */
  revealed?: boolean
  note?: string
}

// A move means "go there and stay": it stands for half a day unless you choose something else.
const DEFAULT_HOURS: Partial<Record<IntentKind, number>> = { move: 12, investigate: 2, observe: 2, work: 4, rest: 6, seek: 4, avoid: 8, confront: 4, confide: 4, ally: 6, withhold: 8 }

export interface PlayerServiceOptions {
  store: WorldStore
  engine: Engine
  worldId: string
  /** Backends for residents (the Queen may be served by Alita). */
  backends: Partial<Record<AgentId, AgentBackend>>
  chatPerAgentPerHour?: number
  chatTimeoutMs?: number
  now?: () => number
}

export class PlayerService {
  private transcripts = new Map<AgentId, { speaker: string; line: string; tick: number }[]>()
  private chatLog = new Map<AgentId, number[]>()
  private seq = 0
  private now: () => number

  constructor(private readonly opts: PlayerServiceOptions) {
    this.now = opts.now ?? Date.now
  }

  private get state() {
    return this.opts.engine.state
  }

  get name(): string {
    return castMember(PLAYER_ID).name
  }

  // ─── Perception ────────────────────────────────────────────────────

  view(): PlayerView {
    const s = this.state
    const me = s.agents[PLAYER_ID]!
    const loc = locationDef(me.locationId)
    const { day, hour } = timeOf(s.tick)
    const label = (id: string) => RELATIONSHIP_LABEL[s.edges[`${PLAYER_ID}>${id}`]!.type]
    return {
      world: { name: s.name, tick: s.tick, day, hour, time: formatTime(s.tick), boardHull: Math.round(s.station.reportedHull), morale: Math.round(s.station.morale), nextTickInMs: this.opts.engine.nextTickInMs(), tickMs: this.opts.engine.tickMs },
      you: {
        name: this.name,
        location: { id: loc.id, name: loc.name, description: loc.description },
        activity: me.activity,
        asleep: me.asleep,
        health: Math.round(me.health),
        stress: Math.round(me.stress),
        mood: me.mood,
        inventory: [...me.inventory],
      },
      here: CAST.filter((c) => !c.isPlayer && s.agents[c.id]!.alive && s.agents[c.id]!.locationId === me.locationId).map((c) => ({
        id: c.id,
        name: c.name,
        role: c.role,
        pronouns: c.pronouns,
        activity: s.agents[c.id]!.activity,
        asleep: s.agents[c.id]!.asleep,
        relationship: label(c.id),
      })),
      places: LOCATIONS.map((l) => ({ id: l.id, name: l.name, open: canEnter(s, PLAYER_ID, l.id, s.tick) === null, here: l.id === me.locationId })),
      knows: Object.values(s.knowledge[PLAYER_ID] ?? {})
        .sort((a, b) => a.tick - b.tick)
        .map((k) => ({ id: k.fact, text: factVersion(k.fact, k.version ?? 0).text, how: describeSource(k.source) + ((k.hops ?? 0) > 1 ? ' � second-hand at best' : '') })),
      intents: s.intents.filter((i) => i.agentId === PLAYER_ID && i.source === 'player').map((i) => ({ id: i.id, kind: i.kind, target: i.target, to: i.to, until: formatTime(i.expiresTick) })),
      pending: this.opts.store
        .pendingIntents(this.opts.worldId)
        .filter((i) => i.agentId === PLAYER_ID && i.kind !== 'speak')
        .map((i) => ({ kind: i.kind, target: i.target, to: i.to, label: describeAction(i.kind, i.to, i.target), at: formatTime(s.tick + 1) })),
      people: CAST.filter((c) => !c.isPlayer).map((c) => ({ id: c.id, name: c.name, role: c.role, relationship: label(c.id), met: s.edges[`${PLAYER_ID}>${c.id}`]!.encounters > 0 || c.id === 'alita' })),
    }
  }

  /**
   * What your character knows happened, newest first. Built ONLY from events
   * whose visibility includes the player (spec §7.3, enforced at the query layer).
   */
  journal(opts: { sinceTick?: number; limit?: number } = {}): JournalEntry[] {
    const rows = this.opts.store.visibleEvents(this.opts.worldId, PLAYER_ID, { sinceTick: opts.sinceTick, limit: opts.limit ?? 60 })
    return rows.filter((e) => e.type !== 'intent' || e.actorId === PLAYER_ID).map((e) => this.toEntry(e))
  }

  private toEntry(e: SimEvent): JournalEntry {
    return {
      id: e.id,
      tick: e.tick,
      when: formatTime(e.tick),
      type: e.type,
      outcome: e.outcome,
      place: e.locationId ? locationDef(e.locationId).name : undefined,
      text: secondPerson(e.text, this.name),
      involved: e.actorId === PLAYER_ID || e.targetId === PLAYER_ID,
      privateToYou: e.privateTo !== null && e.privateTo.length === 1 && e.privateTo[0] === PLAYER_ID,
    }
  }

  // ─── Acting ────────────────────────────────────────────────────────

  /** Queue an action. It is adjudicated at the next tick, like anyone's. */
  act(a: PlayerAction): { ok: boolean; error?: string; intentId?: string; appliesAt?: string } {
    if (!(INTENT_KINDS as readonly string[]).includes(a.kind) || (a.kind as string) === 'speak') return { ok: false, error: `unknown action "${a.kind}"` }
    const s = this.state
    const tick = s.tick
    const proposal: IntentProposal = {
      agentId: PLAYER_ID,
      kind: a.kind,
      ...(a.to ? { to: a.to } : {}),
      ...(a.target ? { target: a.target } : {}),
      ...(a.fact ? { fact: a.fact } : {}),
      reason: 'the player chose to',
      weight: 1,
      expiresTick: tick + 1 + Math.max(1, Math.min(24, a.hours ?? DEFAULT_HOURS[a.kind] ?? 3)),
      source: 'player',
    }
    // Pre-check against the present for immediate feedback; the tick re-checks for real.
    const v = validateIntent(s, proposal, tick + 1)
    if (!v.ok) return { ok: false, error: v.reason }
    // Sequence-ordered so that, within an hour, your latest choice is the one that counts.
    const id = `p.${pad(tick)}.${String(this.seq++).padStart(6, '0')}-${randomUUID().slice(0, 4)}`
    this.opts.store.submitIntent(this.opts.worldId, proposal, tick, id)
    return { ok: true, intentId: id, appliesAt: formatTime(tick + 1) }
  }

  private lastWait = 0

  /**
   * Let an hour pass now instead of waiting for the clock. It's a single-player
   * world, so hurrying time only changes how long you wait — the world still
   * advances one adjudicated hour, exactly as a scheduled tick would.
   */
  wait(): { ok: boolean; error?: string; time?: string } {
    const t = this.now()
    if (t - this.lastWait < 2_000) return { ok: false, error: 'Give it a moment.' }
    this.lastWait = t
    this.opts.engine.stepNow()
    return { ok: true, time: formatTime(this.state.tick) }
  }

  // ─── Talking ───────────────────────────────────────────────────────

  transcript(with_: AgentId): { speaker: string; line: string; when: string }[] {
    return (this.transcripts.get(with_) ?? []).map((l) => ({ speaker: l.speaker, line: l.line, when: formatTime(l.tick) }))
  }

  /**
   * Say something to someone here. They answer now; the consequences land
   * next tick. `reveals` lets the player tell them a fact the player knows.
   */
  async say(to: string, text: string, opts: { reveals?: string; register?: 'open' | 'guarded' | 'warm' | 'cold' | 'formal' } = {}): Promise<SayResult> {
    const s = this.state
    const tick = s.tick
    text = (text ?? '').trim().slice(0, 400)
    if (!text) return { ok: false, error: 'Say something.' }
    if (!isAgent(to) || to === PLAYER_ID) return { ok: false, error: 'Nobody by that name.' }
    const me = s.agents[PLAYER_ID]!
    const them = s.agents[to]!
    if (me.asleep) return { ok: false, error: 'You are asleep.' }
    if (them.locationId !== me.locationId) return { ok: false, error: `${castMember(to).name} isn't here.` }
    if (them.asleep) return { ok: false, error: `${castMember(to).name} is asleep.` }
    const reveals = opts.reveals && s.knowledge[PLAYER_ID]?.[opts.reveals] ? opts.reveals : undefined
    // Sequence-ordered ids: the reply sorts after the line it answers.
    const convId = `${String(this.seq++).padStart(6, '0')}-${randomUUID().slice(0, 4)}`

    // The player's words: a speak intent, adjudicated next tick (and any fact with it).
    this.opts.store.submitIntent(
      this.opts.worldId,
      { agentId: PLAYER_ID, kind: 'speak', target: to, say: text, register: opts.register ?? 'open', reason: 'said aloud', weight: 1, expiresTick: tick + 3, source: 'player', ...(reveals ? { fact: reveals } : {}) },
      tick,
      `t.${pad(tick)}.${convId}.0`,
    )
    const convo = this.transcripts.get(to) ?? this.seedTranscript(to)
    convo.push({ speaker: this.name, line: text, tick })
    this.transcripts.set(to, convo.slice(-14))

    if (them.asleep) return { ok: true, from: to, reply: null, note: `${castMember(to).name} is asleep.` }
    const backend = this.opts.backends[to]
    if (!backend) return { ok: true, from: to, reply: null, note: `${castMember(to).name} doesn't answer.` }
    if (!this.chatAllowed(to)) return { ok: true, from: to, reply: null, note: `${castMember(to).name} has had enough talking for now.` }

    const packet = buildContextPacket(this.opts.store, s, to, {
      kind: 'direct_address',
      detail: `${this.name} (${castMember(PLAYER_ID).role.toLowerCase()}) says to you: “${text}”${reveals ? ` — telling you: ${factVersion(reveals, s.knowledge[PLAYER_ID]![reveals]!.version ?? 0).text}` : ''}`,
      urgency: 1,
      tick,
    })
    packet.conversation = convo.slice(-12).map((l) => ({ speaker: l.speaker, line: l.line }))

    const started = Date.now()
    let raw: string | null = null
    let servedBy = backend.name
    try {
      const reply = await withTimeout(backend.turn(packet), this.opts.chatTimeoutMs ?? 45_000)
      raw = reply.raw
      servedBy = reply.backend
      const now = this.state
      const goalIds = this.opts.store.agentGoals(this.opts.worldId, to).map((g) => g.id)
      const parsed = parseResponse(reply.json, now.tick, goalIds)
      // A reply is to the person in front of them.
      if (parsed.dialogue) parsed.dialogue.to = PLAYER_ID
      applyResponse(this.opts.store, this.opts.worldId, to, parsed, now.tick, `t.${pad(tick)}.${convId}.1`)
      this.opts.store.logTurn({
        worldId: this.opts.worldId, agentId: to, tick, kind: 'chat', backend: servedBy, triggerJson: JSON.stringify(packet.trigger), packetJson: JSON.stringify(packet), responseJson: raw,
        status: 'ok', error: parsed.violations.length ? 'violations: ' + parsed.violations.join(' | ') : null, latencyMs: Date.now() - started, promptTokens: reply.promptTokens ?? null, completionTokens: reply.completionTokens ?? null,
      })
      const line = parsed.dialogue?.say ?? null
      if (line) {
        convo.push({ speaker: castMember(to).name, line, tick: now.tick })
        this.transcripts.set(to, convo.slice(-14))
      }
      return { ok: true, from: to, reply: line, register: parsed.dialogue?.register, revealed: !!parsed.dialogue?.reveals, ...(line ? {} : { note: `${castMember(to).name} says nothing.` }) }
    } catch (err) {
      this.opts.store.logTurn({
        worldId: this.opts.worldId, agentId: to, tick, kind: 'chat', backend: servedBy, triggerJson: JSON.stringify(packet.trigger), packetJson: JSON.stringify(packet), responseJson: raw,
        status: 'error', error: (err as Error).message, latencyMs: Date.now() - started, promptTokens: null, completionTokens: null,
      })
      return { ok: true, from: to, reply: null, note: `${castMember(to).name} looks at you, distracted, and doesn't answer.` }
    }
  }

  /** Start a transcript from what you've already heard between you (speech you witnessed). */
  private seedTranscript(to: AgentId): { speaker: string; line: string; tick: number }[] {
    const evs = this.opts.store
      .visibleEvents(this.opts.worldId, PLAYER_ID, { sinceTick: Math.max(0, this.state.tick - 12), limit: 40 })
      .filter((e) => e.type === 'speech' && ((e.actorId === to && e.targetId === PLAYER_ID) || (e.actorId === PLAYER_ID && e.targetId === to)))
      .reverse()
    return evs.map((e) => ({ speaker: castMember(e.actorId!).name, line: String(e.data?.say ?? ''), tick: e.tick }))
  }

  private chatAllowed(to: AgentId): boolean {
    const t = this.now()
    const log = (this.chatLog.get(to) ?? []).filter((x) => x > t - 3_600_000)
    if (log.length >= (this.opts.chatPerAgentPerHour ?? 60)) return false
    log.push(t)
    this.chatLog.set(to, log)
    return true
  }

  isPlace(id: string): boolean {
    return isLocation(id)
  }
}

function describeAction(kind: string, to?: string, target?: string): string {
  const place = to && isLocation(to) ? locationDef(to).name : to
  const who = target && isAgent(target) ? castMember(target).name : target
  switch (kind) {
    case 'move':
      return `Heading to ${place}`
    case 'investigate':
      return `About to search ${place}`
    case 'observe':
      return `Going to watch ${who ?? place}`
    case 'work':
      return 'Getting to work'
    case 'rest':
      return 'Going to rest'
    case 'seek':
      return `Looking for ${who}`
    case 'avoid':
      return `Keeping clear of ${who}`
    default:
      return `${kind}${who ? ' ' + who : ''}${place ? ' → ' + place : ''}`
  }
}

function describeSource(src: import('../core/types.js').KnowledgeSource): string {
  switch (src.kind) {
    case 'self':
      return 'you knew it'
    case 'told':
      return `${castMember(src.by).name} told you${src.confided ? ', in confidence' : ''} (${formatTime(src.tick)})`
    case 'overheard':
      return `you overheard ${castMember(src.from).name} (${formatTime(src.tick)})`
    case 'evidence':
      return `you found it at ${locationDef(src.locationId).name} (${formatTime(src.tick)})`
    case 'observed':
      return `you noticed it watching ${castMember(src.subject).name} (${formatTime(src.tick)})`
  }
}

/** Rewrite the sim's third-person narration for the player: their name becomes "you". */
export function secondPerson(text: string, name: string): string {
  // Only narration is rewritten; what people actually said (inside “…”) is left exactly as spoken.
  return text
    .split(/(“[^”]*”)/)
    .map((part, i, parts) => (part.startsWith('“') ? part : rewrite(part, name, i === 0 || /[.!?]\s*$/.test(parts[i - 1] ?? ''))))
    .join('')
}

function rewrite(text: string, name: string, sentenceStart: boolean): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let out = text
    .replace(new RegExp(`\\b${esc}'s\\b`, 'g'), 'your')
    .replace(new RegExp(`\\b${esc}\\b`, 'g'), 'you')
    .replace(/([.!?]\s+)you\b/g, (_m, p: string) => `${p}You`)
    // Verb agreement for the few present-tense templates.
    .replace(/\b(You|you) no longer thinks\b/g, '$1 no longer think')
  if (sentenceStart) out = out.replace(/^(\s*)you\b/, '$1You')
  return out
}

/** Zero-padded so ids sort correctly across digit boundaries (tick 9 < tick 10). */
const pad = (n: number) => String(n).padStart(8, '0')

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([p, new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`no answer within ${ms} ms`)), ms)))]).finally(() => clearTimeout(timer))
}
