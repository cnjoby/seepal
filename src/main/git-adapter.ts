import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { promisify } from 'node:util'

import type {
  Evidence,
  Project,
  ProjectScope,
  SessionRecord
} from '../shared/domain.js'

const execFileAsync = promisify(execFile)

export const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'rev-parse',
  'status',
  'worktree',
  'submodule',
  'ls-files',
  'symbolic-ref'
])

export interface GitCommandResult {
  stdout: string
  stderr: string
}

export type GitCommandRunner = (
  executable: string,
  args: readonly string[],
  cwd?: string
) => Promise<GitCommandResult>

export interface WorktreeSnapshot {
  path: string
  head?: string
  branch?: string
  detached: boolean
  porcelain: string
}

export interface GitSnapshot {
  canonicalRootPath: string
  head?: string
  branch?: string
  worktrees: WorktreeSnapshot[]
}

export interface VerifiedGitRead<T> {
  value: T
  before: GitSnapshot
  after: GitSnapshot
  unchanged: true
}

const defaultRunner: GitCommandRunner = async (executable, args, cwd) => {
  const result = await execFileAsync(executable, [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 15_000,
    killSignal: 'SIGKILL'
  })
  return { stdout: result.stdout, stderr: result.stderr }
}

function parseWorktrees(output: string): Array<Omit<WorktreeSnapshot, 'porcelain'>> {
  if (!output.trim()) return []
  return output
    .trim()
    .split(/\n\n+/)
    .map((block) => {
      const fields = new Map<string, string>()
      let detached = false
      for (const line of block.split('\n')) {
        const [key, ...rest] = line.split(' ')
        if (key === 'detached') detached = true
        else if (key) fields.set(key, rest.join(' '))
      }
      return {
        path: fields.get('worktree') ?? '',
        head: fields.get('HEAD'),
        branch: fields.get('branch')?.replace(/^refs\/heads\//, ''),
        detached
      }
    })
    .filter((worktree) => worktree.path.length > 0)
}

function parseSubmodules(output: string, root: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-+U ]/, '').split(/\s+/)[1])
    .filter((path): path is string => Boolean(path))
    .map((path) => resolve(root, path))
}

function parseTrackedSymlinks(output: string, root: string): string[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('120000 '))
    .map((line) => line.split('\t')[1])
    .filter((path): path is string => Boolean(path))
    .map((path) => resolve(root, path))
}

