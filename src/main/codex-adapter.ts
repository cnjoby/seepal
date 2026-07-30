import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { realpath } from 'node:fs/promises'

import type {
  ActivityStatus,
  CodexDiscovery,
  CodexSyncResult,
  ContentStrategy,
  Evidence,
  ProjectScope,
  SessionRecord,
  SessionType,
  SyncFailure
} from '../shared/domain.js'

export const READ_ONLY_CODEX_METHODS = new Set([
  'initialize',
  'initialized',
  'thread/list',
  'thread/read'
])

export interface CodexRpcTransport {
  readonly generation?: number
  request<T>(method: string, params?: unknown): Promise<T>
  notify(method: string, params?: unknown): void
  close(): Promise<void>
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface JsonRpcResponse {
  id?: number
  result?: unknown
  error?: { code?: number; message?: string }
  method?: string
}

export class StdioCodexTransport implements CodexRpcTransport {
  private process?: ChildProcessWithoutNullStreams
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private stdoutBuffer = ''
  private processGeneration = 0

  constructor(
    private readonly executable = 'codex',
    private readonly args: readonly string[] = ['app-server', '--stdio'],
    private readonly requestTimeoutMs = 15_000
  ) {}

  get generation(): number {
    return this.processGeneration
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.process) return this.process
    this.stdoutBuffer = ''
    const child = spawn(this.executable, [...this.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false
    })
    this.processGeneration += 1
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.process === child) this.consumeStdout(chunk)
    })
    child.stderr.resume()
    child.on('error', (error) => this.rejectAll(error))
    child.on('exit', (code, signal) => {
      this.rejectAll(
        new Error(`Codex app-server exited (${code ?? signal ?? 'unknown reason'})`)
      )
      if (this.process === child) {
        this.process = undefined
        this.processGeneration += 1
      }
    })
    this.process = child
    return child
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n')
      if (newline < 0) break
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (!line) continue
      let message: JsonRpcResponse
      try {
        message = JSON.parse(line) as JsonRpcResponse
      } catch {
        continue
      }

      if (typeof message.id === 'number' && message.method) {
        this.ensureProcess().stdin.write(
          `${JSON.stringify({
            id: message.id,
            error: { code: -32601, message: 'SeePal read-only client does not handle server requests' }
          })}\n`
        )
        continue
      }
      if (typeof message.id !== 'number') continue
      const pending = this.pending.get(message.id)
      if (!pending) continue
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        pending.reject(new Error(message.error.message ?? `Codex RPC ${message.error.code}`))
      } else {
        pending.resolve(message.result)
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (!READ_ONLY_CODEX_METHODS.has(method) || method === 'initialized') {
      return Promise.reject(new Error(`Codex method is not on the read-only allowlist: ${method}`))
    }
    const id = this.nextId++
    const child = this.ensureProcess()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new Error(`Codex ${method} 在 ${this.requestTimeoutMs / 1_000} 秒内没有响应。`))
        if (this.process === child) {
          this.process = undefined
          this.processGeneration += 1
          if (child.exitCode === null) child.kill('SIGTERM')
        }
      }, this.requestTimeoutMs)
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      })
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
        if (!error) return
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  notify(method: string, params?: unknown): void {
    if (method !== 'initialized') {
      throw new Error(`Codex notification is not on the read-only allowlist: ${method}`)
    }
    this.ensureProcess().stdin.write(`${JSON.stringify({ method, params })}\n`)
  }

  async close(): Promise<void> {
    const child = this.process
    this.process = undefined
    if (!child) return
    child.stdin.end()
    if (child.exitCode === null) child.kill('SIGTERM')
    this.rejectAll(new Error('Codex transport closed'))
  }
}

interface CodexThreadStatus {
  type: 'notLoaded' | 'idle' | 'systemError' | 'active'
  activeFlags?: Array<'waitingOnApproval' | 'waitingOnUserInput'>
}

interface CodexThreadItem {
  type: string
  text?: string
  content?: Array<{ type: string; text?: string }>
}

interface CodexThread {
  id: string
  preview: string
  cwd: string
  createdAt: number
  updatedAt: number
  status: CodexThreadStatus
  cliVersion: string
  gitInfo: { sha?: string | null; branch?: string | null } | null
  name?: string | null
  turns: Array<{ items: CodexThreadItem[] }>
}

interface ThreadListResponse {
  data: CodexThread[]
  nextCursor: string | null
}

interface ThreadReadResponse {
  thread: CodexThread
}

interface InitializeResponse {
  userAgent?: string
}

interface AdapterOptions {
  resolvePath?: (path: string) => Promise<string>
  now?: () => Date
  pageSize?: number
}

interface TypeSuggestion {
  type: SessionType
  confidence: number
  basis: string[]
}

