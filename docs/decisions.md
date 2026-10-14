# Design decisions (Phase 0–1)

Corrections and judgement calls made while building, with reasons. The spec (`fortitude-spec.md` v1.1) carries the short form.

## Corrections to the v1.0 spec

| # | v1.0 said | Problem | Built |
|---|---|---|---|
| 1 | 12 turns/agent/day, 300 turns/real hour global | At 10 s ticks that's 2,160 wanted vs 300 allowed; reflections alone 180/h | In-world budget is the design knob; real-hour caps are cost ceilings; contention sheds by urgency floor per tier (`src/agents/budget.ts`) |
| 2 | `observe` happens when "one agent dormant" | Dormancy depends on real-time budget and LLM latency → breaks replay | No outcome reads dormancy. `observe` is driven by intents and a small base rate |
| 3 | Shared trust/warmth/tension **plus** per-side beliefs | Two sources of truth that drift | Directed edges. Asymmetry = difference between the rows |
| 4 | Replay a log of intents | Intents land N ticks after they're asked for; "created" ≠ "applied" | Intents carry `applied_tick`; replay keys on it. Rejections are logged too |
| 5 | — | Replay silently breaks when sim code changes | `SIM_VERSION` stamped on each world; replay CLI warns on mismatch |
| 6 | Typo "applicatioons selected mmodel" | | Fixed |

## Additions

