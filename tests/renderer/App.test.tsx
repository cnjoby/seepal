import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/App'
import type {
  ProjectDashboardDto,
  ProjectSummaryDto,
  SeePalApi,
  SessionViewDto,
} from '../../src/shared/ipc'

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    listProjects: vi.fn(),
    selectDirectory: vi.fn(),
    inspectProject: vi.fn(),
    addProject: vi.fn(),
    getProjectDashboard: vi.fn(),
    syncCodex: vi.fn(),
    updateSessionType: vi.fn(),
    deleteProject: vi.fn(),
    getAiConfig: vi.fn(),
    saveAiConfig: vi.fn(),
    clearAiApiKey: vi.fn(),
    testAiConnection: vi.fn(),
    prepareAiScan: vi.fn(),
    startAiScan: vi.fn(),
    getAiScanStatus: vi.fn(),
    cancelAiScan: vi.fn(),
    resumeAiScan: vi.fn(),
    retryAiScanFailures: vi.fn(),
  },
}))

vi.mock('../../src/renderer/api', () => ({ api: mockApi }))

const project: ProjectSummaryDto = {
  id: 'project-1',
  name: 'SeePal',
  path: '/Users/test/SeePal',
  contentPolicy: 'metadata',
  sessionCount: 2,
  attentionCount: 1,
  lastSyncedAt: '2026-07-30T08:30:00.000Z',
  sourceStatus: 'complete',
}

function evidence(
  overrides: Partial<SessionViewDto['evidence'][number]>,
): SessionViewDto['evidence'][number] {
  return {
    key: 'activity',
    label: '活动',
    status: '已结束',
    summary: 'Session 已停止活动。',
    tone: 'complete',
    source: 'Codex',
    occurredAt: '2026-07-30T08:00:00.000Z',
    collectedAt: '2026-07-30T08:30:00.000Z',
    freshness: 'fresh',
    ...overrides,
  }
}

const bugSession: SessionViewDto = {
  id: 'session-bug',
  provider: 'Codex',
  title: '修复菜单栏状态丢失',
  type: 'bugfix',
  suggestedType: 'bugfix',
  typeConfidence: 0.94,
  typeReason: '目标中明确包含修复与回归。',
  group: 'needs-attention',
  status: 'Session 已结束，改动待 Review',
  nextAction: '检查 4 个文件的改动',
  lastActivityAt: '2026-07-30T08:00:00.000Z',
  branch: 'codex/bug-menubar',
  worktree: '/Users/test/.worktrees/bug-menubar',
  evidence: [
    evidence({ key: 'activity', label: '活动' }),
    evidence({
      key: 'changes',
      label: '改动',
      status: '有 4 个文件变化',
      summary: '发现属于当前 Session 的候选 Diff。',
      tone: 'attention',
      relation: 'candidate',
      source: 'Git worktree',
    }),
    evidence({
      key: 'review',
      label: '人工 Review',
      status: '尚未确认',
      summary: '没有找到当前 Diff 对应的人工确认。',
      tone: 'attention',
    }),
    evidence({
      key: 'commit',
      label: 'Commit',
      status: '未提交',
      summary: 'Worktree 中仍有未提交改动。',
      tone: 'attention',
    }),
    evidence({
      key: 'worktree',
      label: 'Worktree',
      status: '仍有改动',
      summary: '隔离工作区尚未收尾。',
      tone: 'attention',
    }),
    evidence({
      key: 'handoff',
      label: '承接',
      status: '无需承接',
      summary: '没有发现承接缺口。',
      tone: 'not-applicable',
    }),
  ],
}

const featureSession: SessionViewDto = {
  ...bugSession,
  id: 'session-feature',
  title: '实现本地项目切换',
  type: 'feature',
  suggestedType: 'feature',
  group: 'settled',
  status: '当前无需处理',
  nextAction: undefined,
  branch: 'codex/project-switcher',
  evidence: bugSession.evidence.map((item) => ({
    ...item,
    tone: 'complete',
    status: '已有事实',
  })),
}

const dashboard: ProjectDashboardDto = {
  project,
  sessions: [bugSession, featureSession],
  coverage: {
    sessionCount: 2,
    from: '2026-07-29T08:00:00.000Z',
    to: '2026-07-30T08:30:00.000Z',
    lastSuccessfulAt: '2026-07-30T08:30:00.000Z',
    status: 'complete',
  },
}

