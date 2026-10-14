/**
 * Time model. One tick = one in-world hour.
 *
 * Tick 0 is Day 1, 00:00 of the chronicle. The station itself is ~200 years
 * old; STATION_EPOCH_DAY offsets the chronicle into the station calendar for
 * display only. Simulation logic only ever uses chronicle day/hour.
 */

export const HOURS_PER_DAY = 24
export const DAYS_PER_YEAR = 365
/** The chronicle opens on day 73,001 of the station's life (≈ year 200). */
export const STATION_EPOCH_DAY = 73_000

export interface WorldTime {
  tick: number
  day: number // chronicle day, 1-based
  hour: number // 0–23
}

export function timeOf(tick: number): WorldTime {
  return { tick, day: Math.floor(tick / HOURS_PER_DAY) + 1, hour: tick % HOURS_PER_DAY }
}

export function tickOf(day: number, hour: number): number {
  return (day - 1) * HOURS_PER_DAY + hour
}

export function stationDate(tick: number): { year: number; dayOfYear: number } {
  const absolute = STATION_EPOCH_DAY + timeOf(tick).day
  return { year: Math.floor(absolute / DAYS_PER_YEAR), dayOfYear: (absolute % DAYS_PER_YEAR) + 1 }
}

export function formatTime(tick: number): string {
  const t = timeOf(tick)
  return `Day ${t.day}, ${String(t.hour).padStart(2, '0')}:00`
}

/** True if `hour` falls in [from, to), wrapping midnight when from > to. */
export function inHours(hour: number, from: number, to: number): boolean {
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to
}

/**
 * Real-time speed presets: milliseconds per tick.
 * Default 60 s: one in-world day = 24 real minutes. A game you check in on,
 * at ~100 LLM turns per real hour for the full cast (see docs/decisions.md).
 */
export const SPEEDS = { watch: 10_000, brisk: 30_000, default: 60_000, slow: 120_000 } as const
export type SpeedName = keyof typeof SPEEDS

/** Never run more than this many ticks when resuming after downtime. */
export const CATCH_UP_CAP = 60