function snapshotsEqual(left: GitSnapshot, right: GitSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export class GitAdapter {
  constructor(private readonly runner: GitCommandRunner = defaultRunner) {}

  private async git(cwd: string, args: readonly string[]): Promise<string> {
    const subcommand = args[0]
    if (!subcommand || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
      throw new Error(`Git command is not on the read-only allowlist: ${subcommand ?? '(missing)'}`)
    }
    const result = await this.runner('git', args, cwd)
    return result.stdout
  }

  async inspectProject(rootPath: string): Promise<ProjectScope> {
    const selectedPath = resolve(rootPath)
    let selectedIsSymbolicLink = false
    try {
      selectedIsSymbolicLink = (await lstat(selectedPath)).isSymbolicLink()
    } catch {
      return {
        rootPath: selectedPath,
        canonicalRootPath: selectedPath,
        isGitRepository: false,
        worktrees: [],
        submodules: [],
        symbolicLinks: [],
        includedPaths: [],
        excludedPaths: [],
        warnings: ['选择的位置不存在或无法读取。']
      }
    }

    const canonicalSelectedPath = await realpath(selectedPath)
    try {
      const inside = (
        await this.git(canonicalSelectedPath, ['rev-parse', '--is-inside-work-tree'])
      ).trim()
      if (inside !== 'true') throw new Error('Not inside a work tree')
    } catch {
      return {
        rootPath: selectedPath,
        canonicalRootPath: canonicalSelectedPath,
        isGitRepository: false,
        worktrees: [],
        submodules: [],
        symbolicLinks: selectedIsSymbolicLink ? [selectedPath] : [],
        includedPaths: [],
        excludedPaths: [],
        warnings: ['选择的位置不是有效的 Git 工作目录。']
      }
    }

    const topLevel = (
      await this.git(canonicalSelectedPath, ['rev-parse', '--show-toplevel'])
    ).trim()
    const canonicalRootPath = await realpath(topLevel)
    const gitDirectory = (
      await this.git(canonicalRootPath, ['rev-parse', '--absolute-git-dir'])
    ).trim()
    const worktrees = parseWorktrees(
      await this.git(canonicalRootPath, ['worktree', 'list', '--porcelain'])
    ).map((item) => item.path)

    let submodules: string[] = []
    let symbolicLinks: string[] = []
    try {
      submodules = parseSubmodules(
        await this.git(canonicalRootPath, ['submodule', 'status', '--recursive']),
        canonicalRootPath
      )
    } catch {
      // A repository without initialized submodules can still be inspected.
    }
    try {
      symbolicLinks = parseTrackedSymlinks(
        await this.git(canonicalRootPath, ['ls-files', '-s']),
        canonicalRootPath
      )
    } catch {
      // Missing tracked-file metadata does not invalidate the repository.
    }

    const warnings: string[] = []
    if (canonicalSelectedPath !== canonicalRootPath) {
      warnings.push(`已将所选子目录归一到仓库根目录 ${canonicalRootPath}。`)
    }
    if (selectedIsSymbolicLink) {
      warnings.push('所选位置是符号链接；SeePal 使用其规范目标路径识别项目。')
    }
    if (submodules.length > 0) {
      warnings.push('子模块会显示在范围说明中，但不会自动作为独立项目扫描。')
    }
    if (symbolicLinks.length > 0) {
      warnings.push('不会自动扩大读取范围到仓库外的符号链接目标。')
    }

    return {
      rootPath: selectedPath,
      canonicalRootPath,
      isGitRepository: true,
      gitDirectory,
      worktrees,
      submodules,
      symbolicLinks,
      includedPaths: [...new Set([canonicalRootPath, ...worktrees])],
      excludedPaths: [...submodules, ...symbolicLinks],
      warnings
    }
  }

  async snapshotRepository(rootPath: string): Promise<GitSnapshot> {
    const canonicalRootPath = await realpath(rootPath)
    let head: string | undefined
    try {
      head = (
        await this.git(canonicalRootPath, ['rev-parse', '--verify', 'HEAD'])
      ).trim()
    } catch {
      // A newly initialized repository is valid even before its first commit.
    }
    const worktreeRows = parseWorktrees(
      await this.git(canonicalRootPath, ['worktree', 'list', '--porcelain'])
    )
    const worktrees: WorktreeSnapshot[] = []
    for (const worktree of worktreeRows) {
      let worktreePath: string
      try {
        worktreePath = await realpath(worktree.path)
      } catch {
        continue
      }
      const porcelain = await this.git(worktreePath, [
        'status',
        '--porcelain=v1',
        '--untracked-files=all'
      ])
      worktrees.push({ ...worktree, path: worktreePath, porcelain })
    }
    let branch: string | undefined
    try {
      branch = (
        await this.git(canonicalRootPath, ['symbolic-ref', '--short', 'HEAD'])
      ).trim()
    } catch {
      // Detached HEAD is represented without a branch.
    }
    return { canonicalRootPath, head, branch, worktrees }
  }

  async verifyReadOnly<T>(
    rootPath: string,
    operation: () => Promise<T>
  ): Promise<VerifiedGitRead<T>> {
    const before = await this.snapshotRepository(rootPath)
    const value = await operation()
    const after = await this.snapshotRepository(rootPath)
    if (!snapshotsEqual(before, after)) {
      throw new Error('Git state changed during a read-only SeePal scan')
    }
    return { value, before, after, unchanged: true }
  }

  async collectSessionEvidence(
    project: Project,
    sessions: SessionRecord[],
    collectedAt = new Date().toISOString()
  ): Promise<VerifiedGitRead<Evidence[]>> {
    return this.verifyReadOnly(project.canonicalRootPath, async () => {
      const snapshot = await this.snapshotRepository(project.canonicalRootPath)
      const byPath = new Map(snapshot.worktrees.map((worktree) => [worktree.path, worktree]))
      const evidence: Evidence[] = []

      for (const session of sessions) {
        let canonicalCwd: string
        try {
          canonicalCwd = await realpath(session.cwd)
        } catch {
          continue
        }
        const worktree = byPath.get(canonicalCwd)
        if (!worktree) continue

        const dirty = worktree.porcelain.length > 0
        evidence.push({
          id: `${project.id}:${session.providerSessionId}:git-worktree:${collectedAt}`,
          projectId: project.id,
          sessionId: session.id,
          axis: 'worktree',
          status: dirty ? 'dirty' : 'clean',
          summary: dirty
            ? `Worktree ${basename(worktree.path)} 仍有未提交改动。`
            : `Worktree ${basename(worktree.path)} 当前干净。`,
          source: 'git-status',
          sourceRef: worktree.path,
          occurredAt: collectedAt,
          collectedAt,
          confidence: 'candidate',
          details: {
            branch: worktree.branch,
            head: worktree.head,
            changedEntryCount: dirty
              ? worktree.porcelain.split('\n').filter(Boolean).length
              : 0
          }
        })

        evidence.push({
          id: `${project.id}:${session.providerSessionId}:git-changes:${collectedAt}`,
          projectId: project.id,
          sessionId: session.id,
          axis: 'changes',
          status: dirty ? 'candidate' : 'unknown',
          summary: dirty
            ? '该 Session 的工作目录存在改动，但 SeePal 尚不能确认每项改动都由它产生。'
            : '当前工作目录没有未提交改动，但仅凭这一事实无法判断该 Session 是否曾产生并提交改动。',
          source: 'git-status',
          sourceRef: worktree.path,
          occurredAt: collectedAt,
          collectedAt,
          confidence: dirty ? 'candidate' : 'unknown'
        })

        const headAdvanced =
          Boolean(session.sourceBaseCommit) &&
          Boolean(worktree.head) &&
          session.sourceBaseCommit !== worktree.head
        evidence.push({
          id: `${project.id}:${session.providerSessionId}:git-commit:${collectedAt}`,
          projectId: project.id,
          sessionId: session.id,
          axis: 'commit',
          status: headAdvanced ? 'committed' : 'unknown',
          summary: headAdvanced
            ? 'Worktree HEAD 已不同于 Session 开始时记录的 Commit；这是候选提交关系，仍需用户确认归属。'
            : '当前 Git HEAD 不足以确认这个 Session 的改动是否已经提交。',
          source: 'git-head',
          sourceRef: worktree.head,
          occurredAt: collectedAt,
          collectedAt,
          confidence: headAdvanced ? 'candidate' : 'unknown',
          details: {
            sessionBaseCommit: session.sourceBaseCommit,
            currentHead: worktree.head
          }
        })
      }
      return evidence
    })
  }
}
