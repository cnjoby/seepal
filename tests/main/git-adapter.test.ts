import { describe, expect, it } from 'vitest'

import {
  GitAdapter,
  READ_ONLY_GIT_SUBCOMMANDS,
  type GitCommandRunner
} from '../../src/main/git-adapter.js'

function stableRunner(status = ''): {
  runner: GitCommandRunner
  subcommands: string[]
} {
  const subcommands: string[] = []
  const runner: GitCommandRunner = async (_executable, args) => {
    const command = args[0] ?? ''
    subcommands.push(command)
    if (command === 'rev-parse') throw new Error('HEAD does not exist')
    if (command === 'worktree') {
      return { stdout: 'worktree /tmp\nHEAD 0000000\nbranch refs/heads/main\n', stderr: '' }
    }
    if (command === 'status') return { stdout: status, stderr: '' }
    if (command === 'symbolic-ref') return { stdout: 'main\n', stderr: '' }
    throw new Error(`Unexpected command ${command}`)
  }
  return { runner, subcommands }
}

describe('GitAdapter read-only boundary', () => {
  it('supports a repository without HEAD and invokes only allowlisted reads', async () => {
    const fixture = stableRunner()
    const adapter = new GitAdapter(fixture.runner)

    const result = await adapter.verifyReadOnly('/tmp', async () => 'read result')

    expect(result.unchanged).toBe(true)
    expect(result.before.head).toBeUndefined()
    expect(fixture.subcommands.every((command) => READ_ONLY_GIT_SUBCOMMANDS.has(command))).toBe(
      true
    )
  })

  it('rejects a scan when the before/after Git state changes', async () => {
    let statusReads = 0
    const runner: GitCommandRunner = async (_executable, args) => {
      if (args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '' }
      if (args[0] === 'worktree') {
        return { stdout: 'worktree /tmp\nHEAD abc\nbranch refs/heads/main\n', stderr: '' }
      }
      if (args[0] === 'status') {
        statusReads += 1
        return { stdout: statusReads === 1 ? '' : ' M changed.ts\n', stderr: '' }
      }
      if (args[0] === 'symbolic-ref') return { stdout: 'main\n', stderr: '' }
      throw new Error('Unexpected command')
    }
    const adapter = new GitAdapter(runner)

    await expect(adapter.verifyReadOnly('/tmp', async () => undefined)).rejects.toThrow(
      'Git state changed'
    )
  })
})
