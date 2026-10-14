/** Tiny argv parser: --key value, --flag, positional ignored. */
export function parseArgs(argv = process.argv.slice(2)): Record<string, string | true> {
  const out: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const [k, inline] = a.slice(2).split('=', 2) as [string, string | undefined]
    if (inline !== undefined) out[k] = inline
    else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) out[k] = argv[++i]!
    else out[k] = true
  }
  return out
}

export function loadEnv(): void {
  try {
    process.loadEnvFile('.env')
  } catch {
    /* no .env — fine */
  }
}
