import { z } from 'zod'
import type { AgentId, WorldState } from '../core/types.js'
import { MOODS, type Mood } from '../core/types.js'
import { formatTime, timeOf } from '../core/clock.js'
import { CAST, castMember, edgeSeed, isAgent } from '../world/cast.js'
import { factDef } from '../world/facts.js'
import type { WorldStore } from '../db/store.js'
import type { ContextPacket } from './packet.js'

/**
 * The reflection pass (spec §4.4): once per in-world day, before sleep, a
 * deeper turn over the whole day. This is where characters change: goals
 * are revised, opinions form, the day is consolidated into the semantic
 * tier, low-value memories are let go, and a private journal is written.
 *
 * Like every agent output, nothing here touches the deterministic world.
 */

export const EPISODIC_CAP = 200
export const SEMANTIC_CAP = 50
export const MAX_AGENT_GOALS = 3
export const MAX_JOURNAL_CHARS = 1800

export interface EdgeSnapshot {
  trust: number
  warmth: number
  tension: number
}

export interface ReflectionPacket {
  agent: ContextPacket['agent']
  day: number
  self_state: { location: string; health: number; stress: number; mood: string }
  goals: { id: string; text: string; weight: number; yours: boolean; progress: number | null; note: string | null }[]
  todays_events: { when: string; type: string; text: string }[]
  todays_memories: { id: number; when: string; text: string; importance: number }[]
  relationships: { id: string; name: string; pronouns: string; trust: number; warmth: number; tension: number; resentment: number; change_today: string | null; your_view: string | null }[]
  knowledge: { id: string; text: string }[]
  beliefs: { id: number; text: string; weight: number }[]
  recent_days: string[]
  last_journal: string | null
}

/** The in-world day a reflection at `tick` looks back on: small hours belong to the day before. */
export function reflectionDay(tick: number): number {
  return timeOf(Math.max(0, tick - 6)).day
}

export function reflectionHour(agentId: AgentId): number {
  const sleep = castMember(agentId).routine.find((b) => b.asleep)
  return sleep ? (sleep.from + 23) % 24 : 23 // the hour before they sleep
}

export function buildReflectionPacket(store: WorldStore, state: WorldState, agentId: AgentId, since: number, snapshot: Record<AgentId, EdgeSnapshot> | null): ReflectionPacket {
  const c = castMember(agentId)
  const a = state.agents[agentId]!
  const semantic = store.semantic(state.id, agentId, 80)
  const opinions = new Map(semantic.filter((r) => r.kind === 'opinion' && r.subjectId).map((r) => [r.subjectId!, r.text]))
  const lastJournal = store.journals(state.id, agentId).at(-1)

  const relationships = CAST.filter((o) => o.id !== agentId).map((o) => {
    const e = state.edges[`${agentId}>${o.id}`]!
    const before = snapshot?.[o.id] ?? edgeSeed(agentId, o.id)
    const d = (k: keyof EdgeSnapshot) => Math.round(e[k] - before[k])
    const parts = (['trust', 'warmth', 'tension'] as const).map((k) => [k, d(k)] as const).filter(([, v]) => Math.abs(v) >= 3)
    return {
      id: o.id,
      name: o.name,
      pronouns: o.pronouns,
      trust: Math.round(e.trust),
      warmth: Math.round(e.warmth),
      tension: Math.round(e.tension),
      resentment: Math.round(e.grudge),
      change_today: parts.length ? parts.map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join(', ') : null,
      your_view: opinions.get(o.id) ?? null,
    }
  })

  return {
    agent: {
      id: c.id,
      name: c.name,
      pronouns: c.pronouns,
      role: c.role,
      personality: c.personality,
      voice: c.voice,
      backstory: c.backstory,
      goals: [],
      secret: c.secret.text,
      unspoken_want: c.unspoken,
      traits: { ...c.traits },
    },
    day: reflectionDay(state.tick),
    self_state: { location: a.locationId, health: Math.round(a.health), stress: Math.round(a.stress), mood: store.agentMood(state.id, agentId) ?? a.mood },
    goals: store.agentGoals(state.id, agentId).map((g) => ({ id: g.id, text: g.text, weight: g.weight, yours: g.origin === 'agent', progress: g.perceivedProgress, note: g.note })),
    todays_events: store
      .visibleEvents(state.id, agentId, { sinceTick: since + 1, limit: 40 })
      .filter((e) => e.type !== 'station')
      .reverse()
      .map((e) => ({ when: formatTime(e.tick), type: e.outcome ?? e.type, text: e.text })),
    todays_memories: store.episodicSince(state.id, agentId, since + 1, 50).map((m) => ({ id: m.id, when: formatTime(m.tick), text: m.text, importance: m.importance })),
    relationships,
    knowledge: Object.keys(state.knowledge[agentId] ?? {}).map((id) => ({ id, text: factDef(id).text })),
    beliefs: semantic.filter((r) => r.kind === 'belief').map((r) => ({ id: r.id, text: r.text, weight: r.weight })),
    recent_days: semantic
      .filter((r) => r.kind === 'summary')
      .sort((x, y) => y.updatedTick - x.updatedTick)
      .slice(0, 5)
      .reverse()
      .map((r) => r.text),
    last_journal: lastJournal ? lastJournal.text.slice(0, 600) : null,
  }
}

