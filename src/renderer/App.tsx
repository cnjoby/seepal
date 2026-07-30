import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { api } from './api'
import {
  AiConfig,
  AiProtocol,
  DEFAULT_AI_BASE_URLS,
  DEFAULT_AI_MODEL,
  GROUP_LABELS,
  GROUP_ORDER,
  SESSION_TYPE_LABELS,
  SESSION_TYPES,
  type ContentPolicy,
  type ProjectDashboard,
  type ProjectInspection,
  type ProjectSummary,
  type SessionGroup,
  type SessionType,
  type SessionView,
} from './types'
import {
  ChevronIcon,
  CloseIcon,
  CommandIcon,
  FolderIcon,
  GitBranchIcon,
  PlusIcon,
  RefreshIcon,
  SettingsIcon,
  ShieldIcon,
  TrashIcon,
} from './icons'

type LoadState = 'idle' | 'loading' | 'ready' | 'error'
type GroupMode = 'status' | 'type'

function formatRelative(value?: string) {
  if (!value) return '尚未同步'
  const timestamp = new Date(value).getTime()
  if (Number.isNaN(timestamp)) return value
  const delta = Date.now() - timestamp
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  }).format(timestamp)
}

function formatDateTime(value?: string) {
  if (!value) return '没有记录'
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

function projectInitial(name: string) {
  return name.trim().slice(0, 1).toUpperCase() || 'S'
}

export function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string>()
  const [dashboard, setDashboard] = useState<ProjectDashboard>()
  const [selectedSessionId, setSelectedSessionId] = useState<string>()
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [error, setError] = useState<string>()
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false)
  const [groupMode, setGroupMode] = useState<GroupMode>('status')
  const [statusFilter, setStatusFilter] = useState<SessionGroup | 'all'>('all')
  const [typeFilter, setTypeFilter] = useState<SessionType | 'all'>('all')
  const [syncing, setSyncing] = useState(false)
  const dashboardRequestRef = useRef(0)
  const selectedProjectIdRef = useRef(selectedProjectId)
  selectedProjectIdRef.current = selectedProjectId

  const selectedProject = projects.find((project) => project.id === selectedProjectId)
  const selectedSession = dashboard?.sessions.find(
    (session) => session.id === selectedSessionId,
  )

  useEffect(() => {
    let active = true
    api
      .listProjects()
      .then((items) => {
        if (!active) return
        setProjects(items)
        const lastProject = window.localStorage.getItem('seepal:last-project')
        const initial =
          items.find((item) => item.id === lastProject)?.id ?? items[0]?.id
        setSelectedProjectId(initial)
        setLoadState('ready')
      })
      .catch((reason: unknown) => {
        if (!active) return
        setError(reason instanceof Error ? reason.message : '无法读取本地项目。')
        setLoadState('error')
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!selectedProjectId) {
      setDashboard(undefined)
      return
    }
    const requestId = ++dashboardRequestRef.current
    window.localStorage.setItem('seepal:last-project', selectedProjectId)
    let active = true
    setDashboard(undefined)
    setLoadState('loading')
    setError(undefined)
    api
      .getProjectDashboard(selectedProjectId)
      .then((nextDashboard) => {
        if (!active || requestId !== dashboardRequestRef.current) return
        setDashboard(nextDashboard)
        setLoadState('ready')
      })
      .catch((reason: unknown) => {
        if (!active || requestId !== dashboardRequestRef.current) return
        setError(reason instanceof Error ? reason.message : '无法载入项目状态。')
        setLoadState('error')
      })
    return () => {
      active = false
    }
  }, [selectedProjectId])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedSessionId(undefined)
        setOnboardingOpen(false)
        setDeleteOpen(false)
        setAiSettingsOpen(false)
      }
      if (event.metaKey && event.key.toLowerCase() === 'r') {
        event.preventDefault()
        if (onboardingOpen || deleteOpen || aiSettingsOpen) return
        void handleSync()
      }
      if (event.metaKey && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        if (onboardingOpen || deleteOpen || aiSettingsOpen) return
        setOnboardingOpen(true)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  })

  const visibleSessions = useMemo(() => {
    return (dashboard?.sessions ?? []).filter((session) => {
      const statusMatches = statusFilter === 'all' || session.group === statusFilter
      const typeMatches = typeFilter === 'all' || session.type === typeFilter
      return statusMatches && typeMatches
    })
  }, [dashboard, statusFilter, typeFilter])

  async function handleSync(policy: ContentPolicy = selectedProject?.contentPolicy ?? 'metadata') {
    if (!selectedProjectId || syncing) return
    const projectId = selectedProjectId
    const requestId = ++dashboardRequestRef.current
    setSyncing(true)
    setError(undefined)
    try {
      const nextDashboard = await api.syncCodex(projectId, policy)
      if (
        selectedProjectIdRef.current === projectId &&
        dashboardRequestRef.current === requestId
      ) {
        setDashboard(nextDashboard)
      }
      const freshProjects = await api.listProjects()
      setProjects(freshProjects)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '同步没有完成。')
    } finally {
      setSyncing(false)
    }
  }

  async function handleProjectAdded(project: ProjectSummary, policy: ContentPolicy) {
    setSyncing(true)
    try {
      const nextDashboard = await api.syncCodex(project.id, policy)
      const nextProjects = await api.listProjects()
      setProjects(nextProjects)
      setSelectedProjectId(project.id)
      setDashboard(nextDashboard)
      setOnboardingOpen(false)
    } catch (reason) {
      const nextProjects = await api.listProjects()
      setProjects(nextProjects)
      setSelectedProjectId(project.id)
      throw reason
    } finally {
      setSyncing(false)
    }
  }

  async function handleTypeChange(sessionId: string, type: SessionType) {
    if (!selectedProjectId) return
    const updated = await api.updateSessionType(selectedProjectId, sessionId, type)
    setDashboard((current) =>
      current
        ? {
            ...current,
            sessions: current.sessions.map((session) =>
              session.id === updated.id ? updated : session,
            ),
          }
        : current,
    )
  }

  async function handleProjectDeleted() {
    if (!selectedProjectId) return
    const result = await api.deleteProject(selectedProjectId)
    if (!result.success) {
      throw new Error(result.message ?? '部分本地数据没有清理完成。')
    }
    const nextProjects = await api.listProjects()
    setProjects(nextProjects)
    setSelectedProjectId(nextProjects[0]?.id)
    setSelectedSessionId(undefined)
    if (nextProjects.length === 0) {
      window.localStorage.removeItem('seepal:last-project')
    }
    setDeleteOpen(false)
  }

  return (
    <div className="app-shell">
      <ProjectRail
        projects={projects}
        selectedId={selectedProjectId}
        onSelect={(id) => {
          setSelectedSessionId(undefined)
          setSelectedProjectId(id)
        }}
        onAdd={() => setOnboardingOpen(true)}
        onAiSettings={() => setAiSettingsOpen(true)}
      />

      <main className="main-panel">
        <WindowDragBar />
        {projects.length === 0 && loadState === 'error' ? (
          <div className="empty-console">
            <InlineError
              message={error ?? 'SeePal 本地服务尚未就绪。'}
              onRetry={() => window.location.reload()}
            />
          </div>
        ) : projects.length === 0 && loadState !== 'loading' ? (
          <EmptyConsole onAdd={() => setOnboardingOpen(true)} />
        ) : (
          <>
            <ConsoleHeader
              project={selectedProject}
              coverage={dashboard?.coverage}
              syncing={syncing}
              onSync={() => void handleSync()}
              onDelete={() => setDeleteOpen(true)}
            />
            {error ? (
              <InlineError message={error} onRetry={() => void handleSync()} />
            ) : null}
            <ConsoleToolbar
              sessions={dashboard?.sessions ?? []}
              groupMode={groupMode}
              statusFilter={statusFilter}
              typeFilter={typeFilter}
              onGroupModeChange={setGroupMode}
              onStatusFilterChange={setStatusFilter}
              onTypeFilterChange={setTypeFilter}
            />
            <SessionConsole
              sessions={visibleSessions}
              groupMode={groupMode}
              loading={loadState === 'loading'}
              hasFilters={statusFilter !== 'all' || typeFilter !== 'all'}
              onSelect={(session) => setSelectedSessionId(session.id)}
              onClearFilters={() => {
                setStatusFilter('all')
                setTypeFilter('all')
              }}
            />
          </>
        )}
      </main>

      {selectedSession ? (
        <SessionDrawer
          session={selectedSession}
          onClose={() => setSelectedSessionId(undefined)}
          onTypeChange={(type) => handleTypeChange(selectedSession.id, type)}
        />
      ) : null}

      {onboardingOpen ? (
        <AddProjectDialog
          projects={projects}
          onClose={() => setOnboardingOpen(false)}
          onAdded={handleProjectAdded}
        />
      ) : null}

      {deleteOpen && selectedProject ? (
        <DeleteProjectDialog
          project={selectedProject}
          onClose={() => setDeleteOpen(false)}
          onConfirm={handleProjectDeleted}
        />
      ) : null}

      {aiSettingsOpen ? (
        <AiSettingsDialog onClose={() => setAiSettingsOpen(false)} />
      ) : null}
    </div>
  )
}

