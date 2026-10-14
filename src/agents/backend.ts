import OpenAI from 'openai'
import type { ContextPacket } from './packet.js'
import { extractJson } from './response.js'
import { repairPrompt, systemPrompt, userPrompt } from './prompt.js'

/** What a backend returns: the raw parsed JSON plus accounting. Validation happens in the runtime. */
export interface BackendReply {
  json: unknown
  raw: string
  promptTokens?: number
  completionTokens?: number
  backend: string
}

/** Spec §4.6. Phase 3 adds AlitaBackend (external) with fallback to LocalBackend. */
export interface AgentBackend {
  readonly name: string
  turn(packet: ContextPacket, signal?: AbortSignal): Promise<BackendReply>
}

export interface LocalBackendOptions {
  baseURL: string
  apiKey: string
  model: string
  timeoutMs?: number
  temperature?: number
  maxTokens?: number
  /** Send response_format json_object (most OpenAI-compatible servers support it). */
  jsonMode?: boolean
}

export function localBackendFromEnv(env = process.env): LocalBackend | null {
  const apiKey = env.FORTITUDE_LLM_API_KEY
  const baseURL = env.FORTITUDE_LLM_BASE_URL
  const model = env.FORTITUDE_LLM_MODEL
  if (!baseURL || !model) return null
  return new LocalBackend({
    baseURL,
    model,
    apiKey: apiKey || 'not-needed', // local servers (LM Studio / Ollama) ignore it
    timeoutMs: Number(env.FORTITUDE_LLM_TIMEOUT_MS ?? 45_000),
    jsonMode: env.FORTITUDE_LLM_JSON_MODE !== 'false',
  })
}

/** Any OpenAI-compatible chat endpoint. */
export class LocalBackend implements AgentBackend {
  readonly name: string
  private client: OpenAI

  constructor(private readonly opts: LocalBackendOptions) {
    this.client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 45_000, maxRetries: 1 })
    this.name = `local:${opts.model}`
  }

  async turn(packet: ContextPacket, signal?: AbortSignal): Promise<BackendReply> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt(packet) },
      { role: 'user', content: userPrompt(packet) },
    ]
    let promptTokens = 0
    let completionTokens = 0
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.client.chat.completions.create(
        {
          model: this.opts.model,
          messages,
          temperature: this.opts.temperature ?? 0.8,
          max_tokens: this.opts.maxTokens ?? 700,
          ...(this.opts.jsonMode !== false ? { response_format: { type: 'json_object' as const } } : {}),
        },
        { signal },
      )
      promptTokens += res.usage?.prompt_tokens ?? 0
      completionTokens += res.usage?.completion_tokens ?? 0
      const raw = res.choices[0]?.message?.content ?? ''
      try {
        return { json: extractJson(raw), raw, promptTokens, completionTokens, backend: this.name }
      } catch (err) {
        if (attempt === 1) throw Object.assign(new Error(`unparseable reply: ${(err as Error).message}`), { raw })
        messages.push({ role: 'assistant', content: raw }, { role: 'user', content: repairPrompt((err as Error).message) })
      }
    }
    throw new Error('unreachable')
  }
}

/**
 * Deterministic stand-in for tests and offline runs. `script` decides the
 * reply from the packet. It can return anything — including garbage — so
 * tests can prove the runtime rejects it.
 */
export class MockBackend implements AgentBackend {
  readonly name = 'mock'
  calls: ContextPacket[] = []
  constructor(
    private readonly script: (p: ContextPacket) => unknown,
    private readonly delayMs = 0,
  ) {}

  async turn(packet: ContextPacket): Promise<BackendReply> {
    this.calls.push(packet)
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
    const json = this.script(packet)
    return { json, raw: JSON.stringify(json), backend: this.name }
  }
}

/**
 * A simple goal-chasing script: useful for exercising Phase 1 plumbing
 * without an API key. Not a character — just a sanity driver.
 */
export function heuristicScript(p: ContextPacket): unknown {
  const here = p.people_here.filter((x) => !x.asleep)
  const intents: unknown[] = []
  const tense = [...p.relationships].sort((a, b) => b.tension - a.tension)[0]
  if (p.trigger.kind === 'station_incident') intents.push({ kind: 'move', to: p.self_state.location.id === 'third-bay' ? 'spine' : 'third-bay', reason: 'See for myself.', weight: 0.7, hours: 3 })
  else if (tense && tense.tension > 40) intents.push({ kind: 'seek', target: tense.id, reason: 'We need to talk.', weight: 0.6, hours: 8 })
  else intents.push({ kind: 'investigate', to: p.places.find((pl) => pl.id === 'third-bay')?.id ?? 'spine', reason: 'Something is wrong down there.', weight: 0.6, hours: 6 })
  return {
    intents,
    dialogue: here[0] ? { say: 'Have you heard anything about the third bay?', to: here[0].id, register: 'guarded' } : null,
    memory_writes: [{ text: `Woke for ${p.trigger.kind}: ${p.trigger.detail}`.slice(0, 200), importance: 2, private: true }],
    mood: 'concerned',
    goal_updates: p.agent.goals[0] ? [{ id: p.agent.goals[0].id, progress: 0.3, note: 'Still circling it.' }] : [],
  }
}
