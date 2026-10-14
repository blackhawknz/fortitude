import type { SimEvent } from '../core/types.js'
import { formatTime, timeOf } from '../core/clock.js'
import { castMember, PLAYER_ID } from '../world/cast.js'
import { locationDef } from '../world/locations.js'
import type { WorldStore } from '../db/store.js'
import type { Engine, TickListener } from '../engine/engine.js'
import type { TickResult } from '../sim/tick.js'
import { secondPerson } from './service.js'

/**
 * Presence (spec §7.3, Phase 5): the world kept going while you were away.
 *
 * Everything here is built from the player's own visibility rows — the
 * debrief can only contain what your character could know. It picks the
 * few things worth telling you, not the whole log.
 */

/** Anything that can turn a list into a paragraph. LocalBackend satisfies it. */
export interface TextModel {
  text(system: string, user: string, maxTokens?: number): Promise<string>
}

export type DebriefKind = 'learned' | 'sought' | 'involved' | 'incident' | 'feeling' | 'rumour'

export interface DebriefItem {
  kind: DebriefKind
  text: string
  when: string
  place?: string
  weight: number
  eventId: string
}

export interface Debrief {
  since: { tick: number; when: string }
  now: { tick: number; when: string }
  away: { hours: number; days: number }
  /** The few things worth telling you (spec §14: "three things worth telling them about"). */
  headline: DebriefItem[]
  /** Everything else of note, newest first. */
  more: DebriefItem[]
  station: { boardHullThen: number | null; boardHullNow: number | null; incidents: string[] }
  counts: { journal: number; involvingYou: number }
  prose?: string
}

function classify(e: SimEvent, name: string): DebriefItem | null {
  const place = e.locationId ? locationDef(e.locationId).name : undefined
  const base = { when: formatTime(e.tick), place, eventId: e.id, text: secondPerson(e.text, name) }
  const toYou = e.targetId === PLAYER_ID
  const byYou = e.actorId === PLAYER_ID
  const fact = typeof e.data?.fact === 'string'
  if (e.type === 'speech' && toYou) return { ...base, kind: fact ? 'learned' : 'sought', weight: fact ? 0.95 : 0.8 }
  if (e.type === 'speech') return null // your own lines / overheard talk: in the journal, not the debrief
  if (e.type === 'encounter') {
    if (fact && (toYou || (Array.isArray(e.data?.overheard) && (e.data!.overheard as string[]).includes(PLAYER_ID))))
      return { ...base, kind: e.data?.version ? 'rumour' : 'learned', weight: 0.9 }
    if (toYou || byYou) return e.magnitude >= 0.35 ? { ...base, kind: 'involved', weight: 0.4 + e.magnitude * 0.5 } : null
    return e.magnitude >= 0.7 ? { ...base, kind: 'involved', weight: 0.55 } : null // a scene you witnessed
  }
  if (e.type === 'discovery' && e.actorId === PLAYER_ID) return { ...base, kind: 'learned', weight: 0.9 }
  if (e.type === 'milestone' && e.actorId === PLAYER_ID) return { ...base, kind: 'feeling', weight: 0.45 }
  if (e.type === 'incident') return { ...base, kind: 'incident', weight: e.privateTo === null ? 0.5 + e.magnitude * 0.3 : 0.75 }
  if (e.type === 'betrayal_discovered' && e.actorId === PLAYER_ID) return { ...base, kind: 'learned', weight: 1 }
  return null
}

/** Top items with variety: at most one per kind first, then the strongest of the rest. */
function headline(items: DebriefItem[], n = 3): DebriefItem[] {
  const sorted = [...items].sort((a, b) => b.weight - a.weight || b.eventId.localeCompare(a.eventId))
  const out: DebriefItem[] = []
  const kinds = new Set<string>()
  for (const i of sorted) if (out.length < n && !kinds.has(i.kind)) (out.push(i), kinds.add(i.kind))
  for (const i of sorted) if (out.length < n && !out.includes(i)) out.push(i)
  return out
}

export function buildDebrief(store: WorldStore, worldId: string, nowTick: number, sinceTick?: number): Debrief {
  const since = sinceTick ?? store.presence(worldId).lastSeenTick
  const name = castMember(PLAYER_ID).name
  const events = store.visibleEvents(worldId, PLAYER_ID, { sinceTick: since + 1, untilTick: nowTick, limit: 1000 })
  const items = events.map((e) => classify(e, name)).filter((x): x is DebriefItem => !!x)
  const top = headline(items)
  const boards = events.filter((e) => e.type === 'station' && typeof e.data?.reportedHull === 'number').map((e) => e.data!.reportedHull as number)
  const hours = Math.max(0, nowTick - since)
  return {
    since: { tick: since, when: formatTime(since) },
    now: { tick: nowTick, when: formatTime(nowTick) },
    away: { hours, days: Math.round((hours / 24) * 10) / 10 },
    headline: top,
    more: items.filter((i) => !top.includes(i)).slice(0, 25),
    station: {
      boardHullThen: boards.length ? Math.round(boards.at(-1)!) : null,
      boardHullNow: boards.length ? Math.round(boards[0]!) : null,
      incidents: events.filter((e) => e.type === 'incident').map((e) => `${formatTime(e.tick)} — ${e.text}`).slice(0, 6),
    },
    counts: { journal: events.length, involvingYou: events.filter((e) => e.actorId === PLAYER_ID || e.targetId === PLAYER_ID).length },
  }
}

