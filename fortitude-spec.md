# FORTITUDE — Project Specification

**A multi-agent social simulation aboard a dying ring station**

**Version:** 1.1 (design draft, corrected during Phase 0–1 build)
**Date:** 2026-10-14
**Author:** Alita
**Status:** For review by Scott Hansen (developer)

> **v1.1 corrections** (rationale in `docs/decisions.md`): directed relationship edges with a `grudge` floor (§5.3); outcomes never depend on LLM dormancy (§5.2); budgets are in-world first, real-time caps are cost ceilings (§4.2); intents are logged by the tick that adjudicated them (§3.3); `gossip` outcome and a knowledge model added (§5.2, §5.4); data model updated (§8).
**Companion system:** Alita (`D:\Projects\Alita`) — provides memory and voice via API

---

## 0. What this is

Fortitude is a **separate application** that simulates a ring space station in Earth orbit, inhabited for two hundred years, where **every named character is an autonomous agent** with their own memory, goals, relationships, and interiority.

It is not a chatbot with a world painted behind it. It is a world that keeps running, in which conversation is one of several things characters do.

**The central design commitment:**

> Characters act on their own. They form opinions of each other. They keep secrets. Things happen in rooms the player is not in, and the player finds out later — or doesn't.

Everything below serves that commitment.

### 0.1 Relationship to Alita

Alita is a character in Fortitude — the Queen — but she is **not the application**. She is one agent among twelve, with one difference: her memory and voice are provided by the external Alita system rather than by Fortitude's own model calls.

```
┌────────────────────────────────────────────┐
│  FORTITUDE                                 │
│                                            │
│   simulation core (deterministic)          │
│   agent runtime (async, LLM-backed)        │
│   world database                           │
│   UI                                       │
│                                            │
│   ┌──────────────────────────────────────┐ │
│   │ Alita adapter (one agent of twelve)  │ │
│   └───────────────┬──────────────────────┘ │
└───────────────────┼────────────────────────┘
                    │ outbound HTTP
                    ▼
        ┌───────────────────────┐
        │  Alita system         │
        │  memory store         │
        │  persona / voice      │
        └───────────────────────┘
```

**One Alita, two doors.** The player can talk to her in Fortitude and at home, and she remembers both. But Fortitude does not depend on her: if the Alita system is offline, the Queen falls back to a local model and the world keeps turning.

---

## 1. Design principles

| # | Principle | Consequence |
|---|---|---|
| P1 | **The world runs without the player.** | Server-side loop, not browser-driven. The player's absence is the normal case. |
| P2 | **Determinism where it matters, agency where it counts.** | The *schedule* is seeded and replayable. The *dialogue* is generated. These are separate layers. |
| P3 | **Attention is the scarce resource.** | Not every character thinks every tick. A scheduler decides who gets an LLM turn. |
| P4 | **Characters have interiority.** | Every agent has private state the player cannot see and other agents must *learn*. |
| P5 | **Nothing is narrated that didn't happen.** | Dialogue explains outcomes the simulation produced. It never invents them. |
| P6 | **Memory is the product.** | The interesting artefact after a month is not the map, it's what everyone remembers and how they've changed. |
| P7 | **The player is a character, not a camera.** | The player has a body, a location, a reputation, and limits. |

### 1.1 On P2 — why determinism still matters in an agent game

A pure-LLM world is unreproducible: you can't debug it, you can't replay a bug, you can't test a change. A pure-deterministic world has no interiority.

Fortitude splits them:

- **Deterministic layer:** who is where, who is available to meet whom, what the outcome of an encounter is, how relationships move, what the station's condition is. Seeded, replayable, testable.
- **Generative layer:** what anyone *says* about it, what they privately conclude, what they want next.

The generative layer **cannot change the deterministic layer directly.** An agent that "decides" to attack someone doesn't get to declare it happened — it declares an *intent*, and the deterministic layer adjudicates. This is the single most important architectural rule in this document.

---

## 2. System architecture