const TYPE_PATTERNS: Array<{
  type: SessionType
  pattern: RegExp
  basis: string
}> = [
  { type: 'code-review', pattern: /\bcode review\b|\breview\b|代码审查|评审/i, basis: '目标包含审查' },
  { type: 'testing', pattern: /\btests?\b|\bqa\b|测试|验收|回归/i, basis: '目标包含测试或验收' },
  {
    type: 'investigation',
    pattern: /\binvestigat|\bresearch\b|\bdiagnos|调研|排查|诊断|分析原因/i,
    basis: '目标包含调研或问题排查'
  },
  { type: 'bugfix', pattern: /\bbugs?\b|\bfix\b|修复|故障|报错|错误/i, basis: '目标包含 BUG 修复' },
  {
    type: 'release-operations',
    pattern: /\brelease\b|\bdeploy|发布|部署|运维|上线/i,
    basis: '目标包含发布或部署'
  },
  {
    type: 'engineering-governance',
    pattern: /\brefactor|\bci\b|\bbuild\b|重构|工程治理|依赖升级|架构/i,
    basis: '目标包含工程治理'
  },
  {
    type: 'documentation',
    pattern: /\bdocs?\b|\breadme\b|文档|说明书/i,
    basis: '目标包含文档工作'
  },
  {
    type: 'product-design',
    pattern: /\bux\b|\bui\b|\bprd\b|产品设计|交互|设计稿/i,
    basis: '目标包含产品或设计工作'
  },
  {
    type: 'feature',
    pattern: /\bfeature\b|\bimplement|需求|功能|实现|新增/i,
    basis: '目标包含需求或功能实现'
  }
]

function suggestType(text: string): TypeSuggestion {
  for (const candidate of TYPE_PATTERNS) {
    if (candidate.pattern.test(text)) {
      return { type: candidate.type, confidence: 0.78, basis: [candidate.basis] }
    }
  }
  return {
    type: 'unknown',
    confidence: 0.2,
    basis: ['没有发现足以可靠分类的明确表述']
  }
}

function activityStatus(status: CodexThreadStatus): ActivityStatus {
  if (status.type === 'active') {
    if (
      status.activeFlags?.includes('waitingOnUserInput') ||
      status.activeFlags?.includes('waitingOnApproval')
    ) {
      return 'waiting-for-user'
    }
    return 'running'
  }
  if (status.type === 'idle') return 'ended'
  return 'unknown'
}

function isoFromUnixSeconds(value: number): string {
  return new Date(value * 1_000).toISOString()
}

function isThreadListResponse(value: unknown): value is ThreadListResponse {
  if (!value || typeof value !== 'object') return false
  const response = value as Partial<ThreadListResponse>
  if (!Array.isArray(response.data)) return false
  if (response.nextCursor !== null && typeof response.nextCursor !== 'string') return false
  return response.data.every(
    (thread) =>
      Boolean(thread) &&
      typeof thread.id === 'string' &&
      typeof thread.preview === 'string' &&
      typeof thread.cwd === 'string' &&
      Number.isFinite(thread.createdAt) &&
      Number.isFinite(thread.updatedAt) &&
      typeof thread.cliVersion === 'string' &&
      Boolean(thread.status) &&
      typeof thread.status.type === 'string'
  )
}

function extractLocalText(thread: CodexThread): string {
  const text: string[] = []
  for (const turn of thread.turns) {
    for (const item of turn.items) {
      if (item.type === 'userMessage') {
        for (const content of item.content ?? []) {
          if (content.type === 'text' && content.text) text.push(content.text)
        }
      } else if (item.type === 'agentMessage' && item.text) {
        text.push(item.text)
      }
      if (text.join('\n').length >= 1_000) return text.join('\n').slice(0, 1_000)
    }
  }
  return text.join('\n').slice(0, 1_000)
}

function hasFileChanges(thread: CodexThread): boolean {
  return thread.turns.some((turn) =>
    turn.items.some((item) => item.type === 'fileChange')
  )
}

export class CodexAdapter {
  private initialized = false
  private compatibility?: CodexDiscovery['compatibility']
  private initializedGeneration?: number
  private readonly resolvePath: (path: string) => Promise<string>
  private readonly now: () => Date
  private readonly pageSize: number

  constructor(
    private readonly transport: CodexRpcTransport = new StdioCodexTransport(),
    options: AdapterOptions = {}
  ) {
    this.resolvePath = options.resolvePath ?? realpath
    this.now = options.now ?? (() => new Date())
    this.pageSize = options.pageSize ?? 100
  }