function WindowDragBar() {
  return (
    <div className="window-drag-bar" aria-hidden="true">
      <div className="traffic-lights">
        <span />
        <span />
        <span />
      </div>
      <div className="drag-title">SEEPAL / PROJECT CONSOLE</div>
    </div>
  )
}

function ProjectRail({
  projects,
  selectedId,
  onSelect,
  onAdd,
  onAiSettings,
}: {
  projects: ProjectSummary[]
  selectedId?: string
  onSelect: (id: string) => void
  onAdd: () => void
  onAiSettings: () => void
}) {
  return (
    <aside className="project-rail" aria-label="项目">
      <div className="brand-mark" aria-label="SeePal">
        <span className="brand-lens" />
        <span className="brand-dot" />
      </div>
      <div className="project-stack">
        {projects.map((project) => (
          <button
            className={`project-tile ${project.id === selectedId ? 'is-selected' : ''}`}
            key={project.id}
            onClick={() => onSelect(project.id)}
            aria-label={`${project.name}，${project.attentionCount} 个需要处理`}
            title={project.name}
          >
            <span className="project-initial">{projectInitial(project.name)}</span>
            {project.attentionCount > 0 ? (
              <span className="project-count">{project.attentionCount}</span>
            ) : null}
          </button>
        ))}
      </div>
      <button className="rail-add" onClick={onAdd} aria-label="添加项目" title="添加项目 ⌘N">
        <PlusIcon />
      </button>
      <button
        className="rail-settings"
        onClick={onAiSettings}
        aria-label="AI 设置"
        title="AI 设置"
      >
        <SettingsIcon />
      </button>
    </aside>
  )
}

