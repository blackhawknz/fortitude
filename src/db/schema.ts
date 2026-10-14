import { sqliteTable, text, integer, real, primaryKey, index, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * World database (spec §8, with corrections):
 *  - relationships are DIRECTED rows (from → to), not a/b + asymmetry blob
 *  - knowledge, betrayals and event visibility are first-class tables
 *  - agent-owned columns are named as such and never written by the sim
 *  - agent_turns logs every LLM turn for budget accounting and debugging
 */

export const worlds = sqliteTable('worlds', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  seed: text('seed').notNull(),
  tick: integer('tick').notNull().default(0),
  speedMs: integer('speed_ms').notNull().default(10_000),
  running: integer('running', { mode: 'boolean' }).notNull().default(false),
  settingsJson: text('settings_json').notNull(),
  /** Misc deterministic state that doesn't merit its own table (exposures, counters). */
  extraJson: text('extra_json').notNull().default('{}'),
  lastTickAt: integer('last_tick_at'), // unix ms, real time
  createdAt: integer('created_at').notNull(),
})

export const agents = sqliteTable(
  'agents',
  {
    worldId: text('world_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    role: text('role').notNull(),
    personality: text('personality').notNull(),
    backstory: text('backstory').notNull(),
    portrait: text('portrait'),
    backend: text('backend').notNull(), // 'local' | 'alita' | 'none'
    budgetJson: text('budget_json').notNull().default('{}'),
    traitsJson: text('traits_json').notNull(),
    // sim-owned
    alive: integer('alive', { mode: 'boolean' }).notNull().default(true),
    health: real('health').notNull(),
    stress: real('stress').notNull(),
    mood: text('mood').notNull(),
    moodTick: integer('mood_tick').notNull().default(0),
    locationId: text('location_id').notNull(),
    activity: text('activity').notNull(),
    asleep: integer('asleep', { mode: 'boolean' }).notNull().default(false),
    working: integer('working', { mode: 'boolean' }).notNull().default(false),
    inventoryJson: text('inventory_json').notNull().default('[]'),
    injuredUntil: integer('injured_until'),
    // agent-owned (written by the agent runtime; never read by the sim)
    agentMood: text('agent_mood'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.worldId, t.id] })],
)

export const agentGoals = sqliteTable(
  'agent_goals',
  {
    worldId: text('world_id').notNull(),
    agentId: text('agent_id').notNull(),
    id: text('id').notNull(),
    text: text('text').notNull(),
    weight: real('weight').notNull(),
    progress: real('progress').notNull().default(0), // sim-owned
    perceivedProgress: real('perceived_progress'), // agent-owned
    note: text('note'), // agent-owned
    /** 'authored' goals are sim-owned (progress computed by the tick); 'agent' goals are written in reflection. */
    origin: text('origin').notNull().default('authored'),
    status: text('status').notNull().default('active'), // 'active' | 'dropped'
    createdTick: integer('created_tick').notNull().default(0),
    resolvedTick: integer('resolved_tick'),
  },
  (t) => [primaryKey({ columns: [t.worldId, t.agentId, t.id] })],
)

export const agentMemoryEpisodic = sqliteTable(
  'agent_memory_episodic',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    worldId: text('world_id').notNull(),
    agentId: text('agent_id').notNull(),
    text: text('text').notNull(),
    importance: integer('importance').notNull(),
    tick: integer('tick').notNull(),
    private: integer('private', { mode: 'boolean' }).notNull().default(true),
    origin: text('origin').notNull(), // 'sim' | 'agent'
    sourceEventId: text('source_event_id'),
  },
  (t) => [index('mem_epi_agent_tick').on(t.worldId, t.agentId, t.tick)],
)

export const agentMemorySemantic = sqliteTable(
  'agent_memory_semantic',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    worldId: text('world_id').notNull(),
    agentId: text('agent_id').notNull(),
    text: text('text').notNull(),
    kind: text('kind').notNull(), // 'belief' | 'opinion' | 'summary'
    subjectId: text('subject_id'),
    weight: real('weight').notNull().default(1),
    updatedTick: integer('updated_tick').notNull(),
  },
  (t) => [index('mem_sem_agent').on(t.worldId, t.agentId)],
)

export const relationships = sqliteTable(
  'relationships',
  {
    worldId: text('world_id').notNull(),
    fromId: text('from_id').notNull(),
    toId: text('to_id').notNull(),
    trust: real('trust').notNull(),
    warmth: real('warmth').notNull(),
    tension: real('tension').notNull(),
    grudge: real('grudge').notNull().default(0),
    encounters: integer('encounters').notNull(),
    type: text('type').notNull(),
    lastTick: integer('last_tick'),
    historyJson: text('history_json').notNull().default('[]'),
  },
  (t) => [primaryKey({ columns: [t.worldId, t.fromId, t.toId] })],
)

