import { describe, expect, it, vi } from 'vitest'
import {
  AiProviderClient,
  type AiConfigSource,
} from '../../src/main/ai-provider.js'
import type { AiProviderConfig } from '../../src/main/ai-config-store.js'

function source(
  overrides: Partial<AiProviderConfig> = {},
): AiConfigSource {
  return {
    getProviderConfig: () => ({
      protocol: 'openai',
      baseUrl: 'https://api.example.com',
      model: 'example-model',
      apiKey: 'sk-provider-test-value',
      ...overrides,
    }),
  }
}

describe('AiProviderClient', () => {
  it('uses the OpenAI-compatible path and bearer authentication', async () => {
    const fetcher = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) =>
      Response.json({
        model: 'returned-openai-model',
        choices: [{ message: { content: 'OK' } }],
      }),
    )
    const client = new AiProviderClient(source(), fetcher)

    await expect(client.testConnection()).resolves.toMatchObject({
      text: 'OK',
      model: 'example-model',
    })
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://api.example.com/chat/completions')
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: 'Bearer sk-provider-test-value',
        'content-type': 'application/json',
      },
    })
  })

  it('uses the Anthropic-compatible path and headers', async () => {
    const fetcher = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) =>
      Response.json({
        model: 'returned-anthropic-model',
        content: [
          { type: 'thinking', thinking: 'private reasoning' },
          { type: 'text', text: 'OK' },
        ],
      }),
    )
    const client = new AiProviderClient(
      source({
        protocol: 'anthropic',
        baseUrl: 'https://api.example.com/anthropic',
      }),
      fetcher,
    )

    await expect(client.generateText('hello')).resolves.toEqual({
      text: 'OK',
      model: 'example-model',
    })
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://api.example.com/anthropic/v1/messages')
    expect(init?.headers).toMatchObject({
      'x-api-key': 'sk-provider-test-value',
      'anthropic-version': '2023-06-01',
    })
  })

  it('maps timeouts and malformed responses to redacted errors', async () => {
    const timeoutFetcher = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('secret transport detail', 'AbortError')),
          )
        }),
    )
    const timeoutClient = new AiProviderClient(
      source(),
      timeoutFetcher,
      5,
    )
    await expect(timeoutClient.testConnection()).rejects.toThrow(
      '连接模型服务超时',
    )

    const malformedClient = new AiProviderClient(
      source(),
      async () => new Response('upstream leaked detail', { status: 200 }),
    )
    await expect(malformedClient.testConnection()).rejects.toThrow(
      '模型服务返回了无法识别的响应',
    )
  })

  it('rejects oversized and HTTP error responses without exposing bodies', async () => {
    const oversizedClient = new AiProviderClient(
      source(),
      async () =>
        new Response('ignored', {
          headers: { 'content-length': '2048' },
        }),
      15_000,
      1024,
    )
    await expect(oversizedClient.testConnection()).rejects.toThrow(
      '模型服务响应过大',
    )

    const httpClient = new AiProviderClient(
      source(),
      async () => new Response('secret upstream body', { status: 401 }),
    )
    await expect(httpClient.testConnection()).rejects.toThrow(
      '模型服务返回 HTTP 401',
    )
    await expect(httpClient.testConnection()).rejects.not.toThrow(
      'secret upstream body',
    )
  })
})