function EmptyConsole({ onAdd }: { onAdd: () => void }) {
  return (
    <section className="empty-console">
      <div className="empty-orbit" aria-hidden="true">
        <span className="orbit-line" />
        <span className="orbit-node orbit-node-one" />
        <span className="orbit-node orbit-node-two" />
        <span className="orbit-node orbit-node-three" />
      </div>
      <p className="eyebrow">LOCAL PROJECT CONSOLE</p>
      <h1>把散落的 AI 会话，<br />收回一个清晰现场。</h1>
      <p className="empty-copy">
        选择一个本地 Git 项目。SeePal 会先说明读取范围，再汇总 Codex
        Session、改动和 Worktree 状态。无需账号，数据留在这台 Mac。
      </p>
      <button className="primary-button" onClick={onAdd}>
        <FolderIcon />
        添加第一个项目
      </button>
      <div className="privacy-note">
        <ShieldIcon />
        <span>默认只读 · 离线可查看 · 随时删除 SeePal 副本</span>
      </div>
    </section>
  )
}

function ConsoleHeader({
  project,
  coverage,
  syncing,
  onSync,
  onDelete,
}: {
  project?: ProjectSummary
  coverage?: ProjectDashboard['coverage']
  syncing: boolean
  onSync: () => void
  onDelete: () => void
}) {
  return (
    <header className="console-header">
      <div className="project-heading">
        <p className="breadcrumb">项目 / {project?.path ?? '正在读取'}</p>
        <div className="title-line">
          <h1>{project?.name ?? 'Project Console'}</h1>
          {coverage ? (
            <span className={`source-pill source-${coverage.status}`}>
              <span className="source-dot" />
              {coverage.status === 'syncing'
                ? coverage.stage ?? '同步中'
                : coverage.status === 'complete'
                  ? '数据已同步'
                  : coverage.status === 'partial'
                    ? '部分数据'
                    : coverage.status === 'failed'
                      ? '同步失败'
                      : '尚未连接'}
            </span>
          ) : null}
        </div>
        <p className="coverage-copy">
          {coverage
            ? [
                coverage.sessionCount
                  ? `${coverage.sessionCount} 个 Session · 数据截至 ${formatDateTime(coverage.to ?? coverage.lastSuccessfulAt)}`
                  : undefined,
                coverage.status === 'partial' || coverage.status === 'failed'
                  ? coverage.message
                  : undefined,
                coverage.affectedScope,
              ]
                .filter(Boolean)
                .join(' · ') || '正在建立项目状态视图…'
            : '正在建立项目状态视图…'}
        </p>
      </div>
      <div className="header-actions">
        <button className="quiet-button danger-on-hover" onClick={onDelete}>
          <TrashIcon />
          删除
        </button>
        <button className="secondary-button" onClick={onSync} disabled={syncing}>
          <RefreshIcon className={syncing ? 'is-spinning' : undefined} />
          {syncing ? '正在同步' : '同步'}
          <kbd>⌘R</kbd>
        </button>
      </div>
    </header>
  )
}

function InlineError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="inline-error" role="alert">
      <span className="error-indicator" />
      <div>
        <strong>当前状态可能不完整</strong>
        <p>{message}</p>
      </div>
      <button className="text-button" onClick={onRetry}>
        再试一次
      </button>
    </div>
  )
}