function resetApi() {
  vi.clearAllMocks()
  window.localStorage.clear()
  mockApi.listProjects.mockResolvedValue([project])
  mockApi.getProjectDashboard.mockResolvedValue(dashboard)
  mockApi.syncCodex.mockResolvedValue(dashboard)
  mockApi.updateSessionType.mockImplementation(
    async (_projectId: string, _sessionId: string, type: SessionViewDto['type']) => ({
      ...bugSession,
      type,
    }),
  )
  mockApi.deleteProject.mockResolvedValue({ success: true })
  mockApi.getAiConfig.mockResolvedValue({
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    hasApiKey: false,
  })
  mockApi.saveAiConfig.mockImplementation(async (input) => ({
    protocol: input.protocol,
    baseUrl: input.baseUrl,
    model: input.model,
    hasApiKey: Boolean(input.apiKey),
  }))
  mockApi.clearAiApiKey.mockResolvedValue({
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    hasApiKey: false,
  })
  mockApi.testAiConnection.mockResolvedValue({
    ok: true,
    message: '连接成功。',
    model: 'deepseek-v4-flash',
    latencyMs: 42,
  })
  mockApi.prepareAiScan.mockResolvedValue({
    id: 'preparation-1',
    projectId: project.id,
    projectName: project.name,
    sessionCount: 2,
    cachedCount: 0,
    requestCount: 2,
    providerHost: 'api.deepseek.com',
    model: 'deepseek-v4-flash',
    hasApiKey: true,
    expiresAt: '2026-07-30T12:00:00.000Z',
  })
  mockApi.getAiScanStatus.mockResolvedValue({
    status: 'idle',
    total: 0,
    succeeded: 0,
    reused: 0,
    failed: 0,
    stale: 0,
    unknown: 0,
    pending: 0,
    items: [],
    interpretations: {},
  })
}