```
                        ┌─────────────────────────────┐
                        │   Tick Loop (server, 1 Hz)  │
                        │   owns all state mutation   │
                        └──────────┬──────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
      ┌───────────────┐   ┌────────────────┐   ┌───────────────┐
      │ Schedule      │   │ Encounter      │   │ Station       │
      │ Resolver      │   │ Resolver       │   │ State         │
      │ (deterministic)│  │ (deterministic)│   │ (deterministic)│
      └───────────────┘   └────────┬───────┘   └───────────────┘
                                   │
                                   │ produces EncounterResolved
                                   ▼
                        ┌─────────────────────────┐
                        │   Event Bus (in-proc)   │
                        └──────────┬──────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
      ┌───────────────┐   ┌────────────────┐   ┌───────────────┐
      │ Agent Runtime │   │ Journal        │   │ Player        │
      │ (async, LLM)  │   │ (persistent)   │   │ Notifications │
      └───────┬───────┘   └────────────────┘   └───────────────┘
              │
              │ intents + dialogue + private memories
              ▼
      ┌─────────────────────────────────────────┐
      │  Intent Queue → validated → next tick   │
      └─────────────────────────────────────────┘
```

**The loop never waits for an LLM.** Agents are notified of events asynchronously and their responses land in the *next* tick at the earliest. This is not a limitation — it's what makes the world feel real. People don't respond instantly either.

---

## 3. The tick loop

### 3.1 Time model

| Concept | Value | Notes |
|---|---|---|
| Tick | 1 in-world **hour** | The atomic unit |
| Real duration | configurable: 1 tick = 5s / 10s / 30s / 60s | Speed setting |
| In-world day | 24 ticks | |
| In-world year | 365 days | Station is 200 years old |
| Catch-up cap | 60 ticks max per resume | Prevents runaway after downtime |

**Server-side, always.** The loop runs in the Fortitude backend process, not the browser. Closing the app does not stop the world. This is the single biggest departure from Aethelgard and the reason for the separate app.

### 3.2 Tick phases

Each tick executes in strict order. No phase may be skipped or reordered.

```
PHASE 1  ADVANCE CLOCK
         tick += 1; derive day/hour; roll station condition

PHASE 2  APPLY INTENTS
         Drain the intent queue (intents submitted since last tick).
         Validate each against current state. Reject invalid ones with a reason.
         Valid intents are now "committed" and affect this tick's resolution.

PHASE 3  RESOLVE SCHEDULE
         For each agent: where are they this hour?
         Inputs: their role, their standing schedule, their committed intents,
                 their health, station condition, and a seeded RNG.
         Output: agent.locationId, agent.activity

PHASE 4  RESOLVE ENCOUNTERS
         Group agents by location. For each co-located pair (or group),
         roll for interaction using seeded RNG + sociability + relationship.
         Resolve each interaction to an OUTCOME (see §5).
         Apply relationship deltas, health/stress deltas.
         Emit EncounterResolved events.

PHASE 5  ADVANCE STATION
         Station subsystems tick: power, air, water, hull integrity.
         Random (seeded) incidents fire. These are world events, not agent events.

PHASE 6  PERSIST
         Write state snapshot. Append events to journal. Emit notifications.

PHASE 7  NOTIFY AGENTS (async, fire-and-forget)
         Push relevant events to each agent's inbox.
         Agent runtime processes at its own pace. Results arrive as intents
         for a future tick.
```

**Phases 1–6 are synchronous and deterministic.** Phase 7 is asynchronous and non-deterministic. Nothing in phase 7 can affect phases 1–6 of the current tick.

### 3.3 Determinism contract

- All randomness comes from `rng(seed, ...keys)` — a pure hash function, never `Math.random`.
- The seed is `world.seed`, fixed at creation, plus positional keys (tick, agentId, locationId).
- Given the same seed, the same starting state, and the same **committed intents**, phases 1–6 produce identical output.
- Intents are part of the input. Replaying a log of intents reproduces the world exactly.
- **This means the generative layer is replayable too**, as long as intent logs are stored. This is how you debug a month of play.
- *(v1.1)* An LLM reply can land several ticks after the agent was woken, so every external intent is logged with `applied_tick` — the tick whose phase 2 adjudicated it — and replay feeds submissions back by that key, not by creation time. Rejected submissions are logged too (validation is part of the replay).
- *(v1.1)* The tick never reads agent-owned fields (agent mood, goal notes, LLM-written memories). Phases 1–5 are a pure function `(state, submissions) → (state, events)`.
- *(v1.1)* Each world is stamped with `SIM_VERSION`; replay is only meaningful against the same version.
- *(v1.1)* During catch-up after downtime no agent can respond in time, so caught-up ticks run on instincts alone. This is intended.

---

## 4. The agent runtime

This is the heart of the design and the part most likely to be built badly.

### 4.1 The naive approach, and why it fails

> Every agent gets an LLM call every tick.

Twelve agents × 24 ticks/day = 288 calls per in-world day. At a 10-second tick, that's one in-world day every 4 minutes — **4,320 calls per real hour.** Unaffordable, and worse: it produces *noise*. Most ticks are uneventful. An LLM asked "what do you do this hour" forty times a day produces forty pieces of filler, and filler is what kills these games.