export function reflectionSystemPrompt(p: ReflectionPacket): string {
  return `You are ${p.agent.name}, ${p.agent.role}, aboard Fortitude — a two-hundred-year-old ring station in Earth orbit that is slowly failing. You are a person, not an assistant or narrator.

${p.agent.personality}
${p.agent.backstory}
How you speak and think: ${p.agent.voice}
Your secret: ${p.agent.secret}
What you want and will not say aloud: ${p.agent.unspoken_want}

It is the end of Day ${p.day}. You are alone with your thoughts before sleep. Look back over the day — only what is in your context; you know nothing else — and take stock:
- Which of your goals still matter? You may add up to ${MAX_AGENT_GOALS} goals of your own, revise them, or drop them. Goals marked yours:false were always part of you: you can only annotate them (note, how close you think you are).
- What do you now think of the people who mattered today? Opinions are yours and may be unfair or wrong.
- What do you believe now that you didn't this morning? Revise or drop old beliefs that no longer hold.
- Which of today's memories are worth keeping, and which can go? Summarise the day in one or two sentences, in your own words.
- Write a private journal entry, first person, in your own voice. Nobody is meant to read it. Be honest in it in a way you are not out loud. Under 200 words. No headings.

Never mention being an AI, a model, a game, or a simulation.

Reply with ONLY a JSON object:
{
  "goals": [ { "id": "existing id, or a new short-id for a new goal of yours", "text": "...", "weight": 0.0-1.0, "status": "active|dropped", "progress": 0.0-1.0, "note": "..." } ],
  "opinions": [ { "agentId": "person-id", "view": "one sentence: what you now think of them", "stance": -1.0 to 1.0 } ],
  "beliefs": [ { "id": existing belief id or null, "text": "...", "weight": 0.0-1.0 } ],
  "drop_beliefs": [ belief ids ],
  "memory_consolidation": { "forget": [memory ids], "keep": [memory ids], "summarise": "Day ${p.day}: ..." },
  "journal": "...",
  "mood": one of ${MOODS.map((m) => `"${m}"`).join(', ')}
}
At most 5 opinions and 5 beliefs. Only mention goals you are changing.`
}

export function reflectionUserPrompt(p: ReflectionPacket): string {
  const { agent: _agent, ...rest } = p
  return `End of Day ${p.day}.\n\n${JSON.stringify(rest, null, 1)}`
}

// ─── Parsing ─────────────────────────────────────────────────────────────

const Goal = z.object({
  id: z.string().trim().min(1).max(60),
  text: z.string().trim().min(1).max(200).optional(),
  weight: z.coerce.number().default(0.5),
  status: z.enum(['active', 'dropped']).default('active'),
  progress: z.coerce.number().optional().nullable(),
  note: z.string().trim().max(300).optional().nullable(),
})
const Opinion = z.object({ agentId: z.string(), view: z.string().trim().min(1).max(300), stance: z.coerce.number().default(0) })
const Belief = z.object({ id: z.coerce.number().int().optional().nullable(), text: z.string().trim().min(1).max(300), weight: z.coerce.number().default(0.5) })
const Envelope = z.object({
  goals: z.array(z.unknown()).default([]),
  opinions: z.array(z.unknown()).default([]),
  beliefs: z.array(z.unknown()).default([]),
  drop_beliefs: z.array(z.coerce.number()).default([]),
  memory_consolidation: z
    .object({
      forget: z.array(z.coerce.number()).default([]),
      keep: z.array(z.coerce.number()).default([]),
      summarise: z.string().trim().max(500).optional().nullable(),
    })
    .default({ forget: [], keep: [] }),
  journal: z.string().optional().nullable(),
  mood: z.string().optional().nullable(),
})

