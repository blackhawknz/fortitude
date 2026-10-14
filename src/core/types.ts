/**
 * Core domain types.
 *
 * OWNERSHIP RULE (spec §1.1): every field below is either SIM-OWNED or
 * AGENT-OWNED. Only the deterministic tick (src/sim) writes sim-owned fields,
 * and the tick never reads agent-owned fields. The only channel from the
 * generative layer into the simulation is the intent queue.
 */

export type AgentId = string
export type LocationId = string
export type FactId = string
export type Tick = number

// ─── Traits ───────────────────────────────────────────────────────────────

export const TRAIT_KEYS = ['sociability', 'kindness', 'candour', 'ambition', 'perception'] as const
export type TraitKey = (typeof TRAIT_KEYS)[number]
/** 0–100 each. `perception` extends the spec's four: how much an agent notices. */
export type Traits = Record<TraitKey, number>

// ─── Locations ────────────────────────────────────────────────────────────

export type LocationKind = 'civic' | 'work' | 'social' | 'quarters' | 'transit' | 'restricted'

export interface LocationDef {
  id: LocationId
  name: string
  description: string
  kind: LocationKind
  color: string
  /** Inventory item required to enter, if any (e.g. the sealed deck). */
  access?: string
  /** Station subsystem that work here maintains. */
  subsystem?: SubsystemId
  /** Evidence that investigating here can turn up. */
  evidence?: EvidenceDef[]
}

export interface EvidenceDef {
  fact: FactId
  /** Chance per investigating hour. */
  chance: number
  /** Only discoverable from this chronicle day on. */
  fromDay?: number
}

/** SIM-OWNED mutable location state. */
export interface LocationState {
  id: LocationId
  /** 0–100, physical condition. */
  condition: number
  dark: boolean
  /** Sealed by an incident (breach) until this tick. Distinct from `access`. */
  sealedUntil: Tick | null
}

// ─── Station ──────────────────────────────────────────────────────────────

export type SubsystemId = 'hull' | 'power' | 'air' | 'water'

export interface Incident {
  id: string
  kind: IncidentKind
  locationId: LocationId
  startTick: Tick
  endTick: Tick
  severity: number // 0–1
  text: string
}

export type IncidentKind = 'pressure_alarm' | 'brownout' | 'water_rationing' | 'hull_breach' | 'sealed_deck_activity'

/** SIM-OWNED. */
export interface StationState {
  /** True hull integrity. Declines monotonically. */
  hull: number
  /** What the Queen has told everyone. Her secret is the gap. */
  reportedHull: number
  power: number
  air: number
  water: number
  morale: number
  incidents: Incident[]
  /** Tick of the last time each incident kind fired. */
  lastIncident: Partial<Record<IncidentKind, Tick>>
}

// ─── Agents ───────────────────────────────────────────────────────────────

export type AgentBackendKind = 'local' | 'alita' | 'none'
export type Priority = 'queen' | 'major' | 'minor'

export const MOODS = ['calm', 'content', 'warm', 'concerned', 'anxious', 'irritable', 'grim', 'guarded', 'weary', 'elated'] as const
export type Mood = (typeof MOODS)[number]

/** SIM-OWNED goal progress, AGENT-OWNED note/perceived progress. */
export interface GoalState {
  id: string
  text: string
  weight: number
  /** Sim-owned, deterministic. */
  progress: number
  /** Agent-owned: what the agent believes about its progress. Never read by the sim. */
  perceivedProgress?: number
  note?: string
}

/** SIM-OWNED physical/social state. */
export interface AgentState {
  id: AgentId
  alive: boolean
  health: number // 0–100
  stress: number // 0–100
  locationId: LocationId
  activity: string
  asleep: boolean
  working: boolean
  inventory: string[]
  goals: GoalState[]
  /** Sim-derived mood (from stress/outcomes). Agent-owned mood lives in the DB separately. */
  mood: Mood
  /** Tick the current mood was set by an event; event moods hold for a few hours. */
  moodTick: Tick
  injuredUntil: Tick | null
}

// ─── Relationships ───────────────────────────────────────────────────────

export type RelationshipType = 'stranger' | 'acquaintance' | 'friend' | 'close' | 'rival' | 'enemy' | 'lover'

/**
 * DIRECTED edge: how `from` feels about `to`. The reverse edge is separate.
 * Asymmetry (spec §5.3) is just the difference between the two directions —
 * there is no second copy of the numbers to drift out of sync.
 */
export interface Edge {
  from: AgentId
  to: AgentId
  trust: number // 0–100
  warmth: number // 0–100
  tension: number // 0–100
  /**
   * 0–100. A floor under tension that daily drift cannot erode: what `from`
   * holds against `to` (learned secrets, a discovered betrayal). Only repair
   * wears it down. `to` has no direct way of knowing it is there.
   */
  grudge: number
  encounters: number
  lastTick: Tick | null
  type: RelationshipType
  /** Last 12 encounter summaries, from `from`'s point of view. */
  history: string[]
}

