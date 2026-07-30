import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AiConfigStore,
  DEFAULT_AI_BASE_URLS,
  DEFAULT_AI_MODEL,
  type AiSecretCipher,
} from '../../src/main/ai-config-store.js'

const temporaryDirectories: string[] = []

function configPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'seepal-ai-config-'))
  temporaryDirectories.push(directory)
  return join(directory, 'ai-provider.json')
}

function cipher(available = true): AiSecretCipher {
  return {
    isAvailable: () => available,
    encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
    decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
  }
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('AiConfigStore', () => {
  it('returns examples without creating a config file', () => {
    const path = configPath()
    const store = new AiConfigStore(path, cipher())

    expect(store.getPublicConfig()).toEqual({
      protocol: 'openai',
      baseUrl: DEFAULT_AI_BASE_URLS.openai,
      model: DEFAULT_AI_MODEL,
      hasApiKey: false,
    })
    expect(existsSync(path)).toBe(false)
  })

  it('persists only encrypted key material and preserves it when key is blank', () => {
    const path = configPath()
    const store = new AiConfigStore(path, cipher())
    const secret = 'sk-test-only-value'

    expect(
      store.save({
        protocol: 'anthropic',
        baseUrl: DEFAULT_AI_BASE_URLS.anthropic,
        model: DEFAULT_AI_MODEL,
        apiKey: secret,
      }),
    ).toMatchObject({ hasApiKey: true })
    expect(readFileSync(path, 'utf8')).not.toContain(secret)

    const reopened = new AiConfigStore(path, cipher())
    expect(reopened.getPublicConfig()).toEqual({
      protocol: 'anthropic',
      baseUrl: DEFAULT_AI_BASE_URLS.anthropic,
      model: DEFAULT_AI_MODEL,
      hasApiKey: true,
    })
    reopened.save({
      protocol: 'anthropic',
      baseUrl: DEFAULT_AI_BASE_URLS.anthropic,
      model: 'deepseek-next',
      apiKey: '',
    })
    expect(reopened.getProviderConfig()).toMatchObject({
      apiKey: secret,
      model: 'deepseek-next',
    })
  })

  it('requires the key again before moving it to another service origin', () => {
    const path = configPath()
    const store = new AiConfigStore(path, cipher())
    store.save({
      protocol: 'openai',
      baseUrl: DEFAULT_AI_BASE_URLS.openai,
      model: DEFAULT_AI_MODEL,
      apiKey: 'sk-origin-bound-test-value',
    })
    const before = readFileSync(path, 'utf8')

    expect(() =>
      store.save({
        protocol: 'openai',
        baseUrl: 'https://api.example.com',
        model: DEFAULT_AI_MODEL,
      }),
    ).toThrow('请重新输入 API Key')
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(store.getProviderConfig().apiKey).toBe('sk-origin-bound-test-value')
  })

  it('does not overwrite the old config when encryption is unavailable', () => {
    const path = configPath()
    const availableStore = new AiConfigStore(path, cipher())
    availableStore.save({
      protocol: 'openai',
      baseUrl: DEFAULT_AI_BASE_URLS.openai,
      model: DEFAULT_AI_MODEL,
      apiKey: 'sk-existing-test-value',
    })
    const before = readFileSync(path, 'utf8')

    const unavailableStore = new AiConfigStore(path, cipher(false))
    expect(() =>
      unavailableStore.save({
        protocol: 'openai',
        baseUrl: 'https://example.com',
        model: 'different-model',
        apiKey: 'sk-replacement-test-value',
      }),
    ).toThrow('系统安全存储当前不可用')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('clears only the API key and rejects unsafe base URLs', () => {
    const path = configPath()
    const store = new AiConfigStore(path, cipher())
    store.save({
      protocol: 'anthropic',
      baseUrl: DEFAULT_AI_BASE_URLS.anthropic,
      model: DEFAULT_AI_MODEL,
      apiKey: 'sk-clear-test-value',
    })

    expect(store.clearApiKey()).toEqual({
      protocol: 'anthropic',
      baseUrl: DEFAULT_AI_BASE_URLS.anthropic,
      model: DEFAULT_AI_MODEL,
      hasApiKey: false,
    })
    expect(() => store.getProviderConfig()).toThrow('请先保存 API Key')
    expect(() =>
      store.save({
        protocol: 'openai',
        baseUrl: 'https://user@example.com/path?token=value',
        model: DEFAULT_AI_MODEL,
      }),
    ).toThrow('Base URL 必须')
  })

  it('falls back to examples with a recoverable error for corrupt data', () => {
    const path = configPath()
    writeFileSync(path, '{not json', 'utf8')

    expect(new AiConfigStore(path, cipher()).getPublicConfig()).toMatchObject({
      baseUrl: DEFAULT_AI_BASE_URLS.openai,
      hasApiKey: false,
      loadError: expect.stringContaining('无法读取'),
    })
  })

  it('treats an undecryptable key as corrupt instead of reporting it as saved', () => {
    const path = configPath()
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        protocol: 'openai',
        baseUrl: DEFAULT_AI_BASE_URLS.openai,
        model: DEFAULT_AI_MODEL,
        encryptedApiKey: 'broken-ciphertext',
      }),
      'utf8',
    )
    const brokenCipher: AiSecretCipher = {
      isAvailable: () => true,
      encrypt: (value) => value,
      decrypt: () => {
        throw new Error('secret decrypt detail')
      },
    }

    expect(new AiConfigStore(path, brokenCipher).getPublicConfig()).toMatchObject({
      baseUrl: DEFAULT_AI_BASE_URLS.openai,
      hasApiKey: false,
      loadError: expect.stringContaining('无法读取'),
    })
  })

  it('does not overwrite corrupt data while saving or clearing', () => {
    const path = configPath()
    writeFileSync(path, '{not json', 'utf8')
    const before = readFileSync(path, 'utf8')
    const store = new AiConfigStore(path, cipher())

    expect(() =>
      store.save({
        protocol: 'openai',
        baseUrl: DEFAULT_AI_BASE_URLS.openai,
        model: DEFAULT_AI_MODEL,
      }),
    ).toThrow()
    expect(() => store.clearApiKey()).toThrow()
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('rejects empty query or fragment delimiters and oversized URLs', () => {
    const store = new AiConfigStore(configPath(), cipher())
    for (const baseUrl of [
      'https://example.com?',
      'https://example.com#',
      `https://example.com/${'x'.repeat(2_100)}`,
    ]) {
      expect(() =>
        store.save({
          protocol: 'openai',
          baseUrl,
          model: DEFAULT_AI_MODEL,
        }),
      ).toThrow('Base URL 必须')
    }
  })
})
