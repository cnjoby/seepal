import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

import {
  type CoverageWindow,
  type DeleteProjectResult,
  type Evidence,
  type Project,
  type SessionRecord,
  type SessionType,
  type SyncFailure,
  type TypeCorrection
} from '../shared/domain.js'

interface SessionRow {
  id: string
  project_id: string
  provider: 'codex'
  provider_session_id: string
  title: string
  cwd: string
  created_at: string
  updated_at: string
  last_activity_at: string
  activity_status: SessionRecord['activityStatus']
  suggested_type: SessionType
  suggested_type_confidence: number
  suggested_type_basis_json: string
  primary_type: SessionType
  branch: string | null
  worktree_path: string | null
  source_base_commit: string | null
  content_strategy: SessionRecord['contentStrategy']
  content_preview: string | null
  source_version: string | null
  is_partial: number
  collected_at: string
  user_type: SessionType | null
}

interface ProjectRow {
  id: string
  name: string
  root_path: string
  canonical_root_path: string
  content_strategy: Project['contentStrategy']
  created_at: string
  updated_at: string
  last_successful_sync_at: string | null
  sync_status: Project['syncStatus']
  coverage_json: string | null
  sync_message: string | null
}

function optionalJson<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined
  return JSON.parse(value) as T
}

function projectFromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    canonicalRootPath: row.canonical_root_path,
    contentStrategy: row.content_strategy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSuccessfulSyncAt: row.last_successful_sync_at ?? undefined,
    syncStatus: row.sync_status,
    coverage: optionalJson<CoverageWindow>(row.coverage_json),
    syncMessage: row.sync_message ?? undefined
  }
}

function sessionFromRow(row: SessionRow): SessionRecord {
  const userType = row.user_type ?? undefined
  return {
    id: row.id,
    projectId: row.project_id,
    provider: row.provider,
    providerSessionId: row.provider_session_id,
    title: row.title,
    cwd: row.cwd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    activityStatus: row.activity_status,
    suggestedType: row.suggested_type,
    suggestedTypeConfidence: row.suggested_type_confidence,
    suggestedTypeBasis: JSON.parse(row.suggested_type_basis_json) as string[],
    userType,
    primaryType: userType ?? row.primary_type,
    branch: row.branch ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
    sourceBaseCommit: row.source_base_commit ?? undefined,
    contentStrategy: row.content_strategy,
    contentPreview: row.content_preview ?? undefined,
    sourceVersion: row.source_version ?? undefined,
    isPartial: row.is_partial === 1,
    collectedAt: row.collected_at
  }
}

