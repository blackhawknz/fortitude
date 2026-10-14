import type { AgentId, OutcomeId } from '../core/types.js'
import { pick } from '../core/rng.js'
import { castMember } from '../world/cast.js'

/**
 * Deterministic event text. Third person, past tense, the sim's register.
 * This is the god's-eye log; information boundaries are applied by the
 * query layer, not by leaving things out here.
 */

const CAUSE_TOPICS: Record<string, readonly string[]> = {
  station: ['the hull figures', 'the Spine', 'the next shuttle', 'what breaks next'],
  court: ['the Queen', 'the morning court', 'who has her ear'],
  seal: ['the seal', 'the third bay', 'the alarm'],
  community: ['how people are holding up', 'the children’s table', 'old friends'],
  record: ['the old logs', 'how things used to be', 'what gets written down'],
  trade: ['prices', 'what came up on the last shuttle', 'the ration board'],
  succession: ['what happens after her', 'who would lead', 'the future'],
}

export function topicFor(a: AgentId, b: AgentId, seed: string, ...keys: (string | number)[]): string {
  const ca = castMember(a).causes
  const cb = castMember(b).causes
  const shared = ca.filter((x) => cb.includes(x))
  const pool = (shared.length ? shared : [...ca, ...cb]).flatMap((c) => CAUSE_TOPICS[c] ?? [])
  return pool.length ? pick(pool, seed, ...keys, 'topic') : 'nothing much'
}

const T: Record<Exclude<OutcomeId, 'nothing'>, readonly string[]> = {
  connect: [
    '{a} and {b} fell into easy talk about {topic}.',
    '{a} found {b} at {place} and they talked for a while. It went well.',
    '{a} made {b} laugh, briefly, about {topic}.',
    '{a} and {b} shared a quiet half hour at {place}.',
  ],
  cooperate: [
    '{a} and {b} worked a problem together at {place}.',
    '{a} and {b} put their heads together over {topic}.',
    '{a} lent {b} a hand, and {b} noticed.',
  ],
  disagree: [
    '{a} and {b} argued about {topic}.',
    '{a} said something about {topic} that {b} did not like.',
    '{a} and {b} disagreed, politely and then less politely, about {topic}.',
  ],
  confide: [
    '{a} took {b} aside and said, quietly: “{fact}”',
    'At {place}, {a} confided in {b}: “{fact}”',
  ],
  gossip: ['{a} passed something on to {b}: “{fact}”', '{a} leaned in and told {b}: “{fact}”'],
  withhold: [
    '{b} asked {a} about {topic}. {a} gave nothing away.',
    '{a} changed the subject when {b} came near {topic}.',
  ],
  confront: [
    '{a} confronted {b} about {topic}. Voices carried across {place}.',
    '{a} cornered {b} at {place} over {topic}. It did not go well.',
  ],
  repair: ['{a} and {b} cleared the air about {topic}.', '{a} apologised to {b}. {b} accepted, mostly.'],
  avoid: ['{a} saw {b} at {place} and left.', '{a} found a reason to be elsewhere when {b} arrived.'],
  observe: ['{a} watched {b} from across {place} without being noticed.', '{a} kept an eye on {b} at {place}.'],
  betray: ['{a} told {b} what {victim} had said in confidence: “{fact}”'],
  romance: ['Something shifted between {a} and {b} at {place}.'],
}

export interface NarrationSlots {
  a: AgentId
  b: AgentId
  place: string
  topic: string
  fact?: string
  victim?: AgentId
}

export function narrateEncounter(outcome: Exclude<OutcomeId, 'nothing'>, s: NarrationSlots, seed: string, ...keys: (string | number)[]): string {
  const tmpl = pick(T[outcome], seed, ...keys, 'tmpl')
  return tmpl
    .replaceAll('{a}', castMember(s.a).name)
    .replaceAll('{b}', castMember(s.b).name)
    .replaceAll('{victim}', s.victim ? castMember(s.victim).name : 'someone')
    .replaceAll('{place}', s.place)
    .replaceAll('{topic}', s.topic)
    .replaceAll('{fact}', s.fact ?? '…')
}

/** First-person-ish line for an edge's history: from `self`'s point of view. */
export function historyLine(outcome: OutcomeId, self: AgentId, other: AgentId, initiator: boolean, topic: string): string {
  const o = castMember(other).name
  switch (outcome) {
    case 'connect':
      return `Talked with ${o} about ${topic}; it went well.`
    case 'cooperate':
      return `Worked alongside ${o}.`
    case 'disagree':
      return `Argued with ${o} about ${topic}.`
    case 'confide':
      return initiator ? `Confided in ${o}.` : `${o} confided in me.`
    case 'gossip':
      return initiator ? `Told ${o} something I'd heard.` : `${o} told me something they'd heard.`
    case 'withhold':
      return initiator ? `Kept something from ${o}.` : `${o} was holding something back.`
    case 'confront':
      return initiator ? `Confronted ${o} about ${topic}.` : `${o} confronted me about ${topic}.`
    case 'repair':
      return `Cleared the air with ${o}.`
    case 'avoid':
      return initiator ? `Avoided ${o}.` : `${o} avoided me.`
    case 'observe':
      return `Watched ${o}.`
    case 'betray':
      return initiator ? `Told ${o} something I was told in confidence.` : `${o} trusted me with something.`
    case 'romance':
      return `Something changed with ${o}.`
    case 'nothing':
      return `Passed ${o}.`
  }
  void self
}
