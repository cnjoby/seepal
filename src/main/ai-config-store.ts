import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import type {
  AiConfigDto,
  AiConfigInput,
  AiProtocol,
} from '../shared/ipc.js'
import {
  DEFAULT_AI_BASE_URLS,
  DEFAULT_AI_MODEL,
} from '../shared/ipc.js'

export { DEFAULT_AI_BASE_URLS, DEFAULT_AI_MODEL }

export interface AiSecretCipher {
  isAvailable(): Promise<boolean>
  encrypt(value: string): Promise<string>
  decrypt(value: string): Promise<string>
}

interface StoredAiConfig {
  version: 1
  protocol: AiProtocol
  baseUrl: string
  model: string
  encryptedApiKey?: string
}

export interface AiProviderConfig {
  protocol: AiProtocol
  baseUrl: string
  model: string
  apiKey: string
}

const MAX_BASE_URL_LENGTH = 2_048
const MAX_CONFIG_FILE_BYTES = 65_536

function defaultConfig(): AiConfigDto {
  return {
    protocol: 'openai',
    baseUrl: DEFAULT_AI_BASE_URLS.openai,
    model: DEFAULT_AI_MODEL,
    hasApiKey: false,
  }
}

function validateProtocol(value: unknown): AiProtocol {
  if (value === 'openai' || value === 'anthropic') return value
  throw new TypeError('AI 协议无效。')
}

function validateBaseUrl(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Base URL 无效。')
  const trimmed = value.trim()
  if (
    !trimmed ||
    trimmed.length > MAX_BASE_URL_LENGTH ||
    trimmed.includes('?') ||
    trimmed.includes('#')
  ) {
    throw new TypeError('Base URL 必须是无账号、Query 或 Fragment 的 HTTPS 地址。')
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new TypeError('Base URL 无效。')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError('Base URL 必须是无账号、Query 或 Fragment 的 HTTPS 地址。')
  }
  return url.href.replace(/\/$/, '')
}

function validateModel(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('模型名称无效。')
  const model = value.trim()
  if (!model || model.length > 200) throw new TypeError('模型名称无效。')
  return model
}

function validateStored(value: unknown): StoredAiConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('配置格式无效。')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1) throw new TypeError('配置版本无效。')
  const encryptedApiKey = record.encryptedApiKey
  if (
    encryptedApiKey !== undefined &&
    (typeof encryptedApiKey !== 'string' || !encryptedApiKey)
  ) {
    throw new TypeError('密钥格式无效。')
  }
  return {
    version: 1,
    protocol: validateProtocol(record.protocol),
    baseUrl: validateBaseUrl(record.baseUrl),
    model: validateModel(record.model),
    encryptedApiKey,
  }
}

export class AiConfigStore {
  constructor(
    private readonly filePath: string,
    private readonly cipher: AiSecretCipher,
  ) {}

  async getPublicConfig(): Promise<AiConfigDto> {
    try {
      const stored = this.readStored()
      if (!stored) return defaultConfig()
      if (
        stored.encryptedApiKey &&
        (await this.isCipherAvailable())
      ) {
        const apiKey = await this.cipher.decrypt(stored.encryptedApiKey)
        if (!apiKey) throw new TypeError('密钥无法解密。')
      }
      return this.toPublic(stored)
    } catch {
      return {
        ...defaultConfig(),
        loadError: 'AI 配置文件无法读取，已显示默认示例。保存后可恢复。',
      }
    }
  }

  async save(input: AiConfigInput): Promise<AiConfigDto> {
    const protocol = validateProtocol(input.protocol)
    const baseUrl = validateBaseUrl(input.baseUrl)
    const model = validateModel(input.model)
    const normalizedApiKey = input.apiKey?.trim()
    const newApiKey = normalizedApiKey ? normalizedApiKey : undefined
    const current = this.readStored()

    let encryptedApiKey = current?.encryptedApiKey
    if (
      current &&
      encryptedApiKey &&
      newApiKey === undefined &&
      new URL(current.baseUrl).origin !== new URL(baseUrl).origin
    ) {
      throw new Error('更换模型服务域名时，请重新输入 API Key。原配置未修改。')
    }
    if (newApiKey !== undefined) {
      if (!(await this.isCipherAvailable())) {
        throw new Error(
          '系统安全存储当前不可用。请解锁 macOS 登录钥匙串后重试，配置未保存。',
        )
      }
      try {
        encryptedApiKey = await this.cipher.encrypt(newApiKey)
      } catch {
        throw new Error(
          '系统安全存储当前不可用。请解锁 macOS 登录钥匙串后重试，配置未保存。',
        )
      }
    }

    const next: StoredAiConfig = {
      version: 1,
      protocol,
      baseUrl,
      model,
      encryptedApiKey,
    }
    this.writeAtomic(next)
    return this.toPublic(next)
  }

  async clearApiKey(): Promise<AiConfigDto> {
    const current = this.readStored() ?? {
      version: 1,
      protocol: 'openai',
      baseUrl: DEFAULT_AI_BASE_URLS.openai,
      model: DEFAULT_AI_MODEL,
    }
    const { encryptedApiKey: _removed, ...next } = current
    this.writeAtomic(next)
    return this.toPublic(next)
  }

  async getProviderConfig(): Promise<AiProviderConfig> {
    let stored: StoredAiConfig | undefined
    try {
      stored = this.readStored()
    } catch {
      throw new Error('AI 配置文件无法读取，请重新保存配置。')
    }
    if (!stored?.encryptedApiKey) {
      throw new Error('请先保存 API Key。')
    }
    if (!(await this.isCipherAvailable())) {
      throw new Error(
        '系统安全存储当前不可用。请解锁 macOS 登录钥匙串后重试。',
      )
    }
    let apiKey: string
    try {
      apiKey = await this.cipher.decrypt(stored.encryptedApiKey)
    } catch {
      throw new Error('已保存的 API Key 无法解密，请清除后重新保存。')
    }
    if (!apiKey) throw new Error('请先保存 API Key。')
    return {
      protocol: stored.protocol,
      baseUrl: stored.baseUrl,
      model: stored.model,
      apiKey,
    }
  }

  private readStored(): StoredAiConfig | undefined {
    try {
      if (statSync(this.filePath).size > MAX_CONFIG_FILE_BYTES) {
        throw new TypeError('配置文件过大。')
      }
      return validateStored(JSON.parse(readFileSync(this.filePath, 'utf8')))
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return undefined
      }
      throw error
    }
  }

  private toPublic(stored: StoredAiConfig): AiConfigDto {
    return {
      protocol: stored.protocol,
      baseUrl: stored.baseUrl,
      model: stored.model,
      hasApiKey: Boolean(stored.encryptedApiKey),
    }
  }

  private async isCipherAvailable(): Promise<boolean> {
    try {
      return await this.cipher.isAvailable()
    } catch {
      return false
    }
  }

  private writeAtomic(config: StoredAiConfig): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      renameSync(temporaryPath, this.filePath)
    } catch (error) {
      try {
        unlinkSync(temporaryPath)
      } catch {
        // The temporary file may not have been created.
      }
      throw error
    }
  }
}
