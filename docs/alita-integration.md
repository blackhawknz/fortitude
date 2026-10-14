# Alita integration (Phase 3)

"One Alita, two doors": the Queen of Fortitude is served by the real Alita system, with the same persona and the same memory store as at home. Fortitude never depends on it.

## What was added to the Alita backend (`D:\Projects\Alita\backend`)

That folder is not a git repository. Originals of the modified files were backed up to `%TEMP%\opencode\alita-backup-20261014-221635\`.

| File | Change |
|---|---|
| `alita/api/worlds.py` | **New.** `POST /agent/turn`, `POST /agent/reflect`, `GET /agent/memory`, `POST /agent/memory`, `POST /agent/memory/retract` |
| `alita/api/server.py` | `app.include_router(...)` for the router above (3 lines) |
| `alita/memory/sqlite_store.py` | `memories` gains `scope`, `external_ref` (unique when set), `fiction` (idempotent `ALTER TABLE`, same pattern as existing migrations) |
| `alita/memory/longterm.py` | `add_scoped`, `list_scope`, `search_scope`, `retract_scope`; home de-duplication ignores fiction rows |
| `alita/memory/manager.py` | Home recall labels fiction memories (`FICTION · Fortitude`); the extraction pass is never shown fiction rows, and its prompt says story events are not real facts |
| `tests/test_worlds_api.py` | **New.** 8 tests. Full suite: 436 passed |

### Safety properties
- **Tools off.** A world turn is one plain completion. Nothing is executed, and no chat session is created, so automatic memory extraction never runs on world traffic.
- **Fiction is marked.** Every memory written through `/agent/memory` has `fiction=1` and a `scope` such as `fortitude:<worldId>`. At home those memories are recalled with a FICTION label. They are never merged with real memories, and the extraction pass can neither update nor delete them.
- **Idempotent writes.** `external_ref` (`fortitude:<world>:<tick>:alita:<id>`) means retries never duplicate.
- **Clean reset.** Retracting a scope soft-deletes the world and frees its refs.
- **Auth.** The routes are covered by the existing `AuthMiddleware`. If `ALITA_API_TOKEN` is set on the Alita side, set the same value in Fortitude's `.env`.

### Request shape
Fortitude keeps ownership of its response contract. It sends its own `system` and `user` prompts. Alita prepends:
- her persona (`SOUL.md`)
- a fiction frame
- her core memory about the user (real)
- her scoped memories of this world

and returns `{content, usage, model}`.

## Fortitude side (`src/agents/alita.ts`)
- **`AlitaBackend`** serves the Queen's turns and reflections through Alita. On any failure it falls back to the local model with a reduced packet. A circuit breaker (`ALITA_COOLDOWN_MS`, default 30 s) stops later turns from waiting on a dead service.
- **`AlitaMemorySync`** is an outbox (`external_sync` table). Alita's episodic memories (importance ≥ 3) and her day summaries are pushed oldest first, throttled, and stop at the first failure. Anything written while she was down reconciles when she returns.
- `ALITA_URL` unset means the Queen simply runs locally.

## Verified
- **Unit test** (`test/alita.test.ts`) against a fake Alita: with the service up, the Queen's turns go to Alita and her memories mirror. Kill it mid-run and the world keeps ticking, her turns degrade to local, and the backlog builds. Restart it and the breaker closes, the backlog reconciles with no duplicate refs, and replay stays identical.
- **Live** against the real Alita code on port 8090, with an isolated home holding copies of `SOUL.md`, `INSTRUCTIONS.md` and the core-memory files. No `state.db` was copied, so no scheduled jobs ran. Three in-world days: up, then killed, then back. 15 memories reconciled, refs unique, replay identical.

## To go live
1. Restart the Alita backend (`start.bat`, or restart `run.py`) so it loads the new routes. Your existing `state.db` is migrated in place; the change only adds columns.
2. Fortitude's `.env` already has `ALITA_URL=http://127.0.0.1:8080`. Until the restart, Alita answers 404 and Fortitude falls back silently.
3. To wipe a world from Alita's memory: `npm run alita -- --retract --world <id>`.
