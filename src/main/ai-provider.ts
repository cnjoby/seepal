import type { AiProviderConfig } from './ai-config-store.js'

const CONNECTION_TEST_PROMPT = 'Reply with exactly OK.'

export interface AiConfigSource {
  getProviderConfig(): AiProviderConfig
}

export interface AiGenerationResult {
  text: string
  model: string
}

export interface AiConnectionResult extends AiGenerationResult {
  latencyMs: number
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export class AiProviderClient {
  constructor(
    private readonly configSource: AiConfigSource,
    private readonly fetcher: FetchLike = fetch,
    private readonly timeoutMs = 15_000,
    private readonly maxResponseBytes = 1_048_576,
    private readonly now: () => number = Date.now,
  ) {}

  async testConnection(): Promise<AiConnectionResult> {
    const startedAt = this.now()
    const result = await this.generateText(CONNECTION_TEST_PROMPT)
    return { ...result, latencyMs: Math.max(0, this.now() - startedAt) }
  }

  async generateText(prompt: string): Promise<AiGenerationResult> {
    const config = this.configSource.getProviderConfig()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response =
        config.protocol === 'openai'
          ? await this.requestOpenAi(config, prompt, controller.signal)
          : await this.requestAnthropic(config, prompt, controller.signal)
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`模型服务返回 HTTP ${response.status}。`)
      }
      const payload = await this.readJson(response)
      return config.protocol === 'openai'
        ? this.parseOpenAi(payload, config.model)
        : this.parseAnthropic(payload, config.model)
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error('连接模型服务超时，请检查网络后重试。')
      }
      if (
        error instanceof Error &&
        (error.message.startsWith('模型服务返回 HTTP ') ||
          error.message === '模型服务响应过大。' ||
          error.message === '模型服务返回了无法识别的响应。')
      ) {
        throw error
      }
      throw new Error('无法连接模型服务，请检查 Base URL 和网络。')
    } finally {
      clearTimeout(timeout)
    }
  }

  private requestOpenAi(
    config: AiProviderConfig,
    prompt: string,
    signal: AbortSignal,
  ): Promise<Response> {
    return this.fetcher(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 128,
        stream: false,
      }),
    })
  }

  private requestAnthropic(
    config: AiProviderConfig,
    prompt: string,
    signal: AbortSignal,
  ): Promise<Response> {
    return this.fetcher(`${config.baseUrl}/v1/messages`, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 128,
      }),
    })
  }

  private async readJson(response: Response): Promise<unknown> {
    const declaredLength = Number(response.headers.get('content-length'))
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > this.maxResponseBytes
    ) {
      await response.body?.cancel()
      throw new Error('模型服务响应过大。')
    }
    if (!response.body) throw new Error('模型服务返回了无法识别的响应。')

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > this.maxResponseBytes) {
        await reader.cancel()
        throw new Error('模型服务响应过大。')
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw new Error('模型服务返回了无法识别的响应。')
    }
  }

  private parseOpenAi(
    value: unknown,
    fallbackModel: string,
  ): AiGenerationResult {
    if (!value || typeof value !== 'object') {
      throw new Error('模型服务返回了无法识别的响应。')
    }
    const record = value as Record<string, unknown>
    const choices = record.choices
    const first = Array.isArray(choices) ? choices[0] : undefined
    const message =
      first && typeof first === 'object'
        ? (first as Record<string, unknown>).message
        : undefined
    const text =
      message && typeof message === 'object'
        ? (message as Record<string, unknown>).content
        : undefined
    if (typeof text !== 'string' || !text) {
      throw new Error('模型服务返回了无法识别的响应。')
    }
    return {
      text,
      model: fallbackModel,
    }
  }

  private parseAnthropic(
    value: unknown,
    fallbackModel: string,
  ): AiGenerationResult {
    if (!value || typeof value !== 'object') {
      throw new Error('模型服务返回了无法识别的响应。')
    }
    const record = value as Record<string, unknown>
    const content = record.content
    const textBlock = Array.isArray(content)
      ? content.find(
          (item) =>
            item &&
            typeof item === 'object' &&
            (item as Record<string, unknown>).type === 'text' &&
            typeof (item as Record<string, unknown>).text === 'string' &&
            Boolean((item as Record<string, unknown>).text),
        )
      : undefined
    const text =
      textBlock && typeof textBlock === 'object'
        ? (textBlock as Record<string, unknown>).text
        : undefined
    if (typeof text !== 'string' || !text) {
      throw new Error('模型服务返回了无法识别的响应。')
    }
    return {
      text,
      model: fallbackModel,
    }
  }
}