/**
 * Turn the headline into a few sentences. The model only sees the items,
 * so it can't narrate anything that didn't happen (spec P5).
 */
export async function narrateDebrief(model: TextModel, d: Debrief): Promise<string> {
  const lines = d.headline.map((i) => `- ${i.when}${i.place ? ' · ' + i.place : ''}: ${i.text}`).join('\n')
  return model.text(
    `You write the "while you were away" note for a player returning to Fortitude, a failing ring station. Second person, present perfect, plain and atmospheric, at most four sentences. Use ONLY the items given; do not add events, motives or facts. Keep quoted words exact. No headings, no lists.`,
    `They were away ${d.away.days >= 1 ? `${d.away.days} days` : `${d.away.hours} hours`} (in-world).\n${lines || '- Nothing touched them directly.'}${d.station.incidents.length ? `\nStation: ${d.station.incidents.join(' / ')}` : ''}`,
    220,
  )
}

// ─── Teasers ─────────────────────────────────────────────────────────────

export interface TeaserOptions {
  store: WorldStore
  engine: Engine
  worldId: string
  /** Is anyone looking right now? (e.g. an open SSE stream) */
  isPresent: () => boolean
  model?: TextModel | null
  webhookUrl?: string | null
  /** Real time away before the first teaser. Default 2 h. */
  minAwayMs?: number
  /** Real time between teasers. Default 6 h. */
  cooldownMs?: number
  now?: () => number
  onTeaser?: (text: string) => void
}

/**
 * Sends a teaser while the player is away: tantalising, never spoiling.
 * The text is built only from WHO and WHERE (never the content of a secret);
 * if a model is available it may phrase it, but it is never shown a fact.
 * Stored as an in-app notification; optionally POSTed to a webhook
 * (ntfy / Discord / Slack-style — open question 6: no SMTP).
 */
export class TeaserService implements TickListener {
  private busy = false

  constructor(private readonly opts: TeaserOptions) {}

  onTick(r: TickResult): void {
    if (this.busy) return
    const now = (this.opts.now ?? Date.now)()
    const { store, worldId } = this.opts
    if (this.opts.isPresent()) return // presence itself is recorded by the HTTP layer
    const p = store.presence(worldId)
    if (!p.lastSeenAt || now - p.lastSeenAt < (this.opts.minAwayMs ?? 2 * 3_600_000)) return
    if (p.lastTeaserAt && now - p.lastTeaserAt < (this.opts.cooldownMs ?? 6 * 3_600_000)) return
    const since = Math.max(p.lastSeenTick, p.lastTeaserTick ?? 0)
    const d = buildDebrief(store, worldId, r.state.tick, since)
    const hook = d.headline.find((i) => i.weight >= 0.75)
    if (!hook) return
    this.busy = true
    void this.send(hook, d, r.state.tick, now).finally(() => (this.busy = false))
  }

  /** Spoiler-free seed: who and where, never what. */
  static seed(i: DebriefItem): string {
    const where = i.place ? ` at ${i.place.replace(/^The /, 'the ')}` : ''
    const who = /^([A-Z][\wé]+(?: [A-Z][\w]+)?) /.exec(i.text)?.[1]
    switch (i.kind) {
      case 'sought':
        return who ? `${who} came looking for you${where}.` : `Someone came looking for you${where}.`
      case 'learned':
      case 'rumour':
        return who ? `${who} has something to tell you${where}.` : `There's talk${where} you'll want to hear.`
      case 'incident':
        return `Something happened${where} while you were away.`
      default:
        return `You were missed${where}.`
    }
  }

  private async send(hook: DebriefItem, d: Debrief, tick: number, now: number): Promise<void> {
    const { store, worldId } = this.opts
    const seed = TeaserService.seed(hook)
    let text = seed
    if (this.opts.model) {
      try {
        const out = await this.opts.model.text(
          'Write a one-line teaser (max 140 characters) inviting a player back to Fortitude, a failing ring station. Rephrase the given line atmospherically. Do NOT add any facts, names or events that are not in it. No quotes, no emoji.',
          seed,
          60,
        )
        if (out && out.length <= 200) text = out.replace(/^["“]|["”]$/g, '')
      } catch {
        /* the seed is fine */
      }
    }
    let delivered: string | null = null
    if (this.opts.webhookUrl) {
      try {
        const res = await fetch(this.opts.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text, world: worldId, day: timeOf(tick).day }) })
        if (res.ok) delivered = 'webhook'
      } catch {
        /* in-app only */
      }
    }
    store.addNotification(worldId, PLAYER_ID, tick, 'teaser', text, delivered)
    store.markTeaser(worldId, tick, now)
    this.opts.onTeaser?.(text)
    void d
  }
}