export class SeePalDatabase {
  readonly connection: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.connection = new DatabaseSync(path)
    this.connection.exec('PRAGMA foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        canonical_root_path TEXT NOT NULL UNIQUE,
        content_strategy TEXT NOT NULL CHECK(content_strategy IN ('minimal', 'full-local')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_successful_sync_at TEXT,
        sync_status TEXT NOT NULL CHECK(sync_status IN ('never', 'syncing', 'complete', 'partial', 'failed')),
        coverage_json TEXT,
        sync_message TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK(provider = 'codex'),
        provider_session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        cwd TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        activity_status TEXT NOT NULL,
        suggested_type TEXT NOT NULL,
        suggested_type_confidence REAL NOT NULL,
        suggested_type_basis_json TEXT NOT NULL,
        primary_type TEXT NOT NULL,
        branch TEXT,
        worktree_path TEXT,
        source_base_commit TEXT,
        content_strategy TEXT NOT NULL,
        content_preview TEXT,
        source_version TEXT,
        is_partial INTEGER NOT NULL CHECK(is_partial IN (0, 1)),
        collected_at TEXT NOT NULL,
        UNIQUE(project_id, provider, provider_session_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS sessions_by_project
        ON sessions(project_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        axis TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        source TEXT NOT NULL,
        source_ref TEXT,
        occurred_at TEXT,
        collected_at TEXT NOT NULL,
        confidence TEXT NOT NULL,
        details_json TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS evidence_by_session
        ON evidence(project_id, session_id, axis, collected_at DESC);

      CREATE TABLE IF NOT EXISTS session_type_corrections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        session_type TEXT NOT NULL,
        corrected_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS type_corrections_by_session
        ON session_type_corrections(project_id, session_id, id DESC);

      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL,
        coverage_json TEXT,
        failures_json TEXT NOT NULL
      ) STRICT;
    `)
  }

  close(): void {
    this.connection.close()
  }

  createProject(project: Project): Project {
    this.connection
      .prepare(
        `INSERT INTO projects (
          id, name, root_path, canonical_root_path, content_strategy, created_at, updated_at,
          last_successful_sync_at, sync_status, coverage_json, sync_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        project.id,
        project.name,
        project.rootPath,
        project.canonicalRootPath,
        project.contentStrategy,
        project.createdAt,
        project.updatedAt,
        project.lastSuccessfulSyncAt ?? null,
        project.syncStatus,
        project.coverage ? JSON.stringify(project.coverage) : null,
        project.syncMessage ?? null
      )
    return project
  }

  updateProject(project: Project): Project {
    const result = this.connection
      .prepare(
        `UPDATE projects SET
          name = ?, root_path = ?, content_strategy = ?, updated_at = ?,
          last_successful_sync_at = ?, sync_status = ?, coverage_json = ?, sync_message = ?
        WHERE id = ?`
      )
      .run(
        project.name,
        project.rootPath,
        project.contentStrategy,
        project.updatedAt,
        project.lastSuccessfulSyncAt ?? null,
        project.syncStatus,
        project.coverage ? JSON.stringify(project.coverage) : null,
        project.syncMessage ?? null,
        project.id
      )
    if (result.changes !== 1) throw new Error('Project not found')
    return project
  }

  getProject(id: string): Project | undefined {
    const row = this.connection
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as unknown as ProjectRow | undefined
    return row ? projectFromRow(row) : undefined
  }

  getProjectByCanonicalPath(canonicalRootPath: string): Project | undefined {
    const row = this.connection
      .prepare('SELECT * FROM projects WHERE canonical_root_path = ?')
      .get(canonicalRootPath) as unknown as ProjectRow | undefined
    return row ? projectFromRow(row) : undefined
  }

  listProjects(): Project[] {
    const rows = this.connection
      .prepare('SELECT * FROM projects ORDER BY created_at ASC, id ASC')
      .all() as unknown as ProjectRow[]
    return rows.map(projectFromRow)
  }

  markInterruptedSyncsFailed(updatedAt: string): number {
    const result = this.connection
      .prepare(
        `UPDATE projects
         SET sync_status = 'failed',
             sync_message = '上次同步被中断，请重新同步。',
             updated_at = ?
         WHERE sync_status = 'syncing'`
      )
      .run(updatedAt)
    return Number(result.changes)
  }

  upsertSession(session: SessionRecord): SessionRecord {
    this.connection
      .prepare(
        `INSERT INTO sessions (
          id, project_id, provider, provider_session_id, title, cwd, created_at, updated_at,
          last_activity_at, activity_status, suggested_type, suggested_type_confidence,
          suggested_type_basis_json, primary_type, branch, worktree_path, source_base_commit, content_strategy,
          content_preview, source_version, is_partial, collected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, provider, provider_session_id) DO UPDATE SET
          title = excluded.title,
          cwd = excluded.cwd,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          last_activity_at = excluded.last_activity_at,
          activity_status = excluded.activity_status,
          suggested_type = excluded.suggested_type,
          suggested_type_confidence = excluded.suggested_type_confidence,
          suggested_type_basis_json = excluded.suggested_type_basis_json,
          primary_type = excluded.primary_type,
          branch = excluded.branch,
          worktree_path = excluded.worktree_path,
          source_base_commit = excluded.source_base_commit,
          content_strategy = excluded.content_strategy,
          content_preview = excluded.content_preview,
          source_version = excluded.source_version,
          is_partial = excluded.is_partial,
          collected_at = excluded.collected_at`
      )
      .run(
        session.id,
        session.projectId,
        session.provider,
        session.providerSessionId,
        session.title,
        session.cwd,
        session.createdAt,
        session.updatedAt,
        session.lastActivityAt,
        session.activityStatus,
        session.suggestedType,
        session.suggestedTypeConfidence,
        JSON.stringify(session.suggestedTypeBasis),
        session.primaryType,
        session.branch ?? null,
        session.worktreePath ?? null,
        session.sourceBaseCommit ?? null,
        session.contentStrategy,
        session.contentPreview ?? null,
        session.sourceVersion ?? null,
        session.isPartial ? 1 : 0,
        session.collectedAt
      )
    return this.getSession(session.projectId, session.id)!
  }

  private sessionSelect(): string {
    return `
      SELECT sessions.*,
        (
          SELECT session_type
          FROM session_type_corrections
          WHERE project_id = sessions.project_id AND session_id = sessions.id
          ORDER BY id DESC LIMIT 1
        ) AS user_type
      FROM sessions
    `
  }

  getSession(projectId: string, sessionId: string): SessionRecord | undefined {
    const row = this.connection
      .prepare(`${this.sessionSelect()} WHERE sessions.project_id = ? AND sessions.id = ?`)
      .get(projectId, sessionId) as unknown as SessionRow | undefined
    return row ? sessionFromRow(row) : undefined
  }

  listSessions(projectId: string): SessionRecord[] {
    const rows = this.connection
      .prepare(
        `${this.sessionSelect()}
         WHERE sessions.project_id = ?
         ORDER BY sessions.updated_at DESC, sessions.id ASC`
      )
      .all(projectId) as unknown as SessionRow[]
    return rows.map(sessionFromRow)
  }

  insertEvidence(evidence: Evidence): boolean {
    const result = this.connection
      .prepare(
        `INSERT OR IGNORE INTO evidence (
          id, project_id, session_id, axis, status, summary, source, source_ref,
          occurred_at, collected_at, confidence, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        evidence.id,
        evidence.projectId,
        evidence.sessionId,
        evidence.axis,
        evidence.status,
        evidence.summary,
        evidence.source,
        evidence.sourceRef ?? null,
        evidence.occurredAt ?? null,
        evidence.collectedAt,
        evidence.confidence,
        evidence.details ? JSON.stringify(evidence.details) : null
      )
    return result.changes === 1
  }

  listEvidence(projectId: string, sessionId?: string): Evidence[] {
    const params: SQLInputValue[] = [projectId]
    let sql = 'SELECT * FROM evidence WHERE project_id = ?'
    if (sessionId) {
      sql += ' AND session_id = ?'
      params.push(sessionId)
    }
    sql += ' ORDER BY collected_at ASC, id ASC'

    const rows = this.connection.prepare(sql).all(...params) as Array<
      Record<string, string | null>
    >
    return rows.map((row) => ({
      id: row.id!,
      projectId: row.project_id!,
      sessionId: row.session_id!,
      axis: row.axis as Evidence['axis'],
      status: row.status!,
      summary: row.summary!,
      source: row.source!,
      sourceRef: row.source_ref ?? undefined,
      occurredAt: row.occurred_at ?? undefined,
      collectedAt: row.collected_at!,
      confidence: row.confidence as Evidence['confidence'],
      details: optionalJson<Record<string, unknown>>(row.details_json)
    }))
  }

  addTypeCorrection(
    projectId: string,
    sessionId: string,
    sessionType: SessionType,
    correctedAt: string
  ): TypeCorrection {
    if (!this.getSession(projectId, sessionId)) throw new Error('Session not found')
    const result = this.connection
      .prepare(
        `INSERT INTO session_type_corrections (
          project_id, session_id, session_type, corrected_at
        ) VALUES (?, ?, ?, ?)`
      )
      .run(projectId, sessionId, sessionType, correctedAt)
    return {
      id: Number(result.lastInsertRowid),
      projectId,
      sessionId,
      sessionType,
      correctedAt
    }
  }

  listTypeCorrections(projectId: string, sessionId: string): TypeCorrection[] {
    const rows = this.connection
      .prepare(
        `SELECT id, project_id, session_id, session_type, corrected_at
         FROM session_type_corrections
         WHERE project_id = ? AND session_id = ?
         ORDER BY id ASC`
      )
      .all(projectId, sessionId) as Array<{
      id: number
      project_id: string
      session_id: string
      session_type: SessionType
      corrected_at: string
    }>
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      sessionId: row.session_id,
      sessionType: row.session_type,
      correctedAt: row.corrected_at
    }))
  }

  recordSyncRun(
    projectId: string,
    startedAt: string,
    completedAt: string | undefined,
    status: Project['syncStatus'],
    coverage: CoverageWindow | undefined,
    failures: SyncFailure[]
  ): void {
    this.connection
      .prepare(
        `INSERT INTO sync_runs (
          project_id, started_at, completed_at, status, coverage_json, failures_json
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        projectId,
        startedAt,
        completedAt ?? null,
        status,
        coverage ? JSON.stringify(coverage) : null,
        JSON.stringify(failures)
      )
  }

  deleteProject(projectId: string): DeleteProjectResult {
    const count = (table: string): number => {
      const row = this.connection
        .prepare(`SELECT count(*) AS count FROM ${table} WHERE project_id = ?`)
        .get(projectId) as { count: number }
      return Number(row.count)
    }

    const projectExists = this.getProject(projectId) !== undefined
    const removed = {
      projects: projectExists ? 1 : 0,
      sessions: count('sessions'),
      evidence: count('evidence'),
      typeCorrections: count('session_type_corrections'),
      syncRuns: count('sync_runs')
    }

    this.connection.exec('BEGIN IMMEDIATE')
    try {
      this.connection.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
      this.connection.exec('COMMIT')
    } catch (error) {
      this.connection.exec('ROLLBACK')
      throw error
    }

    const remaining = [
      ['sessions', count('sessions')],
      ['evidence', count('evidence')],
      ['type corrections', count('session_type_corrections')],
      ['sync runs', count('sync_runs')]
    ]
      .filter(([, remainingCount]) => Number(remainingCount) > 0)
      .map(([category]) => String(category))

    return {
      deleted: projectExists && remaining.length === 0,
      removed,
      remaining
    }
  }
}