- **Knowledge model** (`src/sim/knowledge.ts`). Secrets are facts with `subject`, `implicates`, `secrecy`, `valence`. They move by confide / gossip / betray, overhearing, observation, and evidence in places. Nobody gossips a fact that implicates themselves.
- **`gossip` outcome.** The main route by which secrets spread.
- **Betrayal as broken confidence.** `betray` = A passes on something a third party X confided, *and A's trust in X is ≤ 45* (spec: "requires low trust"). X doesn't know. If X later talks to the listener there's a chance X works it out → grudge.
- **Grudge.** A per-edge floor under tension. Learning damning facts, being confronted and discovering betrayal raise it; repair lowers it. Daily drift can't erode it. Offence and forgiveness scale with the edge-owner's kindness, which is what makes grudges one-sided.
- **Exposure.** A subject can notice that someone knows their secret ("I don't know who told them"). That's a wake trigger and a new source of private dread.
- **Instincts** (`src/sim/instincts.ts`). Dormant agents still want things. Authored drives per character plus generic reflexes (avoid or confront whoever you're at odds with; seek your most trusted when stressed; confront someone whose secret you've just learned, if you're candid). They go through the same validation as LLM intents and are regenerated deterministically, so they aren't needed in the replay log.
- **The board.** The station posts a hull figure every morning. `reportedHull` stays 6–25 points above true hull: that gap is the Queen's secret. Everyone except Alita and Tomas sees the board figure, both in the sim's morale and in their context packet.
- **Perception** as a fifth trait (Juno 95). It drives overhearing, observing and noticing.
- **Stress baselines.** Carrying a grave secret, knowing how bad the crack is, low station morale, and an authored `burden` (Kavi's fear) all raise where stress settles.
- **Diminishing returns + drift** on relationships, so a month of chatting doesn't saturate everyone at warmth 100.

## Ownership rule (enforced in code and tests)

- **Sim-owned:** everything in `WorldState`. Written only by `advanceTick`.
- **Agent-owned:** `agents.agent_mood`, `agent_goals.perceived_progress/note`, `agent_memory_episodic` rows with `origin='agent'`. Written only by the runtime. Never read by the tick.
- The runtime's only world-facing effect is `store.submitIntent()`.

Tests prove a hostile agent proposing only invalid things leaves the world byte-identical to a dormant run, and that private memory never appears in another agent's packet.

## Information boundaries

- `event_visibility` holds one row per (event, agent who may know it first-hand). Agents' recent events come only through that join.
- Packets contain only the agent's own knowledge, own outgoing edges, own memories, and the hull figure they can actually see.
- Narration must not leak: a *withheld* secret's topic is never named in event text, because that text ends up in the other party's packet.
- Agents see their *own* estimate of goal progress, never the sim's number.

## Phase 0 test: is it interesting?

Running `npm run sim -- --days 30` across several seeds produces, with nobody watching:

- hidden grudges (e.g. Tomas → Bex after learning Bex passes Long Bar talk to Cassian)
- Sera and Tomas avoiding each other, 4–6 times
- betrayals that stay secret (Nadia passing on Olen's confidence)
- secrets on the move: Cassian's ambition reaches most of the ring; Kavi works out from observation that Mira is starving herself; Sera finds the warm air behind the seal
- the sealed-deck hook firing after day 15, confrontations at the Spine, the Queen confiding the old seal order to her Hand

Still thin: Alita's journal (needs the Phase 2 reflection pass), and "strangers who now avoid each other" (everyone starts out knowing everyone; there are no strangers aboard).

## Phase 1–2 (real model: DeepSeek `deepseek-chat`)

**Tick rate: 60 s default.** One in-world day = 24 real minutes. Measured cost for the whole cast is ~35 LLM calls per in-world day: ~25 trigger-driven turns plus one reflection per agent. That works out to:
- turn: ~4.5k prompt + ~360 completion tokens, ~3 s
- reflection: ~2.7k prompt + ~1k completion tokens, ~6 s

At 60 s that's ~90 calls per real hour (≈ $0.15–0.20/h on DeepSeek, ~$4/day running nonstop), well under the 300/h ceiling. Daily reflection for everyone is affordable at this speed, which settles the reflection-cadence question. `--tick-ms 10000` is available for watching. Hull decay was slowed to 0.12/day, so the station's arc spans real days rather than hours.

**Speech is a real act.** Phase 1 exposed a gap. Sera said "I held the lamp while you opened the seal" aloud; the listener's LLM would know it, but the sim's knowledge model wouldn't. Fix: dialogue carries an optional `reveals: <fact id>`, and `confide` intents an optional `fact`. The sim adjudicates both (the speaker must know the fact; otherwise it's stripped and nothing is learned). The listener learns it. If said openly, the room hears; if said low, bystanders may overhear. Characters can still say things without `reveals`; the sim then treats it as talk, not a transfer.

**Decisions beat habits.** Instincts that contradict an active agent intent toward the same person (e.g. Tomas's authored urge to avoid Sera vs. his decision to find her) are rejected. Between two decisions, the newer one retires the older ("changed your mind").

**Conversation hold.** Being spoken to makes both people linger a tick (an instinct `seek`), unless they're avoiding the speaker. Without it, routine schedules walked listeners out mid-conversation, and the Queen's big reveal to Sera failed with "they are not here".

**Reflection** (`src/agents/reflection.ts`). Once per in-world day, the hour before each character sleeps. Outputs:
- the agent's own goals (max 3; authored goals can only be annotated)
- opinions of others (semantic tier, one per person, shown as `your_view`)
- beliefs and a day summary
- forget/keep over the memories it was shown, and nothing else
- a private journal

Opinions do **not** change the sim's relationship numbers: they're the agent's reading, and can be wrong. Agent-authored goals live in `agent_goals` with `origin='agent'` and are never loaded into `WorldState`.

**Memory tiers.**
- *Working:* the packet.
- *Episodic:* capped at 200 per agent, scored by recency + importance × 3 days; reflection's forget/keep act on it.
- *Semantic:* capped at 50: all opinions, the last 14 summaries, and beliefs by weight.

**Fixes found by the real runs:**
- agent-authored goal ids were rejected in later turns
- a 1-hour intent expired before it could be applied
- models put `speak` in intents as well as dialogue, which caused repeats; it's now dropped with a violation
- Alita misread the board gap as someone else's lie; her secret now says plainly that the board figure is hers
- pronouns are now in the cast
- reflections are labelled with the day just ended, even when written after midnight

## Open questions carried forward

1. ~~Tick speed default~~ — 60 s (see above).
2. Player: 12th slot or 13th.
3. Romance (implemented, off by default).
4. Death (implemented behind `settings.death`, off by default; breaches injure).
5. Ending: hull decay is a setting (`hullDecayPerDay`, default 0.35 → ~180 in-world days to zero from 64).
6. Teaser emails.
7. Player starting knowledge.
8. ~~Reflection cadence vs. budget~~: daily is affordable at 60 s ticks; revisit if the default speed rises.
