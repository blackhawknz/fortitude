import { and, asc, desc, eq, gte, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm'
import type {
  AgentId,
  AgentState,
  Betrayal,
  Edge,
  Intent,
  IntentProposal,
  Knowing,
  LocationState,
  SimEvent,
  WorldSettings,
  WorldState,
} from '../core/types.js'
import { DEFAULT_SETTINGS, edgeKey } from '../core/types.js'
import { CAST, setPlayerName } from '../world/cast.js'
import { LOCATIONS } from '../world/locations.js'
import { SIM_VERSION, type TickResult } from '../sim/tick.js'
import type { Db } from './client.js'
import * as t from './schema.js'

const now = () => Date.now()
const J = JSON.stringify
const P = <T>(s: string | null | undefined, fallback: T): T => (s ? (JSON.parse(s) as T) : fallback)
const ex = (col: string) => sql.raw(`excluded.${col}`)

export interface MemoryRow {
  id: number
  text: string
  importance: number
  tick: number
  private: boolean
  origin: string
}

/**
 * All database access for a world. The sim never touches this; the engine
 * calls `persistTick` (phase 6) and the agent runtime reads through the
 * scoped query methods, which enforce information boundaries.
 */
export class WorldStore {
  constructor(readonly db: Db) {}

  /** better-sqlite3 transaction; nests via savepoints. All statements share the one connection. */
  private tx<T>(fn: () => T): T {
    return this.db.$client.transaction(fn)()
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  exists(worldId: string): boolean {
    return !!this.db.select({ id: t.worlds.id }).from(t.worlds).where(eq(t.worlds.id, worldId)).get()
  }

  create(state: WorldState, speedMs = 10_000): WorldState {
    const ts = now()
    this.tx(() => {
      this.db.insert(t.worlds)
        .values({
          id: state.id,
          name: state.name,
          seed: state.seed,
          tick: state.tick,
          speedMs,
          settingsJson: J(state.settings),
          extraJson: J({ exposures: state.exposures, intentSeq: state.intentSeq, simVersion: SIM_VERSION }),
          createdAt: ts,
        })
        .run()
      for (const c of CAST) {
        const a = state.agents[c.id]!
        this.db.insert(t.agents)
          .values({
            worldId: state.id,
            id: c.id,
            name: c.name,
            role: c.role,
            personality: c.personality,
            backstory: c.backstory,
            backend: c.backend,
            traitsJson: J(c.traits),
            ...this.agentSimColumns(a),
            createdAt: ts,
            updatedAt: ts,
          })
          .run()
        for (const g of a.goals) {
          this.db.insert(t.agentGoals).values({ worldId: state.id, agentId: c.id, id: g.id, text: g.text, weight: g.weight, progress: g.progress }).run()
        }
      }
      for (const l of LOCATIONS) {
        const ls = state.locations[l.id]!
        this.db.insert(t.locations)
          .values({ worldId: state.id, id: l.id, name: l.name, description: l.description, kind: l.kind, color: l.color, condition: ls.condition, dark: ls.dark, sealedUntil: ls.sealedUntil })
          .run()
      }
    })
    this.persistState(state)
    return state
  }

  load(worldId: string): WorldState {
    const w = this.db.select().from(t.worlds).where(eq(t.worlds.id, worldId)).get()
    if (!w) throw new Error(`No world ${worldId}`)
    const extra = P<{ exposures?: string[]; intentSeq?: number }>(w.extraJson, {})
    const settings = { ...DEFAULT_SETTINGS, ...P<Partial<WorldSettings>>(w.settingsJson, {}) }
    setPlayerName(settings.playerName)

    const agents: Record<AgentId, AgentState> = {}
    const goals = this.db.select().from(t.agentGoals).where(eq(t.agentGoals.worldId, worldId)).orderBy(asc(t.agentGoals.id)).all()
    for (const r of this.db.select().from(t.agents).where(eq(t.agents.worldId, worldId)).all()) {
      agents[r.id] = {
        id: r.id,
        alive: r.alive,
        health: r.health,
        stress: r.stress,
        locationId: r.locationId,
        activity: r.activity,
        asleep: r.asleep,
        working: r.working,
        inventory: P(r.inventoryJson, []),
        mood: r.mood as AgentState['mood'],
        moodTick: r.moodTick,
        injuredUntil: r.injuredUntil,
        goals: [],
      }
    }
    // Goal order must match authored order for deterministic iteration.
    for (const c of CAST) {
      const a = agents[c.id]
      if (!a) continue
      const mine = goals.filter((g) => g.agentId === c.id)
      const order = [c.goal, ...(c.goals ?? [])].map((g) => g.id)
      a.goals = order
        .map((id) => mine.find((g) => g.id === id))
        .filter((g) => !!g)
        .map((g) => ({ id: g.id, text: g.text, weight: g.weight, progress: g.progress, perceivedProgress: g.perceivedProgress ?? undefined, note: g.note ?? undefined }))
    }

    const edges: Record<string, Edge> = {}
    for (const r of this.db.select().from(t.relationships).where(eq(t.relationships.worldId, worldId)).all()) {
      edges[edgeKey(r.fromId, r.toId)] = {
        from: r.fromId,
        to: r.toId,
        trust: r.trust,
        warmth: r.warmth,
        tension: r.tension,
        grudge: r.grudge,
        encounters: r.encounters,
        lastTick: r.lastTick,
        type: r.type as Edge['type'],
        history: P(r.historyJson, []),
      }
    }

    const locations: Record<string, LocationState> = {}
    for (const r of this.db.select().from(t.locations).where(eq(t.locations.worldId, worldId)).all()) {
      locations[r.id] = { id: r.id, condition: r.condition, dark: r.dark, sealedUntil: r.sealedUntil }
    }

    const knowledgeMap: Record<AgentId, Record<string, Knowing>> = {}
    for (const c of CAST) knowledgeMap[c.id] = {}
    for (const r of this.db.select().from(t.knowledge).where(eq(t.knowledge.worldId, worldId)).all()) {
      ;(knowledgeMap[r.agentId] ??= {})[r.factId] = { fact: r.factId, tick: r.tick, source: P(r.sourceJson, { kind: 'self' }) }
    }

    const st = this.db.select().from(t.station).where(eq(t.station.worldId, worldId)).get()!
    const betrayalRows = this.db.select().from(t.betrayals).where(eq(t.betrayals.worldId, worldId)).orderBy(asc(t.betrayals.tick), asc(t.betrayals.id)).all()

    return {
      id: w.id,
      name: w.name,
      seed: w.seed,
      tick: w.tick,
      settings,
      agents,
      edges,
      locations,
      station: {
        hull: st.hull,
        reportedHull: st.reportedHull,
        power: st.power,
        air: st.air,
        water: st.water,
        morale: st.morale,
        incidents: P(st.incidentsJson, []),
        lastIncident: P(st.lastIncidentJson, {}),
      },
      knowledge: knowledgeMap,
      betrayals: betrayalRows.map<Betrayal>((b) => ({ id: b.id, betrayer: b.betrayer, victim: b.victim, listener: b.listener, fact: b.factId, tick: b.tick, discovered: b.discovered })),
      exposures: extra.exposures ?? [],
      intents: this.db
        .select()
        .from(t.intents)
        .where(and(eq(t.intents.worldId, worldId), eq(t.intents.status, 'committed')))
        .orderBy(asc(t.intents.id))
        .all()
        .map(rowToIntent),
      intentSeq: extra.intentSeq ?? 0,
    }
  }

  // ─── Phase 6: persist ─────────────────────────────────────────────────

  private agentSimColumns(a: AgentState) {
    return {
      alive: a.alive,
      health: a.health,
      stress: a.stress,
      mood: a.mood,
      moodTick: a.moodTick,
      locationId: a.locationId,
      activity: a.activity,
      asleep: a.asleep,
      working: a.working,
      inventoryJson: J(a.inventory),
      injuredUntil: a.injuredUntil,
    }
  }

  /** Write every sim-owned field of the state. Agent-owned columns are never touched. */
  persistState(s: WorldState): void {
    const ts = now()
    this.tx(() => {
      this.db.update(t.worlds)
        .set({ tick: s.tick, extraJson: J({ exposures: s.exposures, intentSeq: s.intentSeq, simVersion: this.simVersion(s.id) ?? SIM_VERSION }), lastTickAt: ts })
        .where(eq(t.worlds.id, s.id))
        .run()

      for (const a of Object.values(s.agents)) {
        this.db.update(t.agents)
          .set({ ...this.agentSimColumns(a), updatedAt: ts })
          .where(and(eq(t.agents.worldId, s.id), eq(t.agents.id, a.id)))
          .run()
        for (const g of a.goals) {
          this.db.update(t.agentGoals)
            .set({ progress: g.progress })
            .where(and(eq(t.agentGoals.worldId, s.id), eq(t.agentGoals.agentId, a.id), eq(t.agentGoals.id, g.id)))
            .run()
        }
      }

      const edgeRows = Object.values(s.edges).map((e) => ({
        worldId: s.id,
        fromId: e.from,
        toId: e.to,
        trust: e.trust,
        warmth: e.warmth,
        tension: e.tension,
        grudge: e.grudge,
        encounters: e.encounters,
        type: e.type,
        lastTick: e.lastTick,
        historyJson: J(e.history),
      }))
      for (let i = 0; i < edgeRows.length; i += 50) {
        this.db.insert(t.relationships)
          .values(edgeRows.slice(i, i + 50))
          .onConflictDoUpdate({
            target: [t.relationships.worldId, t.relationships.fromId, t.relationships.toId],
            set: { trust: ex('trust'), warmth: ex('warmth'), tension: ex('tension'), grudge: ex('grudge'), encounters: ex('encounters'), type: ex('type'), lastTick: ex('last_tick'), historyJson: ex('history_json') },
          })
          .run()
      }

      for (const l of Object.values(s.locations)) {
        this.db.update(t.locations)
          .set({ condition: l.condition, dark: l.dark, sealedUntil: l.sealedUntil })
          .where(and(eq(t.locations.worldId, s.id), eq(t.locations.id, l.id)))
          .run()
      }

      const kRows = Object.entries(s.knowledge).flatMap(([agentId, facts]) =>
        Object.values(facts).map((k) => ({ worldId: s.id, agentId, factId: k.fact, tick: k.tick, sourceJson: J(k.source) })),
      )
      for (let i = 0; i < kRows.length; i += 100) this.db.insert(t.knowledge).values(kRows.slice(i, i + 100)).onConflictDoNothing().run()

      for (const b of s.betrayals) {
        this.db.insert(t.betrayals)
          .values({ worldId: s.id, id: b.id, betrayer: b.betrayer, victim: b.victim, listener: b.listener, factId: b.fact, tick: b.tick, discovered: b.discovered })
          .onConflictDoUpdate({ target: [t.betrayals.worldId, t.betrayals.id], set: { discovered: b.discovered } })
          .run()
      }

      const st = s.station
      this.db.insert(t.station)
        .values({ worldId: s.id, hull: st.hull, reportedHull: st.reportedHull, power: st.power, air: st.air, water: st.water, morale: st.morale, incidentsJson: J(st.incidents), lastIncidentJson: J(st.lastIncident) })
        .onConflictDoUpdate({
          target: t.station.worldId,
          set: { hull: st.hull, reportedHull: st.reportedHull, power: st.power, air: st.air, water: st.water, morale: st.morale, incidentsJson: J(st.incidents), lastIncidentJson: J(st.lastIncident) },
        })
        .run()
    })
  }

  /** PHASE 6 — state snapshot, events + visibility, sim memories, intent log. One transaction. */
  persistTick(r: TickResult): void {
    const s = r.state
    this.tx(() => {
      this.persistState(s)
      for (const e of r.events) {
        this.db.insert(t.events)
          .values({
            id: e.id,
            worldId: s.id,
            tick: e.tick,
            type: e.type,
            actorId: e.actorId ?? null,
            targetId: e.targetId ?? null,
            locationId: e.locationId ?? null,
            outcome: e.outcome ?? null,
            text: e.text,
            magnitude: e.magnitude,
            privateTo: e.privateTo ? J(e.privateTo) : null,
            dataJson: e.data ? J(e.data) : null,
          })
          .run()
        const viewers = e.privateTo ?? CAST.map((c) => c.id)
        for (const agentId of viewers) this.db.insert(t.eventVisibility).values({ worldId: s.id, eventId: e.id, agentId, tick: e.tick }).onConflictDoNothing().run()
      }
      for (const m of r.memories) {
        this.db.insert(t.agentMemoryEpisodic)
          .values({ worldId: s.id, agentId: m.agentId, text: m.text, importance: m.importance, tick: s.tick, private: m.private, origin: 'sim', sourceEventId: m.eventId })
          .run()
      }
      for (const i of r.intents) this.upsertIntent(this.db, s.id, i)
    })
  }

  private upsertIntent(db: Db, worldId: string, i: Intent): void {
    const row = intentToRow(worldId, i)
    db.insert(t.intents)
      .values(row)
      .onConflictDoUpdate({
        target: t.intents.id,
        set: { status: row.status, appliedTick: row.appliedTick, rejectReason: row.rejectReason, weight: row.weight, expiresTick: row.expiresTick, reason: row.reason },
      })
      .run()
  }

  // ─── Intent queue ────────────────────────────────────────────────────

  /** Submit a proposal from outside the sim. It sits as 'pending' until the next tick's phase 2. */
  submitIntent(worldId: string, p: IntentProposal, createdTick: number, id: string): Intent {
    const intent: Intent = { ...p, id, createdTick, status: 'pending', appliedTick: null }
    this.db.insert(t.intents).values({ ...intentToRow(worldId, intent), submittedAt: now() }).run()
    return intent
  }

  pendingIntents(worldId: string): Intent[] {
    return this.db
      .select()
      .from(t.intents)
      .where(and(eq(t.intents.worldId, worldId), eq(t.intents.status, 'pending')))
      .orderBy(asc(t.intents.createdTick), asc(t.intents.id))
      .all()
      .map(rowToIntent)
  }

  /** The replay log: every external submission, keyed by the tick that adjudicated it. */
  submissionsByTick(worldId: string): Map<number, Intent[]> {
    const rows = this.db
      .select()
      .from(t.intents)
      .where(and(eq(t.intents.worldId, worldId), ne(t.intents.source, 'instinct'), isNotNull(t.intents.appliedTick)))
      .orderBy(asc(t.intents.appliedTick), asc(t.intents.id))
      .all()
    const out = new Map<number, Intent[]>()
    for (const r of rows) {
      const i = { ...rowToIntent(r), status: 'pending' as const, appliedTick: null, rejectReason: undefined }
      const list = out.get(r.appliedTick!) ?? []
      list.push(i)
      out.set(r.appliedTick!, list)
    }
    return out
  }

  intentsFor(worldId: string, agentId: string, sinceTick: number): Intent[] {
    return this.db
      .select()
      .from(t.intents)
      .where(and(eq(t.intents.worldId, worldId), eq(t.intents.agentId, agentId), gte(t.intents.createdTick, sinceTick)))
      .orderBy(asc(t.intents.createdTick), asc(t.intents.id))
      .all()
      .map(rowToIntent)
  }

  // ─── Scoped reads (information boundaries enforced here) ─────────────

  /** Events this agent may know first-hand, newest first. */
  visibleEvents(worldId: string, agentId: string, opts: { sinceTick?: number; untilTick?: number; limit?: number } = {}): SimEvent[] {
    const conds = [eq(t.eventVisibility.worldId, worldId), eq(t.eventVisibility.agentId, agentId)]
    if (opts.sinceTick !== undefined) conds.push(gte(t.eventVisibility.tick, opts.sinceTick))
    if (opts.untilTick !== undefined) conds.push(lte(t.eventVisibility.tick, opts.untilTick))
    const rows = this.db
      .select({ e: t.events })
      .from(t.eventVisibility)
      .innerJoin(t.events, eq(t.events.id, t.eventVisibility.eventId))
      .where(and(...conds))
      .orderBy(desc(t.eventVisibility.tick), desc(t.events.id))
      .limit(opts.limit ?? 50)
      .all()
    return rows.map(({ e }) => rowToEvent(e))
  }

  /** An agent's own episodic memories. Never another agent's. */
  episodic(worldId: string, agentId: string, limit = 24): MemoryRow[] {
    return this.db
      .select({ id: t.agentMemoryEpisodic.id, text: t.agentMemoryEpisodic.text, importance: t.agentMemoryEpisodic.importance, tick: t.agentMemoryEpisodic.tick, private: t.agentMemoryEpisodic.private, origin: t.agentMemoryEpisodic.origin })
      .from(t.agentMemoryEpisodic)
      .where(and(eq(t.agentMemoryEpisodic.worldId, worldId), eq(t.agentMemoryEpisodic.agentId, agentId)))
      .orderBy(desc(t.agentMemoryEpisodic.tick), desc(t.agentMemoryEpisodic.id))
      .limit(limit)
      .all()
  }

  semantic(worldId: string, agentId: string, limit = 20) {
    return this.db
      .select()
      .from(t.agentMemorySemantic)
      .where(and(eq(t.agentMemorySemantic.worldId, worldId), eq(t.agentMemorySemantic.agentId, agentId)))
      .orderBy(desc(t.agentMemorySemantic.weight))
      .limit(limit)
      .all()
  }

  // ─── Agent-owned writes ──────────────────────────────────────────────

  addAgentMemory(worldId: string, agentId: string, tick: number, text: string, importance: number, isPrivate: boolean): void {
    this.db.insert(t.agentMemoryEpisodic).values({ worldId, agentId, text, importance, tick, private: isPrivate, origin: 'agent' }).run()
  }

  setAgentMood(worldId: string, agentId: string, mood: string): void {
    this.db.update(t.agents).set({ agentMood: mood }).where(and(eq(t.agents.worldId, worldId), eq(t.agents.id, agentId))).run()
  }

  agentMood(worldId: string, agentId: string): string | null {
    return this.db.select({ m: t.agents.agentMood }).from(t.agents).where(and(eq(t.agents.worldId, worldId), eq(t.agents.id, agentId))).get()?.m ?? null
  }

  setGoalBelief(worldId: string, agentId: string, goalId: string, perceived: number | undefined, note: string | undefined): boolean {
    const r = this.db
      .update(t.agentGoals)
      .set({ perceivedProgress: perceived ?? null, note: note ?? null })
      .where(and(eq(t.agentGoals.worldId, worldId), eq(t.agentGoals.agentId, agentId), eq(t.agentGoals.id, goalId)))
      .run()
    return r.changes > 0
  }

  goalBeliefs(worldId: string, agentId: string) {
    return this.db
      .select({ id: t.agentGoals.id, perceivedProgress: t.agentGoals.perceivedProgress, note: t.agentGoals.note })
      .from(t.agentGoals)
      .where(and(eq(t.agentGoals.worldId, worldId), eq(t.agentGoals.agentId, agentId)))
      .all()
  }

  // ─── Memory tiers (agent-owned; never read by the sim) ───────────────

  /** Episodic rows since a tick, oldest first, with ids (for reflection). */
  episodicSince(worldId: string, agentId: string, sinceTick: number, limit = 60): MemoryRow[] {
    return this.db
      .select({ id: t.agentMemoryEpisodic.id, text: t.agentMemoryEpisodic.text, importance: t.agentMemoryEpisodic.importance, tick: t.agentMemoryEpisodic.tick, private: t.agentMemoryEpisodic.private, origin: t.agentMemoryEpisodic.origin })
      .from(t.agentMemoryEpisodic)
      .where(and(eq(t.agentMemoryEpisodic.worldId, worldId), eq(t.agentMemoryEpisodic.agentId, agentId), gte(t.agentMemoryEpisodic.tick, sinceTick)))
      .orderBy(asc(t.agentMemoryEpisodic.tick), asc(t.agentMemoryEpisodic.id))
      .limit(limit)
      .all()
  }

  /** Forget: delete only rows that belong to this agent. Returns how many went. */
  forgetEpisodic(worldId: string, agentId: string, ids: number[]): number {
    if (!ids.length) return 0
    return this.db
      .delete(t.agentMemoryEpisodic)
      .where(and(eq(t.agentMemoryEpisodic.worldId, worldId), eq(t.agentMemoryEpisodic.agentId, agentId), inArray(t.agentMemoryEpisodic.id, ids)))
      .run().changes
  }

  /** Keep: mark as more important so pruning spares it. */
  reinforceEpisodic(worldId: string, agentId: string, ids: number[]): void {
    if (!ids.length) return
    this.db
      .update(t.agentMemoryEpisodic)
      .set({ importance: sql`min(5, ${t.agentMemoryEpisodic.importance} + 1)` })
      .where(and(eq(t.agentMemoryEpisodic.worldId, worldId), eq(t.agentMemoryEpisodic.agentId, agentId), inArray(t.agentMemoryEpisodic.id, ids)))
      .run()
  }

  /**
   * Hard cap on the episodic tier. Score = tick + importance × 72, so one
   * point of importance is worth three in-world days of recency.
   */
  pruneEpisodic(worldId: string, agentId: string, cap = 200): number {
    return this.db.$client
      .prepare(
        `DELETE FROM agent_memory_episodic WHERE world_id = ? AND agent_id = ? AND id NOT IN (
           SELECT id FROM agent_memory_episodic WHERE world_id = ? AND agent_id = ?
           ORDER BY tick + importance * 72 DESC, id DESC LIMIT ?)`,
      )
      .run(worldId, agentId, worldId, agentId, cap).changes
  }

  /** One opinion per subject; a new one replaces the old. `stance` is −1..1. */
  setOpinion(worldId: string, agentId: string, subjectId: string, text: string, stance: number, tick: number): void {
    this.tx(() => {
      this.db
        .delete(t.agentMemorySemantic)
        .where(and(eq(t.agentMemorySemantic.worldId, worldId), eq(t.agentMemorySemantic.agentId, agentId), eq(t.agentMemorySemantic.kind, 'opinion'), eq(t.agentMemorySemantic.subjectId, subjectId)))
        .run()
      this.db.insert(t.agentMemorySemantic).values({ worldId, agentId, text, kind: 'opinion', subjectId, weight: stance, updatedTick: tick }).run()
    })
  }

  opinionOf(worldId: string, agentId: string, subjectId: string): { text: string; stance: number } | null {
    const r = this.db
      .select()
      .from(t.agentMemorySemantic)
      .where(and(eq(t.agentMemorySemantic.worldId, worldId), eq(t.agentMemorySemantic.agentId, agentId), eq(t.agentMemorySemantic.kind, 'opinion'), eq(t.agentMemorySemantic.subjectId, subjectId)))
      .get()
    return r ? { text: r.text, stance: r.weight } : null
  }

  addSemantic(worldId: string, agentId: string, kind: 'belief' | 'summary', text: string, weight: number, tick: number): void {
    this.db.insert(t.agentMemorySemantic).values({ worldId, agentId, text, kind, weight, updatedTick: tick }).run()
  }

  replaceBelief(worldId: string, agentId: string, id: number, text: string, weight: number, tick: number): boolean {
    return (
      this.db
        .update(t.agentMemorySemantic)
        .set({ text, weight, updatedTick: tick })
        .where(and(eq(t.agentMemorySemantic.worldId, worldId), eq(t.agentMemorySemantic.agentId, agentId), eq(t.agentMemorySemantic.id, id), eq(t.agentMemorySemantic.kind, 'belief')))
        .run().changes > 0
    )
  }

  dropSemantic(worldId: string, agentId: string, ids: number[]): void {
    if (!ids.length) return
    this.db
      .delete(t.agentMemorySemantic)
      .where(and(eq(t.agentMemorySemantic.worldId, worldId), eq(t.agentMemorySemantic.agentId, agentId), inArray(t.agentMemorySemantic.id, ids)))
      .run()
  }

  /**
   * Semantic tier cap (spec: 50). Opinions are kept (bounded by cast size);
   * the most recent 14 summaries are kept; beliefs fill the rest by weight.
   */
  pruneSemantic(worldId: string, agentId: string, cap = 50, summaries = 14): void {
    const all = this.db
      .select()
      .from(t.agentMemorySemantic)
      .where(and(eq(t.agentMemorySemantic.worldId, worldId), eq(t.agentMemorySemantic.agentId, agentId)))
      .all()
    const opinions = all.filter((r) => r.kind === 'opinion')
    const sums = all.filter((r) => r.kind === 'summary').sort((a, b) => b.updatedTick - a.updatedTick || b.id - a.id)
    const beliefs = all.filter((r) => r.kind === 'belief').sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || b.updatedTick - a.updatedTick)
    const keepSums = sums.slice(0, summaries)
    const room = Math.max(0, cap - opinions.length - keepSums.length)
    const keep = new Set([...opinions, ...keepSums, ...beliefs.slice(0, room)].map((r) => r.id))
    this.dropSemantic(worldId, agentId, all.filter((r) => !keep.has(r.id)).map((r) => r.id))
  }

  /** All goals the agent holds: authored (with sim progress) and their own. */
  agentGoals(worldId: string, agentId: string) {
    return this.db
      .select()
      .from(t.agentGoals)
      .where(and(eq(t.agentGoals.worldId, worldId), eq(t.agentGoals.agentId, agentId), eq(t.agentGoals.status, 'active')))
      .orderBy(asc(t.agentGoals.createdTick), asc(t.agentGoals.id))
      .all()
  }

  /** Agent-origin goals only: add, revise or drop. Authored goals can only be annotated. */
  upsertAgentGoal(worldId: string, agentId: string, g: { id: string; text: string; weight: number; status: 'active' | 'dropped'; note?: string; perceived?: number }, tick: number): 'created' | 'updated' | 'annotated' {
    const existing = this.db
      .select()
      .from(t.agentGoals)
      .where(and(eq(t.agentGoals.worldId, worldId), eq(t.agentGoals.agentId, agentId), eq(t.agentGoals.id, g.id)))
      .get()
    if (existing?.origin === 'authored') {
      this.setGoalBelief(worldId, agentId, g.id, g.perceived ?? existing.perceivedProgress ?? undefined, g.note ?? existing.note ?? undefined)
      return 'annotated'
    }
    if (existing) {
      this.db
        .update(t.agentGoals)
        // Anything not restated is kept, not wiped.
        .set({
          text: g.text,
          weight: g.weight,
          status: g.status,
          note: g.note ?? existing.note,
          perceivedProgress: g.perceived ?? existing.perceivedProgress,
          resolvedTick: g.status === 'dropped' ? tick : null,
        })
        .where(and(eq(t.agentGoals.worldId, worldId), eq(t.agentGoals.agentId, agentId), eq(t.agentGoals.id, g.id)))
        .run()
      return 'updated'
    }
    this.db
      .insert(t.agentGoals)
      .values({ worldId, agentId, id: g.id, text: g.text, weight: g.weight, origin: 'agent', status: g.status, note: g.note ?? null, perceivedProgress: g.perceived ?? null, createdTick: tick })
      .run()
    return 'created'
  }

  writeJournal(worldId: string, agentId: string, day: number, text: string): void {
    this.db
      .insert(t.journals)
      .values({ worldId, agentId, day, text })
      .onConflictDoUpdate({ target: [t.journals.worldId, t.journals.agentId, t.journals.day], set: { text } })
      .run()
  }

  journals(worldId: string, agentId?: string) {
    const conds = [eq(t.journals.worldId, worldId)]
    if (agentId) conds.push(eq(t.journals.agentId, agentId))
    return this.db.select().from(t.journals).where(and(...conds)).orderBy(asc(t.journals.day), asc(t.journals.agentId)).all()
  }

  lastReflectTick(worldId: string, agentId: string): number | null {
    return (
      this.db
        .select({ tick: sql<number>`max(${t.agentTurns.tick})` })
        .from(t.agentTurns)
        .where(and(eq(t.agentTurns.worldId, worldId), eq(t.agentTurns.agentId, agentId), eq(t.agentTurns.kind, 'reflect'), eq(t.agentTurns.status, 'ok')))
        .get()?.tick ?? null
    )
  }

  // ─── External memory outbox ──────────────────────────────────────────

  /**
   * An agent's memories not yet acknowledged by the external store, oldest
   * first: episodic rows at or above `minImportance`, and day summaries.
   */
  unsyncedMemories(worldId: string, agentId: string, minImportance = 3, limit = 25): { kind: 'episodic' | 'summary'; id: number; text: string; importance: number; tick: number }[] {
    const episodic = this.db.$client
      .prepare(
        `SELECT m.id, m.text, m.importance, m.tick FROM agent_memory_episodic m
         WHERE m.world_id = ? AND m.agent_id = ? AND m.importance >= ?
           AND NOT EXISTS (SELECT 1 FROM external_sync s WHERE s.world_id = m.world_id AND s.kind = 'episodic' AND s.local_id = m.id)
         ORDER BY m.id LIMIT ?`,
      )
      .all(worldId, agentId, minImportance, limit) as { id: number; text: string; importance: number; tick: number }[]
    const summaries = this.db.$client
      .prepare(
        `SELECT m.id, m.text, m.updated_tick AS tick FROM agent_memory_semantic m
         WHERE m.world_id = ? AND m.agent_id = ? AND m.kind = 'summary'
           AND NOT EXISTS (SELECT 1 FROM external_sync s WHERE s.world_id = m.world_id AND s.kind = 'summary' AND s.local_id = m.id)
         ORDER BY m.id LIMIT ?`,
      )
      .all(worldId, agentId, limit) as { id: number; text: string; tick: number }[]
    return [
      ...episodic.map((m) => ({ kind: 'episodic' as const, ...m })),
      ...summaries.map((m) => ({ kind: 'summary' as const, importance: 4, ...m })),
    ].sort((a, b) => a.tick - b.tick || a.id - b.id).slice(0, limit)
  }

  markSynced(worldId: string, kind: 'episodic' | 'summary', localId: number, externalRef: string): void {
    this.db.insert(t.externalSync).values({ worldId, kind, localId, externalRef, syncedAt: now() }).onConflictDoNothing().run()
  }

  clearSync(worldId: string): void {
    this.db.delete(t.externalSync).where(eq(t.externalSync.worldId, worldId)).run()
  }

  syncedCount(worldId: string): number {
    return this.db.select({ n: sql<number>`count(*)` }).from(t.externalSync).where(eq(t.externalSync.worldId, worldId)).get()?.n ?? 0
  }

  // ─── Turn log ────────────────────────────────────────────────────────

  logTurn(row: Omit<typeof t.agentTurns.$inferInsert, 'id' | 'createdAt'>): void {
    this.db.insert(t.agentTurns).values({ ...row, createdAt: now() }).run()
  }

  turnsSince(worldId: string, sinceMs: number, agentId?: string): number {
    const conds = [eq(t.agentTurns.worldId, worldId), gte(t.agentTurns.createdAt, sinceMs)]
    if (agentId) conds.push(eq(t.agentTurns.agentId, agentId))
    return this.db.select({ n: sql<number>`count(*)` }).from(t.agentTurns).where(and(...conds)).get()?.n ?? 0
  }

  turns(worldId: string, agentId?: string, limit = 50) {
    const conds = [eq(t.agentTurns.worldId, worldId)]
    if (agentId) conds.push(eq(t.agentTurns.agentId, agentId))
    return this.db.select().from(t.agentTurns).where(and(...conds)).orderBy(desc(t.agentTurns.id)).limit(limit).all()
  }

  // ─── World settings ──────────────────────────────────────────────────

  simVersion(worldId: string): number | null {
    const w = this.world(worldId)
    return w ? (P<{ simVersion?: number }>(w.extraJson, {}).simVersion ?? null) : null
  }

  world(worldId: string) {
    return this.db.select().from(t.worlds).where(eq(t.worlds.id, worldId)).get()
  }

  setRunning(worldId: string, running: boolean, speedMs?: number): void {
    this.db.update(t.worlds).set({ running, ...(speedMs ? { speedMs } : {}) }).where(eq(t.worlds.id, worldId)).run()
  }

  agentBackends(worldId: string): Record<AgentId, string> {
    const out: Record<AgentId, string> = {}
    for (const r of this.db.select({ id: t.agents.id, b: t.agents.backend }).from(t.agents).where(eq(t.agents.worldId, worldId)).all()) out[r.id] = r.b
    return out
  }

  eventsByTick(worldId: string, fromTick: number, toTick: number): SimEvent[] {
    return this.db
      .select()
      .from(t.events)
      .where(and(eq(t.events.worldId, worldId), gte(t.events.tick, fromTick), lte(t.events.tick, toTick)))
      .orderBy(asc(t.events.tick), asc(t.events.id))
      .all()
      .map(rowToEvent)
  }

  eventsById(ids: string[]): SimEvent[] {
    if (!ids.length) return []
    return this.db.select().from(t.events).where(inArray(t.events.id, ids)).all().map(rowToEvent)
  }
}

function intentToRow(worldId: string, i: Intent): typeof t.intents.$inferInsert {
  return {
    id: i.id,
    worldId,
    agentId: i.agentId,
    kind: i.kind,
    target: i.target ?? null,
    toLocation: i.to ?? null,
    payloadJson: i.say !== undefined || i.register !== undefined || i.fact !== undefined ? J({ say: i.say, register: i.register, fact: i.fact }) : null,
    reason: i.reason,
    weight: i.weight,
    source: i.source,
    createdTick: i.createdTick,
    expiresTick: i.expiresTick,
    appliedTick: i.appliedTick,
    status: i.status,
    rejectReason: i.rejectReason ?? null,
  }
}

function rowToIntent(r: typeof t.intents.$inferSelect): Intent {
  const payload = P<{ say?: string; register?: Intent['register']; fact?: string }>(r.payloadJson, {})
  const i: Intent = {
    id: r.id,
    agentId: r.agentId,
    kind: r.kind as Intent['kind'],
    reason: r.reason,
    weight: r.weight,
    source: r.source as Intent['source'],
    createdTick: r.createdTick,
    expiresTick: r.expiresTick,
    appliedTick: r.appliedTick,
    status: r.status as Intent['status'],
  }
  if (r.target) i.target = r.target
  if (r.toLocation) i.to = r.toLocation
  if (payload.say !== undefined) i.say = payload.say
  if (payload.register !== undefined) i.register = payload.register
  if (payload.fact !== undefined) i.fact = payload.fact
  if (r.rejectReason) i.rejectReason = r.rejectReason
  return i
}

function rowToEvent(e: typeof t.events.$inferSelect): SimEvent {
  const ev: SimEvent = {
    id: e.id,
    tick: e.tick,
    type: e.type as SimEvent['type'],
    text: e.text,
    magnitude: e.magnitude,
    privateTo: e.privateTo ? (JSON.parse(e.privateTo) as string[]) : null,
  }
  if (e.actorId) ev.actorId = e.actorId
  if (e.targetId) ev.targetId = e.targetId
  if (e.locationId) ev.locationId = e.locationId
  if (e.outcome) ev.outcome = e.outcome as SimEvent['outcome']
  if (e.dataJson) ev.data = JSON.parse(e.dataJson)
  return ev
}
