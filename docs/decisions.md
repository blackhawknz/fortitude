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

## Phase 4 — the player

- **The player takes the twelfth slot** (open question 2). They are a full participant: edges, knowledge and encounters, through the same intent pipeline (`source: 'player'`, weight 1.0). Display name lives in world settings (`--name` on `npm start` for new worlds).
- **A newcomer from dirtside** (open question 7). They know no secrets and are a stranger to everyone (encounters 0, so first meetings wake residents as novel encounters), except the Queen, who knows them from home. That's the asymmetry the spec wants: the player as her confidant.
- **Autopilot body.** When nobody's playing, the player follows a light routine (mess, market, promenade, Long Bar), so they are present and things happen to them. In seeded 15–20-day runs an untended player picks up 3–5 secrets through people (Nadia selling what she knows, the Queen confiding). Every one of them appears in the journal at the tick it arrived, with provenance.
- **Conversation is real time; consequences keep the clock.** `say()` gets an immediate in-voice reply from the resident (their full context packet plus the transcript). Both lines are also submitted as `speak` intents and adjudicated next tick: facts revealed either way, conversation hold, relationship effects. The background runtime ignores the player's speech so nobody answers twice. Conversation intents carry sequence-ordered ids so replies never precede the line they answer. There's a per-resident chat cap (60/real hour).
- **The journal is built only from `event_visibility` rows for the player.** Narration is rewritten into the second person, but quoted speech is left exactly as said.
- **HTTP door** (`src/server/http.ts`, Hono). Loopback only, same-origin required for writes, optional `FORTITUDE_TOKEN`. SSE pushes the view plus new journal entries every tick. Chat is request/response rather than the spec's WebSocket: each exchange is one request (~3 s), so a socket adds nothing yet.
- **UI** (`public/index.html`). No build step. Where you are, who's here, places, actions; a conversation pane with register and "tell them…" (reveal a fact you know); journal / what you know / people.
- **Pace.** At the 60 s default a conversation fits comfortably inside an in-world hour. At 8 s, people walk off while you type.

## Phase 5 — presence

- **Rumours distort in the telling.** Each fact has authored rumour variants (`FactDef.rumours`). They can exaggerate, go vague, or name the wrong person: "Sera opened the seal".
  - Gossip and betrayal garble with probability ≈ (0.25 + 0.12 × (hops − 1)) × (1.3 − teller's candour), capped at 0.6.
  - Confidences, evidence, observation and deliberate speech are exact. A teller who believes a rumour passes the rumour on, and overhearers take away exactly what was said.
  - Knowledge stores `version` and `hops`. Everything that asks who a fact is about (opinion shifts and grudges, gossip and confide filters, confront reflexes, exposure) uses the **holder's believed version**. So a rumour blaming Sera makes people resent Sera.
  - Truth from evidence or a confidence replaces a rumour; a rumour never replaces the truth. Correcting a belief doesn't undo the grudge it caused.
  - "Learn" goals count only the truth.
  - Characters' packets, reflections and the player's view show what each believes.
- **The autopilot never chooses for the player.** An untended player body can be talked to, confided in and drawn into arguments. It never initiates gossip, betrayal, confiding or confrontation unless the player intended it. (Found in testing: an autopilot player was gossiping about Mira.)
- **Presence.** While the UI's stream is open the player is present, and the last tick they saw is recorded when they leave (`player_presence`). The UI fetches the debrief before opening the stream.
- **Absence debrief** (`src/player/presence.ts`). Built only from the player's visibility rows. Items are classified (learned / heard a rumour / someone came for you / you were there / station incident / your feelings), weighted, and the top three are picked with variety. Across seeded 2-day absences the headline has three items in most runs (spec §14). Optional prose narration sees only those items, so it can't add events (P5).
- **Teasers** (open question 6: in-app plus optional webhook, no SMTP). Sent after `FORTITUDE_TEASER_AFTER_MS` (2 h) away, at most every `FORTITUDE_TEASER_COOLDOWN_MS` (6 h), and only for a strong item.
  - The seed text says **who and where, never what**. The model that phrases it never sees a fact, so it can't spoil.
  - Stored in `notifications` (spec §8) and POSTed to `FORTITUDE_TEASER_WEBHOOK` if set. The `{text, content}` payload works for ntfy, Discord and Slack-style hooks.
- **UI:** a "While you were away" overlay on return, "new" markers in the journal, and an ✉ badge for teasers.

## Open questions carried forward

1. ~~Tick speed default~~ — 60 s (see above).
2. ~~Player: 12th slot or 13th~~ — 12th (see Phase 4).
3. Romance (implemented, off by default).
4. Death (implemented behind `settings.death`, off by default; breaches injure).
5. Ending: hull decay is a setting (`hullDecayPerDay`, default 0.35 → ~180 in-world days to zero from 64).
6. ~~Teaser emails~~ — in-app + optional webhook; no SMTP (see Phase 5).
7. ~~Player starting knowledge~~ — a newcomer: no secrets, a stranger to all but the Queen.
8. ~~Reflection cadence vs. budget~~: daily is affordable at 60 s ticks; revisit if the default speed rises.