// ─── Knowledge ───────────────────────────────────────────────────────────

export interface FactDef {
  id: FactId
  text: string
  /** Who the fact is about (whose secret it is), if anyone. */
  subject?: AgentId
  /** Others who would be compromised if it came out. They won't spread it either. */
  implicates?: AgentId[]
  /** 0–1: how dangerous it is to say aloud. 1 = only under extreme trust. */
  secrecy: number
  /**
   * −1..1: how learning it changes your view of the subject. Damning facts
   * (−) cost trust and add tension; sympathetic ones (+) add warmth. The
   * subject doesn't know your view changed.
   */
  valence: number
  /** Topic tag, used by narration. */
  topic: string
}

export type KnowledgeSource =
  | { kind: 'self' }
  | { kind: 'told'; by: AgentId; tick: Tick; confided: boolean }
  | { kind: 'overheard'; from: AgentId; tick: Tick }
  | { kind: 'evidence'; locationId: LocationId; tick: Tick }
  | { kind: 'observed'; subject: AgentId; tick: Tick }

export interface Knowing {
  fact: FactId
  source: KnowledgeSource
  tick: Tick
}

/** A record that `betrayer` passed on something `victim` confided. Victim does not know — yet. */
export interface Betrayal {
  id: string
  betrayer: AgentId
  victim: AgentId
  listener: AgentId
  fact: FactId
  tick: Tick
  discovered: boolean
}

// ─── Intents ──────────────────────────────────────────────────────────────

export const INTENT_KINDS = [
  'move',
  'seek',
  'avoid',
  'speak',
  'confide',
  'withhold',
  'investigate',
  'work',
  'rest',
  'confront',
  'ally',
  'observe',
] as const
export type IntentKind = (typeof INTENT_KINDS)[number]

export type IntentSource = 'agent' | 'instinct' | 'player'
export type IntentStatus = 'pending' | 'committed' | 'rejected' | 'expired' | 'fulfilled'

export interface IntentProposal {
  agentId: AgentId
  kind: IntentKind
  target?: AgentId
  to?: LocationId
  reason: string
  weight: number // 0–1
  expiresTick: Tick
  source: IntentSource
  /** Only for `speak`: the line, generative payload. Never read for adjudication. */
  say?: string
  register?: 'open' | 'guarded' | 'warm' | 'cold' | 'formal'
}

export interface Intent extends IntentProposal {
  id: string
  createdTick: Tick
  status: IntentStatus
  /** Tick whose phase 2 adjudicated this intent. The replay key. */
  appliedTick: Tick | null
  rejectReason?: string
}

// ─── Events ───────────────────────────────────────────────────────────────

export type EventType =
  | 'encounter'
  | 'speech'
  | 'incident'
  | 'discovery'
  | 'milestone'
  | 'intent'
  | 'station'
  | 'betrayal_discovered'
  | 'arrival'

export type OutcomeId =
  | 'connect'
  | 'cooperate'
  | 'disagree'
  | 'confide'
  | 'gossip'
  | 'withhold'
  | 'confront'
  | 'repair'
  | 'avoid'
  | 'observe'
  | 'betray'
  | 'romance'
  | 'nothing'

export interface SimEvent {
  id: string
  tick: Tick
  type: EventType
  actorId?: AgentId
  targetId?: AgentId
  locationId?: LocationId
  outcome?: OutcomeId
  text: string
  /** 0–1. Drives wake triggers. */
  magnitude: number
  /**
   * Who may ever know this happened first-hand. `null` = public (station-wide).
   * Witnesses are included. Information boundaries are enforced against this.
   */
  privateTo: AgentId[] | null
  data?: Record<string, unknown>
}

// ─── World ───────────────────────────────────────────────────────────────

export interface WorldSettings {
  romance: boolean
  death: boolean
  /** Mean true-hull loss per in-world day. */
  hullDecayPerDay: number
  /** Base chance a co-located awake pair interacts in an hour. */
  encounterBase: number
}

export const DEFAULT_SETTINGS: WorldSettings = {
  romance: false,
  death: false,
  hullDecayPerDay: 0.35,
  encounterBase: -0.1,
}

/** The complete deterministic state. Everything the tick reads and writes. */
export interface WorldState {
  id: string
  name: string
  seed: string
  tick: Tick
  settings: WorldSettings
  agents: Record<AgentId, AgentState>
  edges: Record<string, Edge> // key: `${from}>${to}`
  locations: Record<LocationId, LocationState>
  station: StationState
  knowledge: Record<AgentId, Record<FactId, Knowing>>
  betrayals: Betrayal[]
  /** `${subject}:${knower}:${fact}` — subject has noticed that knower knows their secret. */
  exposures: string[]
  /** Committed, still-active intents. */
  intents: Intent[]
  /** Monotonic counter for intent ids issued inside the sim (instincts). */
  intentSeq: number
}

export function edgeKey(from: AgentId, to: AgentId): string {
  return `${from}>${to}`
}