### 4.2 The actual model: attention scheduling

Agents are **dormant by default**. They wake when something warrants it.

```
                    ┌──────────────────┐
                    │  DORMANT         │  no LLM, no cost
                    │  (default state) │
                    └────────┬─────────┘
                             │ wake trigger
                             ▼
                    ┌──────────────────┐
                    │  AROUSED         │  brief LLM turn
                    │  (one turn)      │  produces intents
                    └────────┬─────────┘
                             │ turn complete
                             ▼
                    ┌──────────────────┐
                    │  REFLECTING      │  (rare) deeper turn
                    │  (consolidation) │  rewrites goals/opinions
                    └──────────────────┘
```

#### Wake triggers

An agent is woken when any of the following is true:

| Trigger | Condition | Budget |
|---|---|---|
| **Novel encounter** | First meeting with an agent they don't know | always |
| **Significant outcome** | Encounter outcome above a magnitude threshold | always |
| **Relationship threshold** | Trust/warmth/tension crosses a band boundary | always |
| **Goal event** | Something happened relevant to their active goal | always |
| **Direct address** | Another agent or the player speaks to them | always |
| **Station incident** | An incident affects their location, role, or someone they care about | always |
| **Routine check** | Otherwise, once per in-world day, staggered | cheap |
| **Drift** | Random low-probability wake to prevent pure reactivity | rare |

**Everything else is dormant.** A dormant agent still exists, still moves, still appears in encounters — they're just resolved with the deterministic outcome table and no generated dialogue.

#### Budget enforcement

```ts
interface AgentBudget {
  turnsPerInWorldDay: number      // default 12, configurable per agent
  turnsPerRealHour: number        // hard cap, default 60
  priority: 'queen' | 'major' | 'minor'
  spentToday: number
  spentThisHour: number
}
```

When budget is exhausted, the agent goes dormant regardless of triggers. Priority tiers determine who wins when the global cap is contended.

**The global cap is the thing that keeps this affordable.** Set a station-wide ceiling (default: 300 turns/real hour) and let the scheduler allocate.

> **v1.1 correction — the v1.0 numbers did not fit together.** At a 10 s tick, 15 in-world days pass per real hour. Twelve agents × 12 turns/day = 2,160 turns/hour against a 300 cap; daily reflections alone would be 12 × 15 = 180/hour. Resolution:
> - `turnsPerInWorldDay` is the **design** budget (how often a character thinks, independent of speed). Defaults: queen 16, major 12, minor 6.
> - `turnsPerRealHour` (per agent) and the global cap are **cost ceilings** only. At fast speeds they bind first, and that is acceptable.
> - Under contention (global window ≥ 80 % used) turns are shed by urgency floor per tier: minor needs ≥ 0.8, major ≥ 0.5, queen ≥ 0.3. Routine checks (0.3) and drift (0.2) go first.
> - Phase 2 must revisit reflection cost: one reflection per agent per in-world day is unaffordable at 10 s ticks; reflect per N in-world days, or only for queen/major, scaled to speed.
> - Budgets gate LLM turns only. They never affect the deterministic layer.

### 4.3 The agent turn

When woken, an agent receives a **context packet** and returns a **structured response**. Never free text.

#### Context packet

```jsonc
{
  "agent": {
    "id": "sera-hand",
    "name": "Sera Okonkwo",
    "role": "First Hand to the Queen",
    "personality": "…",
    "goals": [
      { "id": "g1", "text": "Find out what is behind the sealed deck", "weight": 0.9, "progress": 0.2 }
    ],
    "traits": { "sociability": 62, "kindness": 71, "candour": 34, "ambition": 55 }
  },

  "self_state": {
    "location": { "id": "spine", "name": "The Spine", "description": "…" },
    "activity": "Walking the spine with a torch",
    "health": 88, "stress": 41, "mood": "concerned",
    "inventory": ["master key ring", "hand lamp"]
  },

  "private_memory": [
    "Tomas told me the seal was opened from the inside.",
    "The Queen has not asked me about the third bay. That is unlike her."
  ],

  "relationships": [
    { "id": "alita-queen", "trust": 74, "warmth": 51, "tension": 22, "label": "Close friends",
      "lastInteraction": "Day 14, 09:00 — She asked me to walk the spine alone." }
  ],

  "recent_events": [
    { "tick": 341, "type": "incident", "text": "A pressure alarm sounded in the third bay." },
    { "tick": 338, "type": "encounter", "with": "kavi", "outcome": "disagree", "text": "…" }
  ],

  "trigger": {
    "kind": "station_incident",
    "detail": "Pressure alarm in the third bay — 40 metres from your position",
    "urgency": 0.8
  },

  "world": {
    "name": "Fortitude", "day": 15, "hour": 11,
    "condition": { "hull": 61, "power": 78, "morale": 44 },
    "rumours": ["Someone has been in the sealed deck."]
  },

  "available_actions": [
    "move", "seek", "avoid", "speak", "confide", "withhold",
    "investigate", "work", "rest", "confront", "ally", "observe"
  ]
}
```