function ConsoleToolbar({
  sessions,
  groupMode,
  statusFilter,
  typeFilter,
  onGroupModeChange,
  onStatusFilterChange,
  onTypeFilterChange,
}: {
  sessions: SessionView[]
  groupMode: GroupMode
  statusFilter: SessionGroup | 'all'
  typeFilter: SessionType | 'all'
  onGroupModeChange: (value: GroupMode) => void
  onStatusFilterChange: (value: SessionGroup | 'all') => void
  onTypeFilterChange: (value: SessionType | 'all') => void
}) {
  const attention = sessions.filter((session) => session.group === 'needs-attention').length
  const active = sessions.filter((session) => session.group === 'ai-working').length
  const unclear = sessions.filter((session) => session.group === 'unknown').length

  return (
    <div className="console-toolbar">
      <div className="console-summary" aria-label="Session 摘要">
        <div className="summary-item summary-attention">
          <strong>{attention}</strong>
          <span>需要处理</span>
        </div>
        <div className="summary-divider" />
        <div className="summary-item">
          <strong>{active}</strong>
          <span>正在工作</span>
        </div>
        <div className="summary-divider" />
        <div className="summary-item">
          <strong>{unclear}</strong>
          <span>状态不明</span>
        </div>
      </div>
      <div className="filter-row">
        <div className="segmented-control" aria-label="分组方式">
          <button
            className={groupMode === 'status' ? 'is-active' : undefined}
            onClick={() => onGroupModeChange('status')}
          >
            按状态
          </button>
          <button
            className={groupMode === 'type' ? 'is-active' : undefined}
            onClick={() => onGroupModeChange('type')}
          >
            按类型
          </button>
        </div>
        <label className="select-control">
          <span className="sr-only">状态筛选</span>
          <select
            value={statusFilter}
            onChange={(event) =>
              onStatusFilterChange(event.target.value as SessionGroup | 'all')
            }
          >
            <option value="all">全部状态</option>
            {GROUP_ORDER.map((group) => (
              <option key={group} value={group}>
                {GROUP_LABELS[group]}
              </option>
            ))}
          </select>
        </label>
        <label className="select-control">
          <span className="sr-only">类型筛选</span>
          <select
            value={typeFilter}
            onChange={(event) =>
              onTypeFilterChange(event.target.value as SessionType | 'all')
            }
          >
            <option value="all">全部类型</option>
            {SESSION_TYPES.map((type) => (
              <option key={type} value={type}>
                {SESSION_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}

function SessionConsole({
  sessions,
  groupMode,
  loading,
  hasFilters,
  onSelect,
  onClearFilters,
}: {
  sessions: SessionView[]
  groupMode: GroupMode
  loading: boolean
  hasFilters: boolean
  onSelect: (session: SessionView) => void
  onClearFilters: () => void
}) {
  if (loading) {
    return (
      <div className="session-list loading-list" aria-label="正在载入 Session">
        {[0, 1, 2].map((item) => (
          <div className="session-skeleton" key={item}>
            <span />
            <span />
            <span />
          </div>
        ))}
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="list-empty">
        <span className="list-empty-mark">0</span>
        <h2>{hasFilters ? '没有符合当前条件的 Session' : '这里还没有 Session'}</h2>
        <p>
          {hasFilters
            ? '换一个状态或类型查看，已有数据不会被隐藏或删除。'
            : '完成一次 Codex 同步后，历史会话会按状态出现在这里。'}
        </p>
        {hasFilters ? (
          <button className="text-button" onClick={onClearFilters}>
            清除筛选
          </button>
        ) : null}
      </div>
    )
  }

  const keys =
    groupMode === 'status'
      ? GROUP_ORDER
      : SESSION_TYPES

  return (
    <div className="session-list">
      {keys.map((key) => {
        const groupSessions = sessions.filter((session) =>
          groupMode === 'status' ? session.group === key : session.type === key,
        )
        if (groupSessions.length === 0) return null
        return (
          <section className="session-group" key={key}>
            <header className="group-header">
              <h2>
                {groupMode === 'status'
                  ? GROUP_LABELS[key as SessionGroup]
                  : SESSION_TYPE_LABELS[key as SessionType]}
              </h2>
              <span>{groupSessions.length}</span>
              <div className="header-rule" />
            </header>
            <div className="group-rows">
              {groupSessions.map((session) => (
                <SessionRow key={session.id} session={session} onSelect={onSelect} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function SessionRow({
  session,
  onSelect,
}: {
  session: SessionView
  onSelect: (session: SessionView) => void
}) {
  return (
    <button className="session-row" onClick={() => onSelect(session)}>
      <div className={`row-status status-${session.group}`} aria-hidden="true" />
      <div className="session-identity">
        <div className="session-title-line">
          <span className="provider-label">{session.provider || 'Codex'}</span>
          <h3>{session.title || '未命名 Session'}</h3>
        </div>
        <div className="session-meta">
          <span className={`type-chip type-${session.type}`}>
            {SESSION_TYPE_LABELS[session.type]}
          </span>
          {session.branch ? (
            <span className="branch-label">
              <GitBranchIcon />
              {session.branch}
            </span>
          ) : null}
          {session.worktree ? <span className="worktree-label">{session.worktree}</span> : null}
        </div>
      </div>
      <MiniEvidenceSpine session={session} />
      <div className="session-action">
        <span className="session-status">{session.status}</span>
        <strong>{session.nextAction || '当前无需处理'}</strong>
        <small>{formatRelative(session.lastActivityAt)}</small>
      </div>
      <ChevronIcon className="row-chevron" />
    </button>
  )
}

function MiniEvidenceSpine({ session }: { session: SessionView }) {
  const axes = session.evidence.slice(0, 6)
  return (
    <div className="mini-spine" aria-label="状态证据概览">
      <div className="mini-spine-line" />
      {axes.map((axis) => (
        <span
          className={`mini-node node-${axis.tone}`}
          key={axis.key}
          title={`${axis.label}：${axis.status}`}
        />
      ))}
    </div>
  )
}

function SessionDrawer({
  session,
  onClose,
  onTypeChange,
}: {
  session: SessionView
  onClose: () => void
  onTypeChange: (type: SessionType) => Promise<void>
}) {
  const drawerRef = useRef<HTMLElement>(null)
  const [editingType, setEditingType] = useState(false)
  const [pendingType, setPendingType] = useState(session.type)
  const [savingType, setSavingType] = useState(false)
  const [typeError, setTypeError] = useState<string>()

  useEffect(() => {
    drawerRef.current?.focus()
  }, [])

  useEffect(() => setPendingType(session.type), [session.type])

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside
        className="session-drawer"
        ref={drawerRef}
        tabIndex={-1}
        aria-label={`${session.title} 详情`}
      >
        <header className="drawer-header">
          <div>
            <p className="eyebrow">{session.provider || 'CODEX'} / SESSION</p>
            <h2>{session.title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭详情">
            <CloseIcon />
          </button>
        </header>

        <div className="drawer-summary">
          <div className={`drawer-status-mark status-${session.group}`}>
            <span />
          </div>
          <div>
            <span>当前判断</span>
            <strong>{session.status}</strong>
            <p>{session.nextAction || '当前没有需要你处理的动作。'}</p>
          </div>
        </div>

        <section className="type-section">
          <div className="section-heading">
            <div>
              <span>主要类型</span>
              <strong>{SESSION_TYPE_LABELS[session.type]}</strong>
            </div>
            <button className="text-button" onClick={() => setEditingType((value) => !value)}>
              {editingType ? '取消' : '修正类型'}
            </button>
          </div>
          {editingType ? (
            <div className="type-editor">
              <label>
                <span>这次 Session 主要在做什么？</span>
                <select
                  value={pendingType}
                  onChange={(event) => setPendingType(event.target.value as SessionType)}
                >
                  {SESSION_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {SESSION_TYPE_LABELS[type]}
                    </option>
                  ))}
                </select>
              </label>
              <p>
                修改后，适用的状态解释会重新计算。系统原判断仍会保留。
              </p>
              <button
                className="primary-button compact"
                disabled={savingType}
                onClick={async () => {
                  setSavingType(true)
                  setTypeError(undefined)
                  try {
                    await onTypeChange(pendingType)
                    setEditingType(false)
                  } catch (reason) {
                    setTypeError(
                      reason instanceof Error ? reason.message : '类型没有保存成功。',
                    )
                  } finally {
                    setSavingType(false)
                  }
                }}
              >
                {savingType ? '正在保存…' : '保存类型'}
              </button>
              {typeError ? <p className="modal-error" role="alert">{typeError}</p> : null}
            </div>
          ) : (
            <div className="type-reason">
              <div className="confidence-track" aria-hidden="true">
                <span
                  style={{
                    width: `${Math.round((session.typeConfidence ?? 0) * 100)}%`,
                  }}
                />
              </div>
              <p>
                {session.typeReason ??
                  (session.type === 'unknown'
                    ? '现有信息不足，SeePal 没有强行分类。'
                    : '根据 Session 目标与本地活动判断。')}
              </p>
              {session.suggestedType && session.suggestedType !== session.type ? (
                <span className="history-note">
                  系统曾建议：{SESSION_TYPE_LABELS[session.suggestedType]}
                </span>
              ) : null}
            </div>
          )}
        </section>

        <section className="evidence-section">
          <div className="section-heading">
            <div>
              <span>状态依据</span>
              <strong>六条独立状态</strong>
            </div>
            <small>数据截至 {formatRelative(session.lastActivityAt)}</small>
          </div>
          <div className="evidence-spine">
            {session.evidence.map((axis, index) => (
              <article className="evidence-node" key={axis.key}>
                <div className="spine-rail" aria-hidden="true">
                  <span className={`spine-dot node-${axis.tone}`} />
                  {index < session.evidence.length - 1 ? <span className="spine-line" /> : null}
                </div>
                <div className="evidence-content">
                  <div className="evidence-title">
                    <span>{axis.label}</span>
                    <strong>{axis.status}</strong>
                    {axis.relation ? (
                      <em className={`relation-badge relation-${axis.relation}`}>
                        {axis.relation === 'candidate'
                          ? '候选关系'
                          : axis.relation === 'conflicting'
                            ? '证据冲突'
                            : '已确认'}
                      </em>
                    ) : null}
                  </div>
                  <p>{axis.summary}</p>
                  <dl className="evidence-meta">
                    <div>
                      <dt>来源</dt>
                      <dd>{axis.source ?? '未提供'}</dd>
                    </div>
                    <div>
                      <dt>发生</dt>
                      <dd>{formatDateTime(axis.occurredAt)}</dd>
                    </div>
                    <div>
                      <dt>采集</dt>
                      <dd>{formatDateTime(axis.collectedAt)}</dd>
                    </div>
                    <div>
                      <dt>新鲜度</dt>
                      <dd className={`freshness-${axis.freshness ?? 'unknown'}`}>
                        {axis.freshness === 'fresh'
                          ? '当前'
                          : axis.freshness === 'stale'
                            ? '可能过期'
                            : '无法确认'}
                      </dd>
                    </div>
                  </dl>
                </div>
              </article>
            ))}
          </div>
        </section>
      </aside>
    </>
  )
}

function AddProjectDialog({
  projects,
  onClose,
  onAdded,
}: {
  projects: ProjectSummary[]
  onClose: () => void
  onAdded: (project: ProjectSummary, policy: ContentPolicy) => void
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [inspection, setInspection] = useState<ProjectInspection>()
  const [policy, setPolicy] = useState<ContentPolicy>('metadata')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => dialogRef.current?.focus(), [])

  async function chooseProject() {
    setBusy(true)
    setError(undefined)
    try {
      const path = await api.selectDirectory()
      if (!path) return
      const result = await api.inspectProject(path)
      setInspection(result)
      if (!result.valid) {
        setError(result.reason ?? '这个目录不是可接入的 Git 项目。')
        return
      }
      const duplicate = result.duplicateProjectId ?? projects.find((item) => item.path === path)?.id
      if (duplicate) {
        setError('这个项目已经在 SeePal 中，请从左侧项目栏打开。')
        return
      }
      setStep(2)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法检查这个目录。')
    } finally {
      setBusy(false)
    }
  }

  async function confirmAdd() {
    if (!inspection) return
    setBusy(true)
    setError(undefined)
    try {
      const project = await api.addProject({
        path: inspection.path,
        confirmedRepositoryRoot: inspection.repositoryRoot ?? inspection.path,
        contentPolicy: policy,
      })
      setStep(3)
      await onAdded(project, policy)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '项目没有添加成功。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div
        className="modal add-project-modal"
        role="dialog"
        aria-modal="true"
        aria-label="添加本地项目"
        tabIndex={-1}
        ref={dialogRef}
      >
        <header className="modal-header">
          <div>
            <p className="eyebrow">ADD LOCAL PROJECT</p>
            <h2>
              {step === 1
                ? '选择一个真实项目'
                : step === 2
                  ? '确认读取边界'
                  : '正在建立 Console'}
            </h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="取消添加项目">
            <CloseIcon />
          </button>
        </header>

        <div className="step-indicator" aria-label={`第 ${step} 步，共 3 步`}>
          {[1, 2, 3].map((value) => (
            <span
              key={value}
              className={value === step ? 'is-current' : value < step ? 'is-complete' : ''}
            />
          ))}
        </div>

        {step === 1 ? (
          <div className="step-content choose-step">
            <div className="scope-illustration" aria-hidden="true">
              <FolderIcon />
              <span className="scope-line" />
              <span className="scope-node">Git</span>
              <span className="scope-node">Codex</span>
            </div>
            <h3>从一个本地 Git 仓库开始</h3>
            <p>
              选择后，SeePal 只会检查项目结构。你确认范围之前，不会读取 Codex
              会话内容，也不会留下项目记录。
            </p>
            <button className="primary-button" onClick={() => void chooseProject()} disabled={busy}>
              <FolderIcon />
              {busy ? '正在检查…' : '选择项目文件夹'}
            </button>
          </div>
        ) : null}

        {step === 2 && inspection ? (
          <div className="step-content scope-step">
            <div className="selected-path">
              <FolderIcon />
              <div>
                <strong>{inspection.name}</strong>
                <span>{inspection.repositoryRoot ?? inspection.path}</span>
              </div>
            </div>

            <div className="scope-grid">
              <ScopeCard
                label="仓库"
                value="只读 Git 状态"
                detail={`${inspection.worktrees?.length ?? 1} 个 Worktree 纳入范围`}
                included
              />
              <ScopeCard
                label="Codex"
                value={
                  inspection.codex?.status === 'found'
                    ? `发现 ${inspection.codex.sessionCount ?? 0} 个候选 Session`
                    : '尚未确认可用历史'
                }
                detail={inspection.codex?.attributionBasis ?? '按项目路径与工作目录判断归属'}
                included={inspection.codex?.status === 'found'}
              />
              {(inspection.submodules ?? []).map((item) => (
                <ScopeCard
                  key={item.path}
                  label="子模块"
                  value={item.path}
                  detail={item.included ? '纳入只读扫描' : '不在本次范围'}
                  included={item.included}
                />
              ))}
              {(inspection.linkedPaths ?? []).map((item) => (
                <ScopeCard
                  key={item.path}
                  label="链接路径"
                  value={item.path}
                  detail={item.included ? '纳入只读扫描' : '不会自动扩大范围'}
                  included={item.included}
                />
              ))}
            </div>

            <fieldset className="policy-options">
              <legend>Codex 内容策略</legend>
              <label className={policy === 'metadata' ? 'is-selected' : ''}>
                <input
                  type="radio"
                  name="policy"
                  checked={policy === 'metadata'}
                  onChange={() => setPolicy('metadata')}
                />
                <span className="radio-mark" />
                <span>
                  <strong>仅使用最小信息</strong>
                  <small>标题、时间、状态和项目归属。隐私优先，部分类型判断可能不完整。</small>
                </span>
              </label>
              <label className={policy === 'full-local' ? 'is-selected' : ''}>
                <input
                  type="radio"
                  name="policy"
                  checked={policy === 'full-local'}
                  onChange={() => setPolicy('full-local')}
                />
                <span className="radio-mark" />
                <span>
                  <strong>允许在本机读取完整内容</strong>
                  <small>帮助判断目标和类型。原文只在本机处理，不启用远端增强。</small>
                </span>
              </label>
            </fieldset>

            <div className="modal-actions">
              <button className="quiet-button" onClick={() => setStep(1)}>
                重新选择
              </button>
              <button
                className="primary-button"
                onClick={() => void confirmAdd()}
                disabled={busy}
              >
                <ShieldIcon />
                {busy ? '正在添加…' : '确认并开始同步'}
              </button>
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="step-content syncing-step">
            <div className="sync-rings" aria-hidden="true">
              <span />
              <span />
              <CommandIcon />
            </div>
            <h3>正在整理历史 Session</h3>
            <p>已添加项目。你可以关闭此窗口，Console 会保留同步进度和已读取的数据。</p>
          </div>
        ) : null}

        {error ? (
          <div className="modal-error" role="alert">
            <span />
            {error}
          </div>
        ) : null}
        <footer className="modal-footnote">
          <ShieldIcon />
          SeePal 不会修改源码、Git 对象、Branch、Worktree 或 Provider Session。
        </footer>
      </div>
    </div>
  )
}

function ScopeCard({
  label,
  value,
  detail,
  included,
}: {
  label: string
  value: string
  detail: string
  included: boolean
}) {
  return (
    <div className="scope-card">
      <span className={included ? 'scope-included' : 'scope-excluded'}>
        {included ? '纳入' : '不纳入'}
      </span>
      <small>{label}</small>
      <strong>{value}</strong>
      <p>{detail}</p>
    </div>
  )
}

function DeleteProjectDialog({
  project,
  onClose,
  onConfirm,
}: {
  project: ProjectSummary
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  const [confirmName, setConfirmName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function remove() {
    setBusy(true)
    setError(undefined)
    try {
      await onConfirm()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '项目没有完全删除。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal delete-modal" role="alertdialog" aria-modal="true">
        <div className="delete-icon">
          <TrashIcon />
        </div>
        <h2>删除 SeePal 中的「{project.name}」？</h2>
        <p>
          将清理 SeePal 保存的项目记录、索引、派生状态、提醒、缓存和相关日志。
        </p>
        <ul>
          <li>不会删除 Codex Session</li>
          <li>不会修改源码、Git 历史、Branch 或 Worktree</li>
          <li>原始需求与文档保持不变</li>
        </ul>
        <label className="confirm-field">
          <span>输入项目名以确认</span>
          <input
            autoFocus
            value={confirmName}
            onChange={(event) => setConfirmName(event.target.value)}
            placeholder={project.name}
          />
        </label>
        {error ? <div className="modal-error">{error}</div> : null}
        <div className="modal-actions">
          <button className="quiet-button" onClick={onClose}>
            保留项目
          </button>
          <button
            className="danger-button"
            disabled={confirmName !== project.name || busy}
            onClick={() => void remove()}
          >
            {busy ? '正在清理…' : '删除 SeePal 副本'}
          </button>
        </div>
      </div>
    </div>
  )
}

const DEFAULT_AI_CONFIG: AiConfig = {
  protocol: 'openai',
  baseUrl: DEFAULT_AI_BASE_URLS.openai,
  model: DEFAULT_AI_MODEL,
  hasApiKey: false,
}

function AiSettingsDialog({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<AiConfig>(DEFAULT_AI_CONFIG)
  const [apiKey, setApiKey] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{
    tone: 'success' | 'error'
    message: string
  }>()
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    let active = true
    api
      .getAiConfig()
      .then((stored) => {
        if (!active) return
        setConfig(stored)
        if (stored.loadError) {
          setFeedback({ tone: 'error', message: stored.loadError })
        }
      })
      .catch((reason: unknown) => {
        if (!active) return
        setFeedback({
          tone: 'error',
          message:
            reason instanceof Error ? reason.message : '无法读取 AI 配置。',
        })
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      previouslyFocused?.focus()
    }
  }, [])

  function trapFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab') return
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled])',
      ) ?? [],
    )
    if (focusable.length === 0) {
      event.preventDefault()
      dialogRef.current?.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  async function save(): Promise<AiConfig | undefined> {
    setBusy(true)
    setFeedback(undefined)
    try {
      const normalizedApiKey = apiKey.trim()
      const saved = await api.saveAiConfig({
        protocol: config.protocol,
        baseUrl: config.baseUrl,
        model: config.model,
        ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
      })
      setConfig(saved)
      setApiKey('')
      setFeedback({ tone: 'success', message: 'AI 配置已安全保存。' })
      return saved
    } catch (reason) {
      setFeedback({
        tone: 'error',
        message: reason instanceof Error ? reason.message : 'AI 配置没有保存。',
      })
      return undefined
    } finally {
      setBusy(false)
    }
  }

  async function testConnection() {
    const saved = await save()
    if (!saved?.hasApiKey) {
      setFeedback({ tone: 'error', message: '请先输入并保存 API Key。' })
      return
    }
    setBusy(true)
    setFeedback(undefined)
    try {
      const result = await api.testAiConnection()
      setFeedback({
        tone: result.ok ? 'success' : 'error',
        message: result.ok
          ? `${result.message} 模型：${result.model ?? saved.model} · ${result.latencyMs ?? 0} ms`
          : result.message,
      })
    } catch (reason) {
      setFeedback({
        tone: 'error',
        message:
          reason instanceof Error ? reason.message : '连接测试没有完成。',
      })
    } finally {
      setBusy(false)
    }
  }

  async function clearApiKey() {
    if (!config.hasApiKey) {
      setApiKey('')
      setFeedback({ tone: 'success', message: '已清空尚未保存的 API Key。' })
      return
    }
    setBusy(true)
    setFeedback(undefined)
    try {
      const cleared = await api.clearAiApiKey()
      setConfig((current) => ({
        ...current,
        hasApiKey: false,
        loadError: cleared.loadError,
      }))
      setApiKey('')
      setFeedback({ tone: 'success', message: '已清除保存的 API Key。' })
    } catch (reason) {
      setFeedback({
        tone: 'error',
        message:
          reason instanceof Error ? reason.message : 'API Key 没有清除。',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div
        className="modal ai-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="AI 设置"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={trapFocus}
      >
        <header className="modal-header">
          <div>
            <p className="eyebrow">GLOBAL AI CONNECTOR</p>
            <h2>配置模型接口</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭 AI 设置">
            <CloseIcon />
          </button>
        </header>

        <p className="ai-settings-intro">
          配置仅保存在这台 Mac。只有点击“测试连接”或后续明确启用 Session
          解读时，内容才会发送到模型服务。
        </p>

        <div className="ai-example-box">
          <span>默认示例</span>
          <code>OpenAI · https://api.deepseek.com</code>
          <code>Anthropic · https://api.deepseek.com/anthropic</code>
          <code>Model · deepseek-v4-flash</code>
        </div>

        <div className="ai-settings-form" aria-busy={loading}>
          <label>
            <span>兼容协议</span>
            <select
              value={config.protocol}
              disabled={loading || busy}
              onChange={(event) => {
                const protocol = event.target.value as AiProtocol
                setConfig((current) => ({
                  ...current,
                  protocol,
                  baseUrl: DEFAULT_AI_BASE_URLS[protocol],
                }))
              }}
            >
              <option value="openai">OpenAI-compatible</option>
              <option value="anthropic">Anthropic-compatible</option>
            </select>
          </label>
          <label>
            <span>Base URL</span>
            <input
              value={config.baseUrl}
              disabled={loading || busy}
              onChange={(event) =>
                setConfig((current) => ({
                  ...current,
                  baseUrl: event.target.value,
                }))
              }
            />
          </label>
          <label>
            <span>Model</span>
            <input
              value={config.model}
              disabled={loading || busy}
              onChange={(event) =>
                setConfig((current) => ({
                  ...current,
                  model: event.target.value,
                }))
              }
            />
          </label>
          <label>
            <span>
              API Key
              {config.hasApiKey ? <em>已保存密钥</em> : null}
            </span>
            <input
              type="password"
              value={apiKey}
              autoComplete="off"
              placeholder="sk-your-api-key"
              disabled={loading || busy}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <small>
              留空会保留已保存的密钥；明文不会返回到界面。
            </small>
          </label>
        </div>

        {feedback ? (
          <div
            className={`ai-feedback ai-feedback-${feedback.tone}`}
            role={feedback.tone === 'error' ? 'alert' : 'status'}
          >
            {feedback.message}
          </div>
        ) : null}

        <div className="ai-settings-actions">
          <button
            className="quiet-button danger-on-hover"
            disabled={busy || (!config.hasApiKey && !apiKey)}
            onClick={() => void clearApiKey()}
          >
            清除密钥
          </button>
          <div>
            <button
              className="secondary-button"
              disabled={loading || busy}
              onClick={() => void save()}
            >
              保存配置
            </button>
            <button
              className="primary-button"
              disabled={loading || busy}
              onClick={() => void testConnection()}
            >
              {busy ? '正在处理…' : '测试连接'}
            </button>
          </div>
        </div>

        <footer className="modal-footnote">
          <ShieldIcon />
          API Key 通过 macOS 安全存储加密；已保存的明文不会返回 Renderer。
        </footer>
      </div>
    </div>
  )
}
