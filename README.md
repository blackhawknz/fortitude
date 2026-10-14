# Fortitude

A multi-agent social simulation aboard a dying ring station. Every named character is an autonomous agent with memory, goals, relationships and secrets. The world keeps running when you're not watching.

Design: [`fortitude-spec.md`](fortitude-spec.md) · Decisions and corrections: [`docs/decisions.md`](docs/decisions.md)

## Status

- **Phase 0 — headless world:** done. Deterministic tick loop, schedules, encounters, directed relationships with grudges, a knowledge/secrets model, station decay and incidents, SQLite persistence, exact replay.
- **Phase 1 — agent runtime:** done, verified on DeepSeek. Context packets, structured responses, intent queue with adjudication, wake triggers, attention budgets, an OpenAI-compatible backend.
- **Phase 2 — the whole cast:** done. All eleven residents LLM-backed, with a daily reflection pass (goals, opinions, beliefs, memory consolidation, private journals), three memory tiers with caps, speech and confiding as adjudicated knowledge transfers. ~35 LLM calls per in-world day.
- **Phase 3 — Alita adapter:** done. The Queen is served by the real Alita system (`POST /agent/turn` / `/agent/reflect`, scoped fiction memory), with automatic fallback to the local model, a circuit breaker, and an outbox that reconciles her memories when Alita returns. See [`docs/alita-integration.md`](docs/alita-integration.md); **restart the Alita backend to load the new routes.**
- **Phase 4 — the player:** done. The player is the twelfth resident: a newcomer from dirtside with a body, a location and an autopilot routine for when nobody's playing. Talk to anyone in the same room in real time; what's said and revealed is adjudicated on the next tick. The journal shows only what your character could know. Web UI at `http://127.0.0.1:4100/` when `npm start` is running.
- **Phase 5 — presence:** done. Rumours distort as they travel, and a garbled rumour can blame the wrong person. A "while you were away" debrief shows the three things worth telling you, built only from what your character knows. Spoiler-free teasers arrive in-app (plus an optional webhook) while you're away.
- Phase 6 (polish: portraits, mood, sound, world-authoring studio): not started.

## Setup

```sh
npm install
cp .env.example .env   # set FORTITUDE_LLM_BASE_URL / _MODEL / _API_KEY for real agent turns
```

Requires Node ≥ 22.

## Run

```sh
# Phase 0: 30 headless days, story report (in memory)
npm run sim -- --days 30 --seed fortitude-1 --log out/log.txt

# ...persisted, then verify replay
npm run sim -- --days 30 --db data/p0.db --world w1
npm run replay -- --db data/p0.db --world w1

# The world, running: 60 s ticks, whole cast, real time. Ctrl+C stops cleanly; restart catches up.
npm start
npm start -- --tick-ms 10000 --world w2
npm run turns -- --world fortitude --errors        # LLM cost / failures

# Lockstep runs (--lockstep waits for turns between ticks; debug only)
npm run agent -- --agent all --days 3 --lockstep --quiet --log out/run.txt
npm run agent -- --agent sera --days 3 --lockstep
npm run agent -- --agent sera --days 3 --lockstep --mock      # no API key needed
npm run agent -- --agent sera,kavi --days 1 --tick-ms 5000    # real time; the loop never waits

npm test
npm run typecheck
```

## Layout

```
src/core     rng (stateless, positional), clock, types
src/world    authored content: locations, cast (the four authored things), facts, outcome table
src/sim      the deterministic tick — pure (state, submissions) → (state, events)
             intents · instincts · schedule · encounters · knowledge · places · station · goals
src/db       Drizzle schema + WorldStore (persistence, scoped reads, intent queue)
src/engine   the loop: phase 6 persist, phase 7 notify, catch-up
src/agents   runtime: triggers, budget, context packet, prompt, response parsing, backends
src/cli      sim · agent · replay
test/        determinism, replay, persistence, information boundaries, resolver-bypass
```

**The one rule:** the generative layer can't change the world directly. Agents submit intents, and the tick adjudicates them. `src/sim` has no I/O, no clock and no `Math.random`, and a test enforces this.
