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
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function configPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'seepal-ai-config-'))
  temporaryDirectories.push(directory)
  return join(directory, 'ai-provider.json')
}

function cipher(available = true): AiSecretCipher {
  return {
    isAvailable: async () => available,
    encrypt: async (value) => Buffer.from(value, 'utf8').toString('base64'),
    decrypt: async (value) => Buffer.from(value, 'base64').toString('utf8'),
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
  it('returns examples without creating a config file', async () => {
    const path = configPath()
    const store = new AiConfigStore(path, cipher())

    await expect(store.getPublicConfig()).resolves.toEqual({
      protocol: 'openai',
      baseUrl: DEFAULT_AI_BASE_URLS.openai,
      model: DEFAULT_AI_MODEL,
      hasApiKey: false,
    })
    expect(existsSync(path)).toBe(false)
  })

  it('rejects preserving an existing key when keychain is unavailable', async () => {
    const path = configPath()
    const store = new AiConfigStore(path, cipher())
    await store.save({
      protocol: 'openai',
      baseUrl: DEFAULT_AI_BASE_URLS.openai,
      model: DEFAULT_AI_MODEL,
      apiKey: 'sk-existing-key',
    })
    const before = readFileSync(path, 'utf8')
    const unavailableStore = new AiConfigStore(path, cipher(false))
    await expect(
      unavailableStore.save({
        protocol: 'openai',
        baseUrl: DEFAULT_AI_BASE_URLS.openai,
        model: 'fixed-model',
        apiKey: '',
      }),
    ).rejects.toThrow('请解锁 macOS 登录钥匙串后重试，配置未保存。')
    expect(readFileSync(path, 'utf8')).toBe(before)
    await expect(
      unavailableStore.getPublicConfig()
    ).resolves.toMatchObject({
      hasApiKey: false,
      loadError: expect.stringContaining('请解锁 macOS 登录钥匙串后重试'),
    })
  })

  it('serializes concurrent saves so later request wins and older save does not overwrite', async () => {
    const path = configPath()
    const slowerEncrypt = cipher()
    const store = new AiConfigStore(path, {
      isAvailable: slowerEncrypt.isAvailable,
      encrypt: async (value) => {
        if (value === 'sk-first') await tick()
        return slowerEncrypt.encrypt(value)
      },
      decrypt: slowerEncrypt.decrypt,
    })
    const first = store.save({
      protocol: 'openai',
      baseUrl: DEFAULT_AI_BASE_URLS.openai,
      model: 'model-1',
      apiKey: 'sk-first',
    })
    const second = store.save({
      protocol: 'openai',
      baseUrl: DEFAULT_AI_BASE_URLS.openai,
      model: 'model-2',
      apiKey: 'sk-second',
    })
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    const final = JSON.parse(readFileSync(path, 'utf8'))
    expect(final.model).toBe('model-2')
    expect(final.encryptedApiKey).not.toContain('sk-first')
  })

  it('prevents concurrent clear from being overwritten by an in-flight save', async () => {
    const path = configPath()
    const delayed = cipher()
    const store = new AiConfigStore(path, {
      isAvailable: delayed.isAvailable,
      encrypt: async (value) => {
        if (value === 'sk-race') await tick()
        return delayed.encrypt(value)
      },
      decrypt: delayed.decrypt,
    })
    await store.save({
      protocol: 'openai',
      baseUrl: DEFAULT_AI_BASE_URLS.openai,
      model: 'model-0',
      apiKey: 'sk-initial',
    })
    const save = store.save({
      protocol: 'openai',
      baseUrl: DEFAULT_AI_BASE_URLS.openai,
      model: 'model-3',
      apiKey: 'sk-race',
    })
    const clear = store.clearApiKey()
    await Promise.all([save, clear])
    const final = JSON.parse(readFileSync(path, 'utf8'))
    expect(final.model).toBe('model-0')
    expect(final.encryptedApiKey).toBeUndefined()
  })

  it('persists only encrypted key material and preserves it when key is blank', async () => {
    const path = configPath()
    const store = new AiConfigStore(path, cipher())
    const secret = 'sk-test-only-value'

    await expect(
      store.save({
        protocol: 'anthropic',
        baseUrl: DEFAULT_AI_BASE_URLS.anthropic,
        model: DEFAULT_AI_MODEL,
        apiKey: secret,
      }),
    ).resolves.toMatchObject({ hasApiKey: true })
    expect(readFileSync(path, 'utf8')).not.toContain(secret)

    const reopened = new AiConfigStore(path, cipher())
    await expect(reopened.getPublicConfig()).resolves.toEqual({
      protocol: 'anthropic',
      baseUrl: DEFAULT_AI_BASE_URLS.anthropic,
      model: DEFAULT_AI_MODEL,
      hasApiKey: true,
    })
    await reopened.save({
      protocol: 'anthropic',
      baseUrl: DEFAULT_AI_BASE_URLS.anthropic,
      model: 'deepseek-next',
      apiKey: '',
    })
    await expect(reopened.getProviderConfig()).resolves.toMatchObject({
      apiKey: secret,
      model: 'deepseek-next',
    })
  })

  it('requires the key again before moving it to another service origin', async () => {
    const path = configPath()
    const store = new AiConfigStore(path, cipher())
    await store.save({
      protocol: 'openai',
      baseUrl: DEFAULT_AI_BASE_URLS.openai,
      model: DEFAULT_AI_MODEL,
      apiKey: 'sk-origin-bound-test-value',
    })
    const before = readFileSync(path, 'utf8')

    await expect(
      store.save({
        protocol: 'openai',
        baseUrl: 'https://api.example.com',
        model: DEFAULT_AI_MODEL,
      }),
    ).rejects.toThrow('请重新输入 API Key')
    expect(readFileSync(path, 'utf8')).toBe(before)
    await expect(store.getProviderConfig()).resolves.toMatchObject({
      apiKey: 'sk-origin-bound-test-value',
    })
  })

  it('waits for asynchronous keychain initialization instead of using a synchronous availability result', async () => {
    const path = configPath()
    let initialized = false
    const asynchronousCipher: AiSecretCipher = {
      isAvailable: async () => {
        await Promise.resolve()
        initialized = true
        return true
      },
      encrypt: async (value) => {
        expect(initialized).toBe(true)
        return Buffer.from(value, 'utf8').toString('base64')
      },
      decrypt: async (value) =>
        Buffer.from(value, 'base64').toString('utf8'),
    }
    const store = new AiConfigStore(path, asynchronousCipher)

    await expect(
      store.save({
        protocol: 'openai',
        baseUrl: DEFAULT_AI_BASE_URLS.openai,
        model: DEFAULT_AI_MODEL,
        apiKey: 'sk-async-test-value',
      }),
    ).resolves.toMatchObject({ hasApiKey: true })
    expect(readFileSync(path, 'utf8')).not.toContain('sk-async-test-value')
  })

  it('does not overwrite the old config when encryption is unavailable', async () => {
    const path = configPath()
    const availableStore = new AiConfigStore(path, cipher())
    await availableStore.save({
      protocol: 'openai',
      baseUrl: DEFAULT_AI_BASE_URLS.openai,
      model: DEFAULT_AI_MODEL,
      apiKey: 'sk-existing-test-value',
    })
    const before = readFileSync(path, 'utf8')

    const unavailableStore = new AiConfigStore(path, cipher(false))
    await expect(
      unavailableStore.save({
        protocol: 'openai',
        baseUrl: 'https://example.com',
        model: 'different-model',
        apiKey: 'sk-replacement-test-value',
      }),
    ).rejects.toThrow('请解锁 macOS 登录钥匙串后重试')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('maps encryption failures to the safe keychain prompt without overwriting', async () => {
    const path = configPath()
    const availableStore = new AiConfigStore(path, cipher())
    await availableStore.save({
      protocol: 'openai',
      baseUrl: DEFAULT_AI_BASE_URLS.openai,
      model: DEFAULT_AI_MODEL,
      apiKey: 'sk-existing-encryption-test-value',
    })
    const before = readFileSync(path, 'utf8')
    const failingStore = new AiConfigStore(path, {
      isAvailable: async () => true,
      encrypt: async () => {
        throw new Error('secret keychain implementation detail')
      },
      decrypt: async (value) =>
        Buffer.from(value, 'base64').toString('utf8'),
    })

    const operation = failingStore.save({
      protocol: 'openai',
      baseUrl: DEFAULT_AI_BASE_URLS.openai,
      model: 'replacement-model',
      apiKey: 'sk-replacement-encryption-test-value',
    })
    await expect(operation).rejects.toThrow(
      '请解锁 macOS 登录钥匙串后重试',
    )
    await expect(operation).rejects.not.toThrow(
      'secret keychain implementation detail',
    )
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('clears only the API key and rejects unsafe base URLs', async () => {
    const path = configPath()
    const store = new AiConfigStore(path, cipher())
    await store.save({
      protocol: 'anthropic',
      baseUrl: DEFAULT_AI_BASE_URLS.anthropic,
      model: DEFAULT_AI_MODEL,
      apiKey: 'sk-clear-test-value',
    })

    await expect(store.clearApiKey()).resolves.toEqual({
      protocol: 'anthropic',
      baseUrl: DEFAULT_AI_BASE_URLS.anthropic,
      model: DEFAULT_AI_MODEL,
      hasApiKey: false,
    })
    await expect(store.getProviderConfig()).rejects.toThrow('请先保存 API Key')
    await expect(
      store.save({
        protocol: 'openai',
        baseUrl: 'https://user@example.com/path?token=value',
        model: DEFAULT_AI_MODEL,
      }),
    ).rejects.toThrow('Base URL 必须')
  })

  it('falls back to examples with a recoverable error for corrupt data', async () => {
    const path = configPath()
    writeFileSync(path, '{not json', 'utf8')

    await expect(new AiConfigStore(path, cipher()).getPublicConfig()).resolves.toMatchObject({
      baseUrl: DEFAULT_AI_BASE_URLS.openai,
      hasApiKey: false,
      loadError: expect.stringContaining('无法读取'),
    })
  })

  it('treats an undecryptable key as corrupt instead of reporting it as saved', async () => {
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
      isAvailable: async () => true,
      encrypt: async (value) => value,
      decrypt: async () => {
        throw new Error('secret decrypt detail')
      },
    }

    await expect(new AiConfigStore(path, brokenCipher).getPublicConfig()).resolves.toMatchObject({
      baseUrl: DEFAULT_AI_BASE_URLS.openai,
      hasApiKey: false,
      loadError: expect.stringContaining('无法读取'),
    })
  })

  it('does not overwrite corrupt data while saving or clearing', async () => {
    const path = configPath()
    writeFileSync(path, '{not json', 'utf8')
    const before = readFileSync(path, 'utf8')
    const store = new AiConfigStore(path, cipher())

    await expect(
      store.save({
        protocol: 'openai',
        baseUrl: DEFAULT_AI_BASE_URLS.openai,
        model: DEFAULT_AI_MODEL,
      }),
    ).rejects.toThrow()
    await expect(store.clearApiKey()).rejects.toThrow()
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('rejects empty query or fragment delimiters and oversized URLs', async () => {
    const store = new AiConfigStore(configPath(), cipher())
    for (const baseUrl of [
      'https://example.com?',
      'https://example.com#',
      `https://example.com/${'x'.repeat(2_100)}`,
    ]) {
      await expect(
        store.save({
          protocol: 'openai',
          baseUrl,
          model: DEFAULT_AI_MODEL,
        }),
      ).rejects.toThrow('Base URL 必须')
    }
  })
})