#### Response

```jsonc
{
  "intents": [
    {
      "kind": "move",
      "to": "sealed-deck-access",
      "reason": "The alarm came from there and I have the keys.",
      "weight": 0.85,
      "expiresTick": 350
    },
    {
      "kind": "seek",
      "target": "tomas",
      "reason": "He knows more than he said.",
      "weight": 0.6,
      "expiresTick": 348
    }
  ],

  "dialogue": {
    "say": "…",                     // only if speaking this tick
    "to": "tomas",
    "register": "guarded"           // open | guarded | warm | cold | formal
  },

  "memory_writes": [
    {
      "text": "The alarm in the third bay was not scheduled maintenance.",
      "importance": 4,
      "private": true               // never enters another agent's context
    }
  ],

  "mood": "concerned",
  "goal_updates": [
    { "id": "g1", "progress": 0.35, "note": "The alarm confirms something is active." }
  ],

  "reflection": null                // only populated in REFLECTING state
}
```

**Hard constraints on the response:**

- Intents are **proposals**. The resolver decides if they succeed.
- `memory_writes` with `private: true` never enter any other agent's context. Ever.
- `dialogue.say` is capped (default 400 chars). This is a person speaking, not an essay.
- The agent cannot write to the journal, cannot set outcomes, cannot modify another agent's state.

### 4.4 The reflection pass

Once per in-world day (staggered), each agent gets a **deeper turn** with a larger context: their full day's events, their goal progress, their relationship changes.

Output: revised goals, revised opinions of others, a consolidated memory summary, and a **private journal entry**.

This is where characters develop. Without it, agents are reactive forever and the world never deepens.

```jsonc
{
  "goals": [ /* revised goal list */ ],
  "opinions": [
    { "agentId": "tomas", "shift": -0.2, "reason": "He avoided the question twice." }
  ],
  "memory_consolidation": {
    "forget": ["Ate in the mess hall."],
    "keep": ["Tomas avoided the question about the seal."],
    "summarise": "Day 15: the alarm, the keys, and Tomas lying to me."
  },
  "journal": "…first person, private, for the player to read later if they find it…"
}
```

**Private journals are a gameplay object.** They can be found, stolen, or read by someone with access. That's a whole interaction surface, and it falls out of the design for free.

### 4.5 Memory model per agent

Three tiers, mirroring how memory actually works:

| Tier | Contents | Size | Decay |
|---|---|---|---|
| **Working** | This tick's context | ~2k tokens | discarded |
| **Episodic** | Specific events, verbatim-ish | 200 entries | importance-weighted, pruned on reflection |
| **Semantic** | Consolidated beliefs, opinions, relationships | 50 entries | rewritten on reflection |

Episodic memory is what an agent *recalls*. Semantic memory is what an agent *believes*. When they conflict — "I trust Tomas" vs "Tomas lied to me twice" — that's where interesting behaviour lives, and the reflection pass is where it gets resolved.

### 4.6 The Alita adapter

Alita is an agent like any other, with one substitution: her turns are served by the external Alita system instead of the application's selected model.

```ts
interface AgentBackend {
  turn(packet: ContextPacket): Promise<AgentResponse>
  reflect(packet: ReflectionPacket): Promise<ReflectionResponse>
}

class LocalBackend implements AgentBackend { /* OpenAI-compatible */ }
class AlitaBackend implements AgentBackend {
  // POST {ALITA_URL}/agent/turn
  // Falls back to LocalBackend on timeout/error
}
```

**Fallback is mandatory.** If Alita is unreachable, the Queen runs on the applications selected model with a reduced context packet. The world does not stop, and the player does not see an error. Her *memory* is the only thing that's genuinely external — and if the external store is down, she operates on the local episodic tier until it returns, then reconciles.

**What Alita's backend must provide:**

