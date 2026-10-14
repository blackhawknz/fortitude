/**
 * Stateless, positional randomness.
 *
 * Every random number in the deterministic layer comes from `rng(seed, ...keys)`.
 * There is no hidden generator state, so results never depend on call order —
 * only on the seed and the positional keys (tick, agent, location, purpose...).
 *
 * Math.random is forbidden in src/sim. A test enforces this.
 */

export type RngKey = string | number

/** cyrb53 — fast, well-distributed 53-bit string hash. */
function cyrb53(str: string, salt = 0): number {
  let h1 = 0xdeadbeef ^ salt
  let h2 = 0x41c6ce57 ^ salt
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

const TWO_53 = 2 ** 53

/** Uniform float in [0, 1). */
export function rng(seed: string, ...keys: RngKey[]): number {
  return cyrb53(seed + '\u241f' + keys.join('\u241f')) / TWO_53
}

/** True with probability p. */
export function chance(p: number, seed: string, ...keys: RngKey[]): boolean {
  if (p <= 0) return false
  if (p >= 1) return true
  return rng(seed, ...keys) < p
}

/** Integer in [min, max] inclusive. */
export function int(min: number, max: number, seed: string, ...keys: RngKey[]): number {
  return min + Math.floor(rng(seed, ...keys) * (max - min + 1))
}

/** Uniform pick. Throws on an empty list. */
export function pick<T>(items: readonly T[], seed: string, ...keys: RngKey[]): T {
  if (items.length === 0) throw new Error('pick() from empty list')
  return items[Math.floor(rng(seed, ...keys) * items.length)] as T
}

/** Weighted pick. Entries with weight <= 0 are never chosen. Returns undefined if all are zero. */
export function weighted<T>(
  entries: readonly (readonly [T, number])[],
  seed: string,
  ...keys: RngKey[]
): T | undefined {
  let total = 0
  for (const [, w] of entries) if (w > 0) total += w
  if (total <= 0) return undefined
  let roll = rng(seed, ...keys) * total
  for (const [item, w] of entries) {
    if (w <= 0) continue
    roll -= w
    if (roll < 0) return item
  }
  // Floating point guard: return the last positive entry.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e[1] > 0) return e[0]
  }
  return undefined
}

/** Stable hash of any JSON-serialisable value — used for state fingerprints in replay tests. */
export function fingerprint(value: unknown): string {
  const json = stableStringify(value)
  return cyrb53(json, 1).toString(16).padStart(14, '0') + cyrb53(json, 2).toString(16).padStart(14, '0')
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
}
