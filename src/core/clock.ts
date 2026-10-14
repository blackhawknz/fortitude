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

/** Real-time speed presets: milliseconds per tick. */
export const SPEEDS = { watch: 5_000, default: 10_000, relaxed: 30_000, slow: 60_000 } as const
export type SpeedName = keyof typeof SPEEDS

/** Never run more than this many ticks when resuming after downtime. */
export const CATCH_UP_CAP = 60