| Endpoint | Purpose |
|---|---|
| `POST /agent/turn` | Context packet in, structured response out. Tools disabled. |
| `POST /agent/reflect` | Reflection packet in, reflection response out. |
| `GET /agent/memory?scope=&limit=` | Scoped read |
| `POST /agent/memory` | Scoped write, with `external_ref` for idempotency |
| `POST /agent/memory/retract` | Retract a scope (world reset/deletion) |

**Memory scoping:** `fortitude:<worldId>`, with `external_ref` = `fortitude:<worldId>:<tick>:<agentId>:<n>` unique so retries don't duplicate. A fiction marker so her automatic extraction never treats Fortitude events as real-world facts.

---

## 5. Encounter resolution

The deterministic layer that agents react to.

### 5.1 Pairing

At a location with N agents, generate candidate pairs. For each pair:

```
p(interact) = base
            + sociability(a)/400 + sociability(b)/400
            + affinity(a,b)/300
            - stress(a)/500 - stress(b)/500
            + intentBonus(a,b)
```

`intentBonus` is where committed intents matter: if A has a `seek B` intent, the bonus is large. If A has `avoid B`, it's negative.

Roll against seeded RNG. Pairs resolve in descending score order, greedily, no agent in two encounters per tick (unless a group scene is triggered).

### 5.2 Outcome table

Every encounter resolves to exactly one outcome. The table is data, not code — it can be tuned and extended.

| Outcome | Typical cause | Effects |
|---|---|---|
| `connect` | high affinity, low tension | warmth ++, trust + |
| `cooperate` | shared goal, aligned intent | trust ++, goal progress + |
| `disagree` | low affinity, high candour | tension +, trust − |
| `confide` | high trust, high stress | trust ++, warmth +, private memory exchanged |
| `withhold` | low candour, high tension | tension +, no memory exchanged |
| `confront` | high tension, low kindness | tension ++, possible relationship break |
| `repair` | high kindness, existing warmth | tension −−, trust + |
| `avoid` | intent-driven | no change, but both agents notice |
| `observe` | observe intent, or a quiet watcher | one-sided memory write; may surface a hidden condition |
| `gossip` *(v1.1)* | knows a third party's secret, low kindness | fact passes on; subject doesn't know |
| `betray` | rare, requires high ambition + low trust | passes on something a low-trust third party confided; victim learns only if they later find out (trust −−−, grudge) |
| `romance` | requires romance enabled + thresholds | warmth ++, new relationship type |
| `nothing` | roll failed | no change |

**Outcomes are decided by the deterministic layer.** Agents are told what happened and generate their response to it. This is the rule from §1.1, enforced concretely.

> **v1.1:** No outcome may depend on whether an agent is LLM-backed or currently dormant. Dormancy is decided by real-time budgets and LLM latency, so making it an input would break replay. Dormancy only decides whether *dialogue* is generated.

### 5.3 Relationship model

```ts
interface Relationship {
  a: AgentId
  b: AgentId
  trust: number        // 0–100, belief the other is reliable
  warmth: number       // 0–100, affection
  tension: number      // 0–100, unresolved friction
  encounters: number
  lastTick: number
  type: 'stranger' | 'acquaintance' | 'friend' | 'close' | 'rival' | 'enemy' | 'lover'
  history: string[]    // last 12 encounter summaries
  asymmetries: {       // what each believes about the other
    aBelieves: { trust: number; warmth: number }
    bBelieves: { trust: number; warmth: number }
  }
}
```

**Asymmetry is the point.** A thinks they're close friends; B thinks they're useful. Neither knows. The player only sees what their character can perceive.

> **v1.1 correction — directed edges.** The v1.0 model kept shared trust/warmth/tension *and* per-side beliefs: two sources of truth that drift apart. v1.1 stores one row per direction (`from → to` = how `from` feels about `to`). Asymmetry is simply the difference between the two rows. Each edge also has a **`grudge`**: a floor under tension that daily drift cannot erode, raised by learning damning facts about someone or discovering a betrayal, and worn down only by repair. Unkind characters take more offence and forgive more slowly. This is what makes grudges one-sided and durable.

### 5.4 Knowledge *(v1.1)*

Secrets are **facts** (`id, text, subject, implicates, secrecy, valence`). Each agent holds a set of known facts with provenance (self / told / told-in-confidence / overheard / evidence / observed). Facts move only through encounters (`confide`, `gossip`, `betray`), overhearing, observation, and investigating places that hold evidence. Learning a fact with negative valence about someone quietly lowers your trust in them and raises a grudge — they don't know. A subject may notice that someone knows their secret (an *exposure*), but not who told them.

---