describe('Epic 1 Project Console', () => {
  beforeEach(resetApi)

  it('adds a local project only after scope and content policy confirmation', async () => {
    const user = userEvent.setup()
    mockApi.listProjects
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([project])
    mockApi.selectDirectory.mockResolvedValue(project.path)
    mockApi.inspectProject.mockResolvedValue({
      path: project.path,
      name: project.name,
      valid: true,
      repositoryRoot: project.path,
      worktrees: [{ path: project.path, branch: 'main', included: true }],
      codex: {
        status: 'found',
        sessionCount: 2,
        attributionBasis: '项目工作目录一致',
      },
    })
    mockApi.addProject.mockResolvedValue(project)

    render(<App />)

    await user.click(await screen.findByRole('button', { name: '添加第一个项目' }))
    await user.click(screen.getByRole('button', { name: '选择项目文件夹' }))

    expect(await screen.findByText('确认读取边界')).toBeInTheDocument()
    expect(screen.getByText(project.path)).toBeInTheDocument()
    expect(screen.getByText('发现 2 个候选 Session')).toBeInTheDocument()

    await user.click(screen.getByText('允许在本机读取完整内容'))
    await user.click(screen.getByRole('button', { name: '确认并开始同步' }))

    await waitFor(() => {
      expect(mockApi.addProject).toHaveBeenCalledWith({
        path: project.path,
        confirmedRepositoryRoot: project.path,
        contentPolicy: 'full-local',
      })
      expect(mockApi.syncCodex).toHaveBeenCalledWith(project.id, 'full-local')
    })
  })

  it('combines type filtering with details and preserves explicit type correction', async () => {
    const user = userEvent.setup()
    render(<App />)

    expect(await screen.findByText('修复菜单栏状态丢失')).toBeInTheDocument()
    expect(screen.getByText('实现本地项目切换')).toBeInTheDocument()

    const filters = screen.getAllByRole('combobox')
    await user.selectOptions(filters[1]!, 'bugfix')

    expect(screen.getByText('修复菜单栏状态丢失')).toBeInTheDocument()
    expect(screen.queryByText('实现本地项目切换')).not.toBeInTheDocument()

    await user.click(screen.getByText('修复菜单栏状态丢失'))

    const drawer = screen.getByRole('complementary', {
      name: '修复菜单栏状态丢失 详情',
    })
    expect(within(drawer).getByText('六条独立状态')).toBeInTheDocument()
    expect(within(drawer).queryByText('证据冲突', { exact: false })).not.toBeInTheDocument()
    expect(within(drawer).getByText('候选关系')).toBeInTheDocument()

    await user.click(within(drawer).getByRole('button', { name: '修正类型' }))
    await user.selectOptions(within(drawer).getByRole('combobox'), 'investigation')
    await user.click(within(drawer).getByRole('button', { name: '保存类型' }))

    await waitFor(() =>
      expect(mockApi.updateSessionType).toHaveBeenCalledWith(
        project.id,
        bugSession.id,
        'investigation',
      ),
    )
  })

  it('requires the exact project name before deleting only the SeePal copy', async () => {
    const user = userEvent.setup()
    mockApi.listProjects.mockResolvedValueOnce([project]).mockResolvedValueOnce([])
    render(<App />)

    await user.click(await screen.findByRole('button', { name: '删除' }))

    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText('不会删除 Codex Session')).toBeInTheDocument()
    expect(
      within(dialog).getByRole('button', { name: '删除 SeePal 副本' }),
    ).toBeDisabled()

    await user.type(within(dialog).getByPlaceholderText(project.name), project.name)
    await user.click(within(dialog).getByRole('button', { name: '删除 SeePal 副本' }))

    await waitFor(() => expect(mockApi.deleteProject).toHaveBeenCalledWith(project.id))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('preserves a project full-local policy during ordinary refresh', async () => {
    const user = userEvent.setup()
    const fullLocalProject = { ...project, contentPolicy: 'full-local' as const }
    mockApi.listProjects.mockResolvedValue([fullLocalProject])
    mockApi.getProjectDashboard.mockResolvedValue({
      ...dashboard,
      project: fullLocalProject,
    })

    render(<App />)

    await user.click(await screen.findByRole('button', { name: '同步 ⌘R' }))

    await waitFor(() =>
      expect(mockApi.syncCodex).toHaveBeenCalledWith(project.id, 'full-local'),
    )
  })

  it('shows global AI examples without connecting or exposing a saved key', async () => {
    const user = userEvent.setup()
    mockApi.getAiConfig.mockResolvedValue({
      protocol: 'anthropic',
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-v4-flash',
      hasApiKey: true,
    })
    render(<App />)

    await user.click(await screen.findByRole('button', { name: 'AI 设置' }))
    const dialog = await screen.findByRole('dialog', { name: 'AI 设置' })

    expect(
      within(dialog).getByText('OpenAI · https://api.deepseek.com'),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(
        'Anthropic · https://api.deepseek.com/anthropic',
      ),
    ).toBeInTheDocument()
    expect(within(dialog).getByText('已保存密钥')).toBeInTheDocument()
    expect(
      within(dialog).getByPlaceholderText('sk-your-api-key'),
    ).toHaveValue('')
    expect(mockApi.testAiConnection).not.toHaveBeenCalled()
  })

  it('saves current AI settings before an explicitly requested connection test', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: 'AI 设置' }))
    const dialog = await screen.findByRole('dialog', { name: 'AI 设置' })
    await waitFor(() =>
      expect(within(dialog).getByLabelText('兼容协议')).toBeEnabled(),
    )

    await user.selectOptions(
      within(dialog).getByLabelText('兼容协议'),
      'anthropic',
    )
    expect(within(dialog).getByLabelText('Base URL')).toHaveValue(
      'https://api.deepseek.com/anthropic',
    )
    await user.type(
      within(dialog).getByPlaceholderText('sk-your-api-key'),
      'sk-renderer-test-only',
    )
    await user.click(
      within(dialog).getByRole('button', { name: '测试连接' }),
    )

    await waitFor(() =>
      expect(mockApi.saveAiConfig).toHaveBeenCalledWith({
        protocol: 'anthropic',
        baseUrl: 'https://api.deepseek.com/anthropic',
        model: 'deepseek-v4-flash',
        apiKey: 'sk-renderer-test-only',
      }),
    )
    expect(mockApi.testAiConnection).toHaveBeenCalledOnce()
    expect(
      await within(dialog).findByText(
        '连接成功。 模型：deepseek-v4-flash · 42 ms',
      ),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByPlaceholderText('sk-your-api-key'),
    ).toHaveValue('')
  })

  it('clears a saved AI key without changing other settings', async () => {
    const user = userEvent.setup()
    const savedConfig = {
      protocol: 'anthropic' as const,
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-v4-flash',
      hasApiKey: true,
    }
    mockApi.getAiConfig.mockResolvedValue(savedConfig)
    mockApi.clearAiApiKey.mockResolvedValue({
      ...savedConfig,
      hasApiKey: false,
    })
    render(<App />)

    await user.click(await screen.findByRole('button', { name: 'AI 设置' }))
    const dialog = await screen.findByRole('dialog', { name: 'AI 设置' })
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: '清除密钥' }),
      ).toBeEnabled(),
    )
    await user.click(
      within(dialog).getByRole('button', { name: '清除密钥' }),
    )

    await waitFor(() => expect(mockApi.clearAiApiKey).toHaveBeenCalledOnce())
    expect(within(dialog).getByText('已清除保存的 API Key。')).toBeInTheDocument()
    expect(within(dialog).queryByText('已保存密钥')).not.toBeInTheDocument()
    expect(within(dialog).getByLabelText('Base URL')).toHaveValue(
      savedConfig.baseUrl,
    )
  })

  it('clears an unsaved key locally without calling the main process', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: 'AI 设置' }))
    const dialog = await screen.findByRole('dialog', { name: 'AI 设置' })
    const keyInput = within(dialog).getByPlaceholderText('sk-your-api-key')
    await user.type(keyInput, '  sk-local-draft-only  ')
    await user.click(
      within(dialog).getByRole('button', { name: '清除密钥' }),
    )

    expect(mockApi.clearAiApiKey).not.toHaveBeenCalled()
    expect(keyInput).toHaveValue('')
    expect(
      within(dialog).getByText('已清空尚未保存的 API Key。'),
    ).toBeInTheDocument()
  })

  it('shows AI assessment labels in the row and drawer', async () => {
    const user = userEvent.setup()
    mockApi.getProjectDashboard.mockResolvedValue({
      ...dashboard,
      sessions: [{
        ...bugSession,
        ai: {
          assessment: 'needs-action',
          nextActor: 'user',
          goal: '修复菜单栏状态',
          outcome: '已完成代码修改',
          gaps: ['缺少人工 Review'],
          nextAction: '检查改动',
          evidenceRefs: ['message-1'],
        },
      }],
    })
    render(<App />)

    expect(await screen.findByText('AI 推断 · 需要你处理')).toBeInTheDocument()
    await user.click(screen.getByText('修复菜单栏状态丢失'))
    const drawer = screen.getByRole('complementary', {
      name: '修复菜单栏状态丢失 详情',
    })
    expect(within(drawer).getByText('AI 推断')).toBeInTheDocument()
    expect(within(drawer).getByText('需要你处理')).toBeInTheDocument()
    expect(within(drawer).getByText('修复菜单栏状态')).toBeInTheDocument()
    expect(within(drawer).getByText('缺少人工 Review', { exact: false })).toBeInTheDocument()
  })

  it('drops a late AI preparation after switching projects', async () => {
    const user = userEvent.setup()
    const projectTwo = {
      ...project,
      id: 'project-2',
      name: 'Other',
      path: '/Users/test/Other',
    }
    let resolvePreparation!: (value: Awaited<ReturnType<SeePalApi['prepareAiScan']>>) => void
    mockApi.listProjects.mockResolvedValue([project, projectTwo])
    mockApi.getProjectDashboard.mockImplementation(async (projectId: string) => ({
      ...dashboard,
      project: projectId === project.id ? project : projectTwo,
    }))
    mockApi.prepareAiScan.mockImplementation(
      () => new Promise((resolve) => {
        resolvePreparation = resolve
      }),
    )
    render(<App />)

    await screen.findByText('修复菜单栏状态丢失')
    await user.click(screen.getByRole('button', { name: 'AI 解读' }))
    await user.click(screen.getByRole('button', { name: /Other/ }))
    resolvePreparation({
      id: 'late',
      projectId: project.id,
      projectName: project.name,
      sessionCount: 2,
      cachedCount: 0,
      requestCount: 2,
      providerHost: 'api.deepseek.com',
      model: 'deepseek-v4-flash',
      hasApiKey: true,
      expiresAt: '2026-07-30T12:00:00.000Z',
    })

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '项目 Session AI 扫描' }))
        .not.toBeInTheDocument(),
    )
  })
})

const _apiContractCheck: Partial<SeePalApi> = mockApi
void _apiContractCheck