  private async initialize(): Promise<CodexDiscovery['compatibility']> {
    if (
      this.initialized &&
      this.compatibility &&
      this.initializedGeneration === this.transport.generation
    ) {
      return this.compatibility
    }
    const response = await this.transport.request<InitializeResponse>('initialize', {
      clientInfo: { name: 'seepal', title: 'SeePal', version: '0.1.0' },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: []
      }
    })
    this.transport.notify('initialized')
    this.initialized = true
    this.initializedGeneration = this.transport.generation
    const supported = /(?:^|[/\s])0\.139(?:\.|$)/.test(response.userAgent ?? '')
    this.compatibility = {
      status: supported ? 'supported' : 'degraded',
      version: response.userAgent,
      message: supported
        ? 'Codex App Server 只读 Thread 接口可用。'
        : 'Codex App Server 可读取，但版本不在已验证的 0.139.x 范围内。'
    }
    return this.compatibility
  }

  private async canonicalIncludedPaths(scope: ProjectScope): Promise<string[]> {
    const paths: string[] = []
    for (const path of scope.includedPaths) {
      try {
        paths.push(await this.resolvePath(path))
      } catch {
        // An unavailable worktree is not silently replaced with a broader path.
      }
    }
    return [...new Set(paths)]
  }

  private async listMatchedThreads(
    scope: ProjectScope,
    failures: SyncFailure[],
    deadline: number
  ): Promise<CodexThread[]> {
    const includedPaths = await this.canonicalIncludedPaths(scope)
    const allowedPaths = new Set(includedPaths)
    const matched = new Map<string, CodexThread>()
    let pageCount = 0
    if (includedPaths.length === 0) {
      failures.push({
        stage: 'list',
        message: '授权范围内没有仍可读取的项目或 Worktree 路径。'
      })
      return []
    }

    for (const archived of [false, true]) {
      let cursor: string | null = null
      do {
        if (Date.now() >= deadline) {
          failures.push({
            stage: 'list',
            message: 'Codex 历史读取达到 8 分钟上限，已保留当前结果。'
          })
          return [...matched.values()]
        }
        if (++pageCount > 100) {
          failures.push({
            stage: 'list',
            message: 'Codex 分页超过安全上限，已停止继续读取。'
          })
          return [...matched.values()]
        }
        let response: ThreadListResponse
        try {
          const rawResponse = await this.transport.request<unknown>('thread/list', {
            cursor,
            limit: this.pageSize,
            sortKey: 'updated_at',
            sortDirection: 'desc',
            cwd: includedPaths,
            archived,
            useStateDbOnly: true
          })
          if (!isThreadListResponse(rawResponse)) {
            failures.push({
              stage: 'list',
              message: 'Codex Thread 列表格式与已验证接口不一致。'
            })
            break
          }
          response = rawResponse
        } catch (error) {
          failures.push({
            stage: 'list',
            message: error instanceof Error ? error.message : '无法读取 Codex Thread 列表。'
          })
          break
        }

        for (const thread of response.data) {
          try {
            const canonicalCwd = await this.resolvePath(thread.cwd)
            if (allowedPaths.has(canonicalCwd)) {
              matched.set(thread.id, { ...thread, cwd: canonicalCwd })
            }
          } catch {
            failures.push({
              stage: 'list',
              providerSessionId: thread.id,
              message: 'Thread 工作目录不可用，未将其归入项目。'
            })
          }
        }
        cursor = response.nextCursor
      } while (cursor)
    }

    return [...matched.values()]
  }

  private coverageFor(threads: CodexThread[], isComplete: boolean) {
    const timestamps = threads.flatMap((thread) => [thread.createdAt, thread.updatedAt])
    return {
      from: timestamps.length > 0 ? isoFromUnixSeconds(Math.min(...timestamps)) : undefined,
      to: timestamps.length > 0 ? isoFromUnixSeconds(Math.max(...timestamps)) : undefined,
      sessionCount: threads.length,
      isComplete,
      note: isComplete ? undefined : '部分 Thread 读取失败，当前覆盖不完整。'
    }
  }

  async discover(projectId: string, scope: ProjectScope): Promise<CodexDiscovery> {
    void projectId
    const failures: SyncFailure[] = []
    let compatibility: CodexDiscovery['compatibility']
    try {
      compatibility = await this.initialize()
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法初始化 Codex App Server。'
      return {
        matchedCount: 0,
        compatibility: { status: 'unsupported', message },
        failures: [{ stage: 'initialize', message }]
      }
    }

    const threads = await this.listMatchedThreads(scope, failures, Date.now() + 8 * 60_000)
    return {
      matchedCount: threads.length,
      coverage: this.coverageFor(threads, failures.length === 0),
      compatibility:
        failures.length === 0
          ? compatibility
          : { ...compatibility, status: 'degraded', message: '部分 Codex 数据无法读取。' },
      failures
    }
  }

  async sync(
    projectId: string,
    scope: ProjectScope,
    strategy: ContentStrategy
  ): Promise<CodexSyncResult> {
    const failures: SyncFailure[] = []
    let compatibility: CodexDiscovery['compatibility']
    try {
      compatibility = await this.initialize()
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法初始化 Codex App Server。'
      return {
        matchedCount: 0,
        sessions: [],
        evidence: [],
        compatibility: { status: 'unsupported', message },
        failures: [{ stage: 'initialize', message }]
      }
    }

    const deadline = Date.now() + 8 * 60_000
    const listedThreads = await this.listMatchedThreads(scope, failures, deadline)
    const collectedAt = this.now().toISOString()
    const sessions: SessionRecord[] = []
    const evidence: Evidence[] = []

    for (const listedThread of listedThreads) {
      if (Date.now() >= deadline) {
        failures.push({
          stage: 'read',
          message: 'Codex Session 详情读取达到 8 分钟上限，已保留当前结果。'
        })
        break
      }
      let thread = listedThread
      let isPartial = false
      if (strategy === 'full-local') {
        try {
          const response = await this.transport.request<ThreadReadResponse>('thread/read', {
            threadId: listedThread.id,
            includeTurns: true
          })
          if (response.thread.id !== listedThread.id) {
            throw new Error('Thread 详情 ID 与列表结果不一致。')
          }
          const canonicalCwd = await this.resolvePath(response.thread.cwd)
          if (canonicalCwd !== listedThread.cwd) {
            throw new Error('Thread 详情工作目录与列表结果不一致。')
          }
          thread = { ...response.thread, cwd: canonicalCwd }
        } catch (error) {
          isPartial = true
          failures.push({
            stage: 'read',
            providerSessionId: listedThread.id,
            message: error instanceof Error ? error.message : '无法读取完整 Thread 内容。'
          })
        }
      }

      const localText = strategy === 'full-local' && !isPartial ? extractLocalText(thread) : ''
      const suggestion = suggestType(`${thread.name ?? ''}\n${thread.preview}\n${localText}`)
      const id = `${projectId}:codex:${thread.id}`
      const status = activityStatus(thread.status)
      const session: SessionRecord = {
        id,
        projectId,
        provider: 'codex',
        providerSessionId: thread.id,
        title: thread.name?.trim() || thread.preview.trim() || `Codex Session ${thread.id}`,
        cwd: thread.cwd,
        createdAt: isoFromUnixSeconds(thread.createdAt),
        updatedAt: isoFromUnixSeconds(thread.updatedAt),
        lastActivityAt: isoFromUnixSeconds(thread.updatedAt),
        activityStatus: status,
        suggestedType: suggestion.type,
        suggestedTypeConfidence: suggestion.confidence,
        suggestedTypeBasis: suggestion.basis,
        primaryType: suggestion.type,
        branch: thread.gitInfo?.branch ?? undefined,
        worktreePath: thread.cwd,
        sourceBaseCommit: thread.gitInfo?.sha ?? undefined,
        contentStrategy: strategy,
        contentPreview: undefined,
        sourceVersion: thread.cliVersion || compatibility.version,
        isPartial,
        collectedAt
      }
      sessions.push(session)
      evidence.push({
        id: `${id}:activity:${thread.updatedAt}:${status}`,
        projectId,
        sessionId: id,
        axis: 'activity',
        status,
        summary:
          status === 'running'
            ? 'Codex 当前仍在执行这个 Session。'
            : status === 'waiting-for-user'
              ? 'Codex 正在等待用户输入或批准。'
              : status === 'ended'
                ? 'Codex 当前没有正在执行的 Turn；这不代表需求已经完成。'
                : 'Codex 当前状态不足以判断 Session 是否仍在执行。',
        source: 'codex-thread-status',
        sourceRef: thread.id,
        occurredAt: isoFromUnixSeconds(thread.updatedAt),
        collectedAt,
        confidence: status === 'unknown' ? 'unknown' : 'confirmed'
      })

      if (strategy === 'full-local' && !isPartial) {
        const changed = hasFileChanges(thread)
        evidence.push({
          id: `${id}:codex-file-change:${thread.updatedAt}:${changed}`,
          projectId,
          sessionId: id,
          axis: 'changes',
          status: changed ? 'present' : 'none',
          summary: changed
            ? 'Codex Thread 记录了文件修改。'
            : '完整 Thread 中没有发现文件修改记录。',
          source: 'codex-thread-read',
          sourceRef: thread.id,
          occurredAt: isoFromUnixSeconds(thread.updatedAt),
          collectedAt,
          confidence: 'confirmed'
        })
      }
    }

    const isComplete = failures.length === 0
    return {
      matchedCount: sessions.length,
      sessions,
      evidence,
      coverage: this.coverageFor(listedThreads, isComplete),
      compatibility: isComplete
        ? compatibility
        : { ...compatibility, status: 'degraded', message: '部分 Codex 数据无法读取。' },
      failures
    }
  }

  async close(): Promise<void> {
    await this.transport.close()
  }
}