export const locations = sqliteTable(
  'locations',
  {
    worldId: text('world_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    kind: text('kind').notNull(),
    color: text('color').notNull(),
    condition: real('condition').notNull(),
    dark: integer('dark', { mode: 'boolean' }).notNull().default(false),
    sealedUntil: integer('sealed_until'),
  },
  (t) => [primaryKey({ columns: [t.worldId, t.id] })],
)

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    worldId: text('world_id').notNull(),
    tick: integer('tick').notNull(),
    type: text('type').notNull(),
    actorId: text('actor_id'),
    targetId: text('target_id'),
    locationId: text('location_id'),
    outcome: text('outcome'),
    text: text('text').notNull(),
    magnitude: real('magnitude').notNull(),
    /** JSON array of agent ids, or NULL for public. */
    privateTo: text('private_to'),
    dataJson: text('data_json'),
  },
  (t) => [index('events_world_tick').on(t.worldId, t.tick)],
)

/** One row per (event, agent who may know it first-hand). Information boundaries are enforced by joining on this. */
export const eventVisibility = sqliteTable(
  'event_visibility',
  {
    worldId: text('world_id').notNull(),
    eventId: text('event_id').notNull(),
    agentId: text('agent_id').notNull(),
    tick: integer('tick').notNull(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.agentId] }), index('evvis_agent_tick').on(t.worldId, t.agentId, t.tick)],
)

export const intents = sqliteTable(
  'intents',
  {
    id: text('id').primaryKey(),
    worldId: text('world_id').notNull(),
    agentId: text('agent_id').notNull(),
    kind: text('kind').notNull(),
    target: text('target'),
    toLocation: text('to_location'),
    payloadJson: text('payload_json'), // { say, register }
    reason: text('reason').notNull(),
    weight: real('weight').notNull(),
    source: text('source').notNull(), // 'agent' | 'instinct' | 'player'
    createdTick: integer('created_tick').notNull(),
    expiresTick: integer('expires_tick').notNull(),
    /** Tick whose phase 2 adjudicated it. Replay feeds submissions back by this key. */
    appliedTick: integer('applied_tick'),
    status: text('status').notNull(),
    rejectReason: text('reject_reason'),
    submittedAt: integer('submitted_at'), // unix ms
  },
  (t) => [
    index('intents_status').on(t.worldId, t.status, t.expiresTick),
    index('intents_applied').on(t.worldId, t.appliedTick),
  ],
)

export const knowledge = sqliteTable(
  'knowledge',
  {
    worldId: text('world_id').notNull(),
    agentId: text('agent_id').notNull(),
    factId: text('fact_id').notNull(),
    tick: integer('tick').notNull(),
    sourceJson: text('source_json').notNull(),
  },
  (t) => [primaryKey({ columns: [t.worldId, t.agentId, t.factId] })],
)

export const betrayals = sqliteTable(
  'betrayals',
  {
    worldId: text('world_id').notNull(),
    id: text('id').notNull(),
    betrayer: text('betrayer').notNull(),
    victim: text('victim').notNull(),
    listener: text('listener').notNull(),
    factId: text('fact_id').notNull(),
    tick: integer('tick').notNull(),
    discovered: integer('discovered', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.worldId, t.id] })],
)

export const station = sqliteTable('station', {
  worldId: text('world_id').primaryKey(),
  hull: real('hull').notNull(),
  reportedHull: real('reported_hull').notNull(),
  power: real('power').notNull(),
  air: real('air').notNull(),
  water: real('water').notNull(),
  morale: real('morale').notNull(),
  incidentsJson: text('incidents_json').notNull().default('[]'),
  lastIncidentJson: text('last_incident_json').notNull().default('{}'),
})

export const journals = sqliteTable(
  'journals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    worldId: text('world_id').notNull(),
    agentId: text('agent_id').notNull(),
    day: integer('day').notNull(),
    text: text('text').notNull(),
    discoverable: integer('discoverable', { mode: 'boolean' }).notNull().default(true),
    discoveredBy: text('discovered_by'), // JSON array
  },
  (t) => [uniqueIndex('journal_agent_day').on(t.worldId, t.agentId, t.day)],
)

/**
 * Outbox for memories mirrored to an external store (the Alita system).
 * A row exists once a memory has been acknowledged; anything missing is
 * backlog, pushed when the service is reachable. `external_ref` is the
 * idempotency key on the other side, so retries never duplicate.
 */
export const externalSync = sqliteTable(
  'external_sync',
  {
    worldId: text('world_id').notNull(),
    kind: text('kind').notNull(), // 'episodic' | 'summary'
    localId: integer('local_id').notNull(),
    externalRef: text('external_ref').notNull(),
    syncedAt: integer('synced_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.worldId, t.kind, t.localId] })],
)

/** Every LLM turn: what was asked, what came back, what it cost. */
export const agentTurns = sqliteTable(
  'agent_turns',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    worldId: text('world_id').notNull(),
    agentId: text('agent_id').notNull(),
    tick: integer('tick').notNull(),
    kind: text('kind').notNull(), // 'turn' | 'reflect'
    backend: text('backend').notNull(),
    triggerJson: text('trigger_json').notNull(),
    packetJson: text('packet_json').notNull(),
    responseJson: text('response_json'),
    status: text('status').notNull(), // 'ok' | 'invalid' | 'error' | 'timeout'
    error: text('error'),
    latencyMs: integer('latency_ms'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('turns_agent').on(t.worldId, t.agentId, t.tick), index('turns_time').on(t.worldId, t.createdAt)],
)
