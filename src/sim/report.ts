import type { SimEvent, WorldState } from '../core/types.js'
import { CAST, castMember } from '../world/cast.js'
import { FACTS } from '../world/facts.js'
import { RELATIONSHIP_LABEL } from './relationships.js'
import { knowersOf } from './knowledge.js'

const name = (id: string) => castMember(id).name.split(' ')[0]!

/**
 * A god's-eye summary of a run, organised around the spec's success test
 * (§14): grudges nobody knows about, strangers-turned-avoiders, secrets on
 * the move, and whether the log reads as a story.
 */
export function storyReport(start: WorldState, end: WorldState, events: SimEvent[]): string {
  const out: string[] = []
  const days = Math.round((end.tick - start.tick) / 24)
  out.push(`═══ ${end.name} — ${days} days, ticks ${start.tick}→${end.tick}, seed "${end.seed}" ═══`, '')

  const s0 = start.station
  const s1 = end.station
  out.push(
    'STATION',
    `  hull ${s0.hull.toFixed(1)} → ${s1.hull.toFixed(1)}   (board says ${Math.round(s1.reportedHull)})`,
    `  power ${s0.power} → ${s1.power}   air ${s0.air} → ${s1.air}   water ${s0.water} → ${s1.water}   morale ${s0.morale} → ${s1.morale}`,
  )
  const incidents = events.filter((e) => e.type === 'incident')
  const byKind = new Map<string, number>()
  for (const e of incidents) byKind.set(String(e.data?.kind), (byKind.get(String(e.data?.kind)) ?? 0) + 1)
  out.push(`  incidents: ${[...byKind].map(([k, n]) => `${k}×${n}`).join(', ') || 'none'}`, '')

  const outcomes = new Map<string, number>()
  for (const e of events) if (e.type === 'encounter') outcomes.set(e.outcome!, (outcomes.get(e.outcome!) ?? 0) + 1)
  out.push('ENCOUNTERS', '  ' + [...outcomes].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · '), '')

  // Hidden grudges: one side carries tension the other doesn't.
  // A grudge is hidden if the other side hasn't noticed what it's built on
  // and isn't carrying a matching one back.
  out.push('GRUDGES THE OTHER SIDE DOESN’T KNOW ABOUT')
  const grudges = Object.values(end.edges)
    .filter((e) => e.grudge >= 10)
    .filter((e) => !end.exposures.some((x) => x.startsWith(`${e.to}:${e.from}:`)))
    .filter((e) => end.edges[`${e.to}>${e.from}`]!.grudge < e.grudge / 2)
    .sort((a, b) => b.grudge - a.grudge)
  for (const e of grudges.slice(0, 8)) {
    const r = end.edges[`${e.to}>${e.from}`]!
    out.push(`  ${name(e.from)} → ${name(e.to)}: grudge ${e.grudge}, tension ${e.tension} (${name(e.to)} → ${name(e.from)}: tension ${r.tension})`)
  }
  if (!grudges.length) out.push('  (none)')
  out.push('')

  out.push('BETRAYALS')
  for (const b of end.betrayals) {
    out.push(`  Day ${Math.floor(b.tick / 24) + 1}: ${name(b.betrayer)} passed ${name(b.victim)}'s confidence to ${name(b.listener)} — ${b.discovered ? 'DISCOVERED' : 'still secret'}`)
  }
  if (!end.betrayals.length) out.push('  (none)')
  out.push('')

  // Pairs that were fine at the start and now avoid each other.
  out.push('PAIRS NOW AVOIDING EACH OTHER')
  const avoidCount = new Map<string, number>()
  for (const e of events) {
    if (e.outcome !== 'avoid' && !(e.type === 'intent' && e.data?.kind === 'avoid')) continue
    if (!e.actorId || !e.targetId) continue
    const k = [e.actorId, e.targetId].sort().join('|')
    avoidCount.set(k, (avoidCount.get(k) ?? 0) + 1)
  }
  const avoiders = [...avoidCount].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])
  for (const [k, n] of avoiders.slice(0, 8)) {
    const [x, y] = k.split('|') as [string, string]
    const startT = start.edges[`${x}>${y}`]!.tension
    out.push(`  ${name(x)} / ${name(y)}: ${n} avoidances (tension started at ${startT})`)
  }
  if (!avoiders.length) out.push('  (none)')
  out.push('')

  out.push('SECRETS ON THE MOVE')
  for (const f of FACTS.filter((f) => f.secrecy >= 0.5)) {
    const before = knowersOf(start, f.id)
    const after = knowersOf(end, f.id)
    const added = after.filter((a) => !before.includes(a))
    if (!added.length) continue
    const how = added.map((a) => {
      const k = end.knowledge[a]![f.id]!
      const src = k.source
      const via =
        src.kind === 'told' ? `told by ${name(src.by)}${src.confided ? ' in confidence' : ''}` : src.kind === 'overheard' ? `overheard ${name(src.from)}` : src.kind
      const rumour = k.version ? ` — believes: “${f.rumours?.[k.version - 1]?.text}”` : ''
      return `${name(a)} (${via}${rumour})`
    })
    out.push(`  “${f.text}”`, `     ${before.map(name).join(', ')}  +  ${how.join('; ')}`)
  }
  out.push('')

  out.push('RELATIONSHIPS THAT MOVED MOST')
  const moved = Object.values(end.edges)
    .map((e) => {
      const s = start.edges[`${e.from}>${e.to}`]!
      const score = (x: typeof e) => (x.trust + x.warmth) / 2 - x.tension
      return { e, s, delta: score(e) - score(s) }
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  for (const { e, s, delta } of moved.slice(0, 10)) {
    out.push(
      `  ${name(e.from)} → ${name(e.to)}: ${RELATIONSHIP_LABEL[s.type]} → ${RELATIONSHIP_LABEL[e.type]}  (trust ${s.trust}→${e.trust}, warmth ${s.warmth}→${e.warmth}, tension ${s.tension}→${e.tension}, Δ${delta > 0 ? '+' : ''}${delta.toFixed(0)})`,
    )
  }
  out.push('')

  out.push('RESIDENTS')
  for (const c of CAST) {
    const a = end.agents[c.id]!
    const known = Object.keys(end.knowledge[c.id] ?? {}).length
    const goals = a.goals.map((g) => `${g.text.toLowerCase()} ${Math.round(g.progress * 100)}%`).join('; ')
    out.push(`  ${c.name.padEnd(14)} health ${a.health.toFixed(0).padStart(3)}  stress ${a.stress.toFixed(0).padStart(3)}  ${a.mood.padEnd(9)} knows ${String(known).padStart(2)} facts — ${goals}`)
  }
  return out.join('\n')
}
