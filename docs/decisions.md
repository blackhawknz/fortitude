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

## Open questions carried forward

1. Tick speed default (affects budget arithmetic).
2. Player: 12th slot or 13th.
3. Romance (implemented, off by default).
4. Death (implemented behind `settings.death`, off by default; breaches injure).
5. Ending: hull decay is a setting (`hullDecayPerDay`, default 0.35 → ~180 in-world days to zero from 64).
6. Teaser emails.
7. Player starting knowledge.
8. **New:** reflection cadence vs. budget (see correction 1).