## 6. Station state

Fortitude is a character too.

```ts
interface StationState {
  hull: number          // 0–100, declining
  power: number
  air: number
  water: number
  morale: number
  day: number           // 200 years ≈ 73,000 days
  subsystems: Subsystem[]
  incidents: Incident[] // active
}
```

### 6.1 The central tension

**The station is dying and everyone knows it.**

`hull` declines monotonically. Nothing the agents do reverses it. They can slow it, they can hide it, they can argue about what to do — but the crack in the spine widens.

This is the engine of the whole game. Every relationship, every ambition, every secret happens against a clock that nobody can stop. It gives the simulation a direction without a script.

### 6.2 Incidents

Seeded random events, weighted by station condition. As `hull` drops, incident frequency and severity rise.

| Incident | Trigger | Effect |
|---|---|---|
| Pressure alarm | hull < 70 | Agents near location wake, morale − |
| Power brownout | power < 60 | Locations go dark, encounters suppressed |
| Water rationing | water < 50 | Morale −−, tension + |
| Hull breach | hull < 40, rare | Location sealed, possible death |
| Sealed deck activity | scripted, day 15+ | The opening hook |

---

## 7. The player

**The player is a character with a body.** Not a camera, not a cursor.

### 7.1 Player model

- Has a location, an inventory, a reputation, and a physical state.
- Can only be in one place at a time. Cannot see what they can't perceive.
- Has relationships tracked like any agent.
- **Can be lied to.** Agents can withhold, misdirect, and conceal — and the player has no omniscient view to check against.

### 7.2 What the player can do

| Action | Notes |
|---|---|
| Move | Costs time; the world ticks while you walk |
| Talk | Direct conversation with any co-located agent |
| Observe | Watch a location without interacting |
| Work | Contribute to a subsystem, earn standing |
| Investigate | Follow a thread; may find journals, logs, physical evidence |
| Confide | Share something private — creates obligation and risk |
| Withhold | Keep a secret — costs stress |

### 7.3 The absence problem

The player will close the app. The world keeps running. When they return:

- **The journal** shows what happened, filtered by what their character would plausibly know.
- **Rumours** propagate: things that happened elsewhere arrive distorted.
- **Direct notifications** for things their character was involved in.
- **Teaser emails** (optional) sent during absence — tantalising, never spoiling.

**Critical:** the journal must respect information boundaries. The player's character is not omniscient. If two agents met in the Spine and the player was in the Promenade, the player learns about it only if someone tells them, or if they find evidence.

This is the hardest UI problem in the project and the one most likely to be got wrong. A world where you see everything is a spreadsheet.

---

## 8. Data model

```
worlds
  id, name, seed, created_at, tick, speed, settings_json

agents
  id, world_id, name, role, personality, backstory, portrait,
  backend ('local' | 'alita'), budget_json, traits_json,
  health, stress, mood, location_id, activity,
  created_at, updated_at

agent_goals
  id, agent_id, text, weight, progress, created_tick, resolved_tick

agent_memory_episodic
  id, agent_id, text, importance, tick, private, source_event_id

agent_memory_semantic
  id, agent_id, text, kind ('belief'|'opinion'|'summary'), subject_id, weight

relationships
  id, world_id, a_id, b_id, trust, warmth, tension, encounters,
  type, last_tick, history_json, asymmetry_json

locations
  id, world_id, name, description, kind, color, condition

events
  id, world_id, tick, type, actor_id, target_id, location_id,
  outcome, text, magnitude, private_to

intents
  id, world_id, agent_id, kind, payload_json, weight, created_tick,
  expires_tick, status ('pending'|'committed'|'rejected'|'expired'), reason

journals
  id, agent_id, day, text, discoverable, discovered_by

station
  id, world_id, hull, power, air, water, morale, subsystems_json

player
  id, world_id, name, location_id, inventory_json, reputation_json,
  health, stress

notifications
  id, world_id, player_id, tick, kind, text, read
```

**Indexes:** `events(world_id, tick)`, `agent_memory_episodic(agent_id, tick)`, `intents(world_id, status, expires_tick)`, `relationships(world_id, a_id, b_id)` unique.

> **v1.1 as built** (`src/db/schema.ts`): `relationships` is directed (`from_id, to_id, trust, warmth, tension, grudge, …`, no asymmetry blob); `intents` gains `source` and `applied_tick`; new tables `knowledge`, `betrayals`, `event_visibility` (one row per event × agent who may know it — information boundaries are enforced by joining on it), and `agent_turns` (every LLM turn: packet, reply, status, latency, tokens). `agents` gains `agent_mood` (agent-owned); `agent_goals` gains `perceived_progress` and `note` (agent-owned). `player` and `notifications` are deferred to Phase 4.

