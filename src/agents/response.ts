import { z } from 'zod'
import { INTENT_KINDS, MOODS, type IntentProposal, type Mood, type Tick } from '../core/types.js'
import { MAX_INTENT_HORIZON, MAX_SAY_CHARS } from '../sim/intents.js'

/**
 * The structured response an agent turn must return (spec §4.3).
 * Never free text. Parsing is item-tolerant: one bad intent is dropped with a
 * recorded violation; it doesn't throw away the whole turn.
 */

export const MAX_INTENTS_PER_TURN = 3
export const MAX_MEMORY_WRITES = 3
export const MAX_MEMORY_CHARS = 300
export const DEFAULT_INTENT_HOURS = 6

const REGISTERS = ['open', 'guarded', 'warm', 'cold', 'formal'] as const

const IntentSchema = z.object({
  kind: z.enum(INTENT_KINDS),
  target: z.string().trim().min(1).optional().nullable(),
  to: z.string().trim().min(1).optional().nullable(),
  reason: z.string().trim().max(400).default(''),
  // Out-of-range numbers are clamped during normalisation, not rejected.
  weight: z.coerce.number().refine(Number.isFinite).default(0.6),
  hours: z.coerce.number().refine(Number.isFinite).optional(),
  expiresTick: z.coerce.number().refine(Number.isFinite).optional(),
})

const DialogueSchema = z.object({
  say: z.string().trim().min(1),
  to: z.string().trim().min(1),
  register: z.enum(REGISTERS).default('open'),
})

const MemorySchema = z.object({
  text: z.string().trim().min(1),
  importance: z.coerce.number().int().min(1).max(5).default(3),
  private: z.boolean().default(true),
})

const GoalUpdateSchema = z.object({
  id: z.string(),
  progress: z.coerce.number().min(0).max(1).optional(),
  note: z.string().trim().max(300).optional(),
})

/** Top-level shape. Everything optional so a partially-good turn still counts. */
const EnvelopeSchema = z.object({
  intents: z.array(z.unknown()).default([]),
  dialogue: z.unknown().optional().nullable(),
  memory_writes: z.array(z.unknown()).default([]),
  mood: z.string().optional().nullable(),
  goal_updates: z.array(z.unknown()).default([]),
  reflection: z.unknown().optional().nullable(),
})

const ALLOWED_KEYS = new Set(['intents', 'dialogue', 'memory_writes', 'mood', 'goal_updates', 'reflection'])

export interface ParsedResponse {
  intents: Omit<IntentProposal, 'agentId' | 'source'>[]
  dialogue: { say: string; to: string; register: (typeof REGISTERS)[number] } | null
  memoryWrites: { text: string; importance: number; private: boolean }[]
  mood: Mood | null
  goalUpdates: { id: string; progress?: number; note?: string }[]
  /** Everything we dropped or corrected, and why. Logged with the turn. */
  violations: string[]
}

/** Extract a JSON object from model output: bare JSON, fenced, or the first {...} block. */
export function extractJson(raw: string): unknown {
  const text = raw.trim()
  const attempts = [text, text.replace(/^```(?:json)?\s*|\s*```$/g, '')]
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) attempts.push(text.slice(start, end + 1))
  for (const a of attempts) {
    try {
      return JSON.parse(a)
    } catch {
      /* next */
    }
  }
  throw new Error('response was not JSON')
}

/**
 * Validate and normalise. Throws only if the envelope itself is unusable;
 * individual bad items become violations.
 */
export function parseResponse(raw: unknown, nowTick: Tick, ownGoalIds: readonly string[]): ParsedResponse {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('response must be a JSON object')
  const violations: string[] = []
  for (const k of Object.keys(raw)) if (!ALLOWED_KEYS.has(k)) violations.push(`ignored field "${k}" — agents cannot set it`)

  const env = EnvelopeSchema.safeParse(raw)
  if (!env.success) throw new Error('bad response envelope: ' + env.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  const e = env.data

  const intents: ParsedResponse['intents'] = []
  e.intents.forEach((item, idx) => {
    const r = IntentSchema.safeParse(item)
    if (!r.success) {
      violations.push(`intent[${idx}] dropped: ${r.error.issues.map((i) => `${i.path.join('.') || 'value'} ${i.message}`).join('; ')}`)
      return
    }
    if (intents.length >= MAX_INTENTS_PER_TURN) {
      violations.push(`intent[${idx}] dropped: at most ${MAX_INTENTS_PER_TURN} intents per turn`)
      return
    }
    const v = r.data
    const hours = v.hours ?? (v.expiresTick !== undefined ? v.expiresTick - nowTick : DEFAULT_INTENT_HOURS)
    const clampedHours = Math.max(1, Math.min(MAX_INTENT_HORIZON, Math.round(hours)))
    if (clampedHours !== hours) violations.push(`intent[${idx}] horizon clamped to ${clampedHours}h`)
    intents.push({
      kind: v.kind,
      target: v.target ?? undefined,
      to: v.to ?? undefined,
      reason: v.reason.slice(0, 200),
      weight: Math.max(0, Math.min(1, v.weight)),
      expiresTick: nowTick + clampedHours,
    })
  })

  let dialogue: ParsedResponse['dialogue'] = null
  if (e.dialogue) {
    const r = DialogueSchema.safeParse(e.dialogue)
    if (r.success) {
      dialogue = { ...r.data, say: r.data.say.slice(0, MAX_SAY_CHARS) }
      if (r.data.say.length > MAX_SAY_CHARS) violations.push(`dialogue truncated to ${MAX_SAY_CHARS} chars`)
    } else violations.push('dialogue dropped: ' + r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '))
  }

  const memoryWrites: ParsedResponse['memoryWrites'] = []
  e.memory_writes.forEach((item, idx) => {
    const r = MemorySchema.safeParse(item)
    if (!r.success || memoryWrites.length >= MAX_MEMORY_WRITES) {
      violations.push(`memory_writes[${idx}] dropped`)
      return
    }
    memoryWrites.push({ ...r.data, text: r.data.text.slice(0, MAX_MEMORY_CHARS) })
  })

  let mood: Mood | null = null
  if (e.mood) {
    const m = e.mood.toLowerCase().trim()
    if ((MOODS as readonly string[]).includes(m)) mood = m as Mood
    else violations.push(`mood "${e.mood}" is not one of ${MOODS.join(', ')}`)
  }

  const goalUpdates: ParsedResponse['goalUpdates'] = []
  e.goal_updates.forEach((item, idx) => {
    const r = GoalUpdateSchema.safeParse(item)
    if (!r.success) return void violations.push(`goal_updates[${idx}] dropped`)
    if (!ownGoalIds.includes(r.data.id)) return void violations.push(`goal_updates[${idx}] dropped: "${r.data.id}" is not your goal`)
    goalUpdates.push(r.data)
  })

  if (e.reflection) violations.push('reflection ignored outside a reflection pass')

  return { intents, dialogue, memoryWrites, mood, goalUpdates, violations }
}