export interface ParsedReflection {
  goals: { id: string; text?: string; weight: number; status: 'active' | 'dropped'; progress?: number; note?: string }[]
  opinions: { agentId: AgentId; view: string; stance: number }[]
  beliefs: { id?: number; text: string; weight: number }[]
  dropBeliefs: number[]
  forget: number[]
  keep: number[]
  summary: string | null
  journal: string | null
  mood: Mood | null
  violations: string[]
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function parseReflection(raw: unknown, p: ReflectionPacket, self: AgentId): ParsedReflection {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('reflection response must be a JSON object')
  const env = Envelope.safeParse(raw)
  if (!env.success) throw new Error('bad reflection envelope: ' + env.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  const e = env.data
  const violations: string[] = []
  const shownMemories = new Set(p.todays_memories.map((m) => m.id))
  const shownBeliefs = new Set(p.beliefs.map((b) => b.id))

  const goals: ParsedReflection['goals'] = []
  for (const g of e.goals) {
    const r = Goal.safeParse(g)
    if (!r.success) {
      violations.push('goal dropped: malformed')
      continue
    }
    const v = r.data
    const id = v.id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40)
    goals.push({
      id,
      ...(v.text ? { text: v.text } : {}),
      weight: clamp(v.weight, 0, 1),
      status: v.status,
      ...(typeof v.progress === 'number' ? { progress: clamp(v.progress, 0, 1) } : {}),
      ...(v.note ? { note: v.note } : {}),
    })
  }

  const opinions: ParsedReflection['opinions'] = []
  for (const o of e.opinions.slice(0, 5)) {
    const r = Opinion.safeParse(o)
    if (!r.success) continue
    if (!isAgent(r.data.agentId) || r.data.agentId === self) {
      violations.push(`opinion about "${r.data.agentId}" dropped`)
      continue
    }
    opinions.push({ agentId: r.data.agentId, view: r.data.view, stance: clamp(r.data.stance, -1, 1) })
  }

  const beliefs: ParsedReflection['beliefs'] = []
  for (const b of e.beliefs.slice(0, 5)) {
    const r = Belief.safeParse(b)
    if (!r.success) continue
    const id = r.data.id ?? undefined
    if (id !== undefined && !shownBeliefs.has(id)) {
      violations.push(`belief id ${id} is not yours; added as new`)
      beliefs.push({ text: r.data.text, weight: clamp(r.data.weight, 0, 1) })
    } else beliefs.push({ ...(id !== undefined ? { id } : {}), text: r.data.text, weight: clamp(r.data.weight, 0, 1) })
  }

  // You can only forget or keep memories you were shown.
  const forget = e.memory_consolidation.forget.filter((id) => shownMemories.has(id))
  const keep = e.memory_consolidation.keep.filter((id) => shownMemories.has(id) && !forget.includes(id))
  if (forget.length !== e.memory_consolidation.forget.length) violations.push('ignored forget ids not shown')

  let mood: Mood | null = null
  if (e.mood && (MOODS as readonly string[]).includes(e.mood.toLowerCase())) mood = e.mood.toLowerCase() as Mood

  return {
    goals,
    opinions,
    beliefs,
    dropBeliefs: e.drop_beliefs.filter((id) => shownBeliefs.has(id)),
    forget,
    keep,
    summary: e.memory_consolidation.summarise?.trim() || null,
    journal: e.journal?.trim() ? e.journal.trim().slice(0, MAX_JOURNAL_CHARS) : null,
    mood,
    violations,
  }
}

/** Write a parsed reflection into the agent-owned tiers. */
export function applyReflection(store: WorldStore, worldId: string, agentId: AgentId, r: ParsedReflection, tick: number, day: number): string[] {
  const notes: string[] = []
  const authored = new Set([castMember(agentId).goal.id, ...(castMember(agentId).goals ?? []).map((g) => g.id)])
  let activeOwn = store.agentGoals(worldId, agentId).filter((g) => g.origin === 'agent').length
  for (const g of r.goals) {
    if (authored.has(g.id)) {
      store.setGoalBelief(worldId, agentId, g.id, g.progress, g.note)
      continue
    }
    const exists = store.agentGoals(worldId, agentId).some((x) => x.id === g.id)
    if (!exists && g.status === 'active') {
      if (activeOwn >= MAX_AGENT_GOALS || !g.text) {
        notes.push(`goal "${g.id}" not added`)
        continue
      }
      activeOwn++
    }
    if (exists && g.status === 'dropped') activeOwn--
    const res = store.upsertAgentGoal(worldId, agentId, { id: g.id, text: g.text ?? g.id, weight: g.weight, status: g.status, note: g.note, perceived: g.progress }, tick)
    notes.push(`goal ${g.id} ${res}${g.status === 'dropped' ? ' (dropped)' : ''}`)
  }
  for (const o of r.opinions) store.setOpinion(worldId, agentId, o.agentId, o.view, o.stance, tick)
  for (const b of r.beliefs) {
    if (b.id !== undefined) store.replaceBelief(worldId, agentId, b.id, b.text, b.weight, tick)
    else store.addSemantic(worldId, agentId, 'belief', b.text, b.weight, tick)
  }
  store.dropSemantic(worldId, agentId, r.dropBeliefs)
  const forgotten = store.forgetEpisodic(worldId, agentId, r.forget)
  store.reinforceEpisodic(worldId, agentId, r.keep)
  if (r.summary) store.addSemantic(worldId, agentId, 'summary', r.summary.startsWith('Day') ? r.summary : `Day ${day}: ${r.summary}`, 1, tick)
  if (r.journal) store.writeJournal(worldId, agentId, day, r.journal)
  if (r.mood) store.setAgentMood(worldId, agentId, r.mood)
  const pruned = store.pruneEpisodic(worldId, agentId, EPISODIC_CAP)
  store.pruneSemantic(worldId, agentId, SEMANTIC_CAP)
  notes.push(`forgot ${forgotten}, kept ${r.keep.length}, pruned ${pruned}`)
  return notes
}