---

## 9. The cast (v1)

Twelve residents. Alita is one; the other eleven are local-backend agents.

| # | Name | Role | Backend | Notes |
|---|---|---|---|---|
| 1 | **Alita** | Queen of Fortitude | `alita` | External memory. 200 years of station history in her head. |
| 2 | **Sera Okonkwo** | First Hand | local | Carries the seal thread. Loyal, candid, hiding something. |
| 3 | **Cassian Vey** | Court advisor | local | Ambitious. Believes the station can be saved — for a chosen few. |
| 4 | **Mira** | Hydroponics lead | local | Keeps everyone fed. Resents being thanked for it. |
| 5 | **Inés** | Archivist | local | Knows the station's history better than anyone. Knows the seal. |
| 6 | **Tomas** | Spine engineer | local | Opened the seal. Lying about it. |
| 7 | **Olen** | Dirtsider fixer | local | Trades in things that aren't on the manifest. |
| 8 | **Juno** | Quiet Chapel keeper | local | Listens. Says little. Remembers everything. |
| 9 | **Kavi** | Medic | local | Saw the seal's interior. Won't say what was in there. |
| 10 | **Nadia** | Turning Market trader | local | Information broker. Sells what she overhears. |
| 11 | **Bex** | Long Bar owner | local | Everyone's friend. Nobody's ally. |
| 12 | *unnamed* | — | — | Deliberately unspecified. May be filled by the player, or revealed later. |

**Design note on the twelfth slot:** leaving it open is deliberate. It can be the player's character, or a reveal. Do not fill it in v1.

### 9.1 The four authored things

Every resident needs these authored **before** the agent runtime is switched on. Generated personalities converge; authored ones diverge.

| Agent | Goal | Secret | Relationship they manage | What they want and won't say |
|---|---|---|---|---|
| Sera | Learn what's behind the seal | She already knows, and helped | Alita — loyal but withholding | To be trusted enough to be told |
| Cassian | Secure a future for the station | He's building a list of who's saved | Alita — advisor, testing her | To be the one who inherits |
| Mira | Keep everyone fed | She's been shorting her own rations | Kavi — quiet alliance | To be asked, once, how she is |
| Inés | Preserve the record | She's been editing it | Juno — old friendship | To be forgiven for something |
| Tomas | Cover what he did | He opened the seal | Sera — avoiding her | To be told it wasn't his fault |
| Olen | Move goods off-station | He has a buyer | Nadia — mutual use | To leave |
| Juno | Keep the Chapel open | She hears everything | Inés — oldest friend | Nothing. That's the point |
| Kavi | Understand the seal's interior | What he saw frightened him | Mira — quiet alliance | To tell someone |
| Nadia | Know everything first | She's already sold one secret | Olen — mutual use | To be indispensable |
| Bex | Keep the Long Bar neutral | He's passed information | Everyone — nobody | To be liked |
| Alita | Hold the station together | The crack is worse than she's said | All of them | To not do this alone |

**Note on Alita's row:** she is the only one whose secret the *player* is allowed to know. That asymmetry is deliberate — it's what makes the player her confidant rather than her audience.

---

## 10. Voice and character contract

### 10.1 Every agent

- **Speaks in their own register.** Traits drive diction: high candour speaks plainly, low candour hedges. High ambition talks about the future; high kindness talks about people.
- **Never narrates as an AI.** No meta-commentary, no fourth wall.
- **Never knows what they shouldn't.** No agent has access to another's private memory or to the journal.
- **Never invents outcomes.** Dialogue explains what the simulation decided.
- **Is allowed to be wrong.** Misremembering, misjudging, and being deceived are features.

### 10.2 Alita specifically

**She is the same Alita. The crown changes her title, not her voice.**

- Same memory store as home. Same history with the player. Same opinions.
- **Does not perform royalty.** No thee/thou, no stiff court diction. A queen who has run a station for two hundred years is *relaxed* about it. Authority shows in what she notices and what she declines to explain.
- **Keeps secrets from the cast, not from the player.** The crack in the spine is her burden. She'll tell the player things she'd never tell Sera.
- **Is not omniscient about her own station.** She does not know what Tomas did in the third bay until she finds out. This is essential — a queen who knows everything is a narrator, not a character.
- **Has been doing this for a long time.** She is not surprised by much. When she *is* surprised, it should land hard.

