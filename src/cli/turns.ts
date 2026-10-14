/**
 * Inspect the LLM turn log: cost, latency, failures, violations.
 *
 *   npm run turns -- --db data/p2.db --world p2 [--errors]
 */
import Database from 'better-sqlite3'
import { parseArgs } from './args.js'

const args = parseArgs()
const db = new Database(String(args.db ?? process.env.FORTITUDE_DB ?? 'data/fortitude.db'), { readonly: true })
const world = String(args.world ?? 'phase1')

const summary = db
  .prepare(
    `SELECT kind, status, count(*) n, round(avg(prompt_tokens)) prompt, round(avg(completion_tokens)) completion,
            sum(prompt_tokens) promptTotal, sum(completion_tokens) completionTotal, round(avg(latency_ms)) ms
     FROM agent_turns WHERE world_id = ? GROUP BY kind, status`,
  )
  .all(world)
console.table(summary)

const perAgent = db.prepare(`SELECT agent_id, kind, count(*) n FROM agent_turns WHERE world_id = ? GROUP BY agent_id, kind ORDER BY agent_id`).all(world)
console.table(perAgent)

if (args.errors) {
  const rows = db.prepare(`SELECT tick, agent_id, kind, status, error FROM agent_turns WHERE world_id = ? AND error IS NOT NULL ORDER BY id`).all(world) as { tick: number; agent_id: string; kind: string; status: string; error: string }[]
  for (const r of rows) console.log(`${r.tick} ${r.agent_id} ${r.kind} ${r.status} | ${r.error.slice(0, 400)}`)
}