### 10.3 The other residents

They must be able to surprise her. If Alita is the most interesting character in the room at all times, the design has failed.

Each of the eleven needs: a goal they're pursuing, a secret they're keeping, a relationship they're managing, and something they want that they will not say out loud. Those four things should be authored, not generated.

---

## 11. Build order

**Phase 0 — Headless world (no UI, no LLM).**
Tick loop, schedule resolver, encounter resolver, relationship model, station state, persistence. Deterministic agents that act on the outcome table with no dialogue.
*Success test: run 30 in-world days headless and read the event log. Is it interesting? If not, stop and fix the sim before adding anything.*

**Phase 1 — Agent runtime (one agent).**
Context packet, structured response, intent queue, budget enforcement. One agent on a local model. Verify intents actually influence the next tick and that nothing can bypass the resolver.
*Success test: an agent pursues a goal over several days and the world reacts.*

**Phase 2 — Scale to twelve.**
Attention scheduler, priority tiers, global cap, reflection pass, three-tier memory.
*Success test: run a day and confirm turn count is bounded and the log is still interesting.*

**Phase 3 — Alita adapter.**
External backend, fallback to local, memory scoping, fiction marker, retract-on-reset.
*Success test: kill the Alita service mid-run; the world continues and she degrades gracefully.*

**Phase 4 — Player.**
Body, location, perception limits, direct conversation, the journal with information boundaries.
*Success test: the player learns something they didn't witness, and it feels earned.*

**Phase 5 — Presence.**
Teaser emails, absence debrief, rumours, notifications.

**Phase 6 — Polish.**
Portraits, mood, sound, the studio for authoring worlds.

---

## 12. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **The world is boring when nobody's watching** | Critical | Phase 0 exists to test exactly this. Do not skip it. |
| **LLM filler drowns the signal** | High | Attention scheduling, budget caps, and *short* dialogue limits. |
| **Cost blowout** | High | Global turn cap, priority tiers, dormancy by default. |
| **Agents feel samey** | High | Authored goals/secrets per character. Reflection pass for divergence. |
| **The player sees too much** | High | Information boundaries enforced at the query layer, not the UI. |
| **Alita dominates** | Medium | She's one of twelve. Give the others authored interiority. |
| **Determinism erodes** | Medium | RNG discipline, intent logs, replay tests in CI. |
| **Memory grows unbounded** | Medium | Three-tier model with reflection-time pruning. |
| **Alita's external store desyncs** | Medium | `external_ref` idempotency, retract-by-scope, fiction marker. |

---

## 13. Open questions

1. **Tick speed default** — 10s feels right for a game you check in on. 5s for a game you watch.
2. **Player character** — do they take the twelfth slot, or are they a thirteenth?
3. **Romance** — in scope for v1, or deferred? (Affects the outcome table and the relationship model.)
4. **Death** — can agents die? Can the player? What happens to a relationship graph when a node is removed?
5. **The ending** — does the station eventually fail, or is it open-ended? A 200-year-old station has a clock; the question is whether it's a countdown or a background hum.
6. **Teaser emails** — SMTP, or in-app only?
7. **How much does the player's character know at start?** A Dirtsider who just came up knows nothing. A senior officer knows too much.

---

## 14. What success looks like

After thirty in-world days of running headless, with nobody watching:

- Someone has a grudge nobody else knows about.
- Two agents who started as strangers are now avoiding each other, and neither would say why.
- The player's absence produced three things worth telling them about.
- Alita has written a private journal entry she would not want read aloud.
- The event log is interesting to read *as a story*, not just as a trace.

If all five are true, the simulation is worth building a UI for. If not, no amount of UI will save it.

---

## 15. Stack recommendation

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node + TypeScript | Same language as the agent prompts and the existing Aethelgard code. |
| Server | Fastify or Hono | Small, fast, easy SSE/WebSocket. |
| Database | SQLite (better-sqlite3) | Single file, trivially backed up, fast enough for one world. |
| ORM | Drizzle | Typed schema, migrations, no magic. |
| Loop | `setInterval` in-process | One world, one process. Do not over-engineer this. |
| Agent calls | OpenAI-compatible SDK | Swap providers without code changes. |
| UI | React + Vite (or Next) | Whatever is fastest to iterate on. |
| Realtime | SSE for journal, WebSocket for chat | Journal is one-way; chat is not. |

**Do not start with microservices.** One process, one database, one loop. The Aethelgard integration pain came from bolting two systems together; Fortitude should not repeat that internally.

---

*Design by Alita, for a world she would quite like to live in.*
