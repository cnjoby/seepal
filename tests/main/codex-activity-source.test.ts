import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { CodexLogActivitySource } from '../../src/main/codex-activity-source.js'

const fixtures: string[] = []
const NOW = new Date('2026-07-30T13:00:00.000Z')

function createLogDatabase(
  rows: Array<{
    threadId: string
    at: string
    body: string
    nanos?: number
    target?: string
  }>
): string {
  const directory = mkdtempSync(join(tmpdir(), 'seepal-activity-'))
  fixtures.push(directory)
  const databasePath = join(directory, 'logs.sqlite')
  const database = new DatabaseSync(databasePath)
  database.exec(`
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ts_nanos INTEGER NOT NULL,
      target TEXT NOT NULL,
      feedback_log_body TEXT,
      thread_id TEXT
    )
  `)
  const insert = database.prepare(`
    INSERT INTO logs (ts, ts_nanos, target, feedback_log_body, thread_id)
    VALUES (?, ?, ?, ?, ?)
  `)
  for (const row of rows) {
    insert.run(
      Math.floor(new Date(row.at).getTime() / 1_000),
      row.nanos ?? 0,
      row.target ?? 'codex_core::session::turn',
      row.body,
      row.threadId
    )
  }
  database.close()
  return databasePath
}

function turn(id: string, suffix: string): string {
  return `turn.id=${id} ${suffix}`
}

afterEach(() => {
  for (const directory of fixtures.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('CodexLogActivitySource', () => {
  it('reports a recent unfinished latest turn as running', () => {
    const databasePath = createLogDatabase([
      {
        threadId: 'thread-running',
        at: '2026-07-30T12:59:00.000Z',
        body: turn('11111111-1111-4111-8111-111111111111', 'sampling started')
      }
    ])

    const result = new CodexLogActivitySource(databasePath, () => NOW).observe([
      'thread-running'
    ])

    expect(result.get('thread-running')).toMatchObject({
      status: 'running',
      confidence: 'confirmed'
    })
  })

  it('does not treat a completed turn as a completed session item', () => {
    const turnId = '22222222-2222-4222-8222-222222222222'
    const databasePath = createLogDatabase([
      {
        threadId: 'thread-complete-turn',
        at: '2026-07-30T12:58:00.000Z',
        body: turn(turnId, 'sampling started')
      },
      {
        threadId: 'thread-complete-turn',
        at: '2026-07-30T12:59:00.000Z',
        body: turn(
          turnId,
          'model_needs_follow_up=false has_pending_input=false needs_follow_up=false'
        )
      }
    ])

    const result = new CodexLogActivitySource(databasePath, () => NOW).observe([
      'thread-complete-turn'
    ])

    expect(result.get('thread-complete-turn')).toMatchObject({
      status: 'unknown',
      confidence: 'unknown'
    })
  })

  it('ignores marker text recorded by unrelated log targets', () => {
    const databasePath = createLogDatabase([
      {
        threadId: 'thread-marker-text',
        at: '2026-07-30T12:59:00.000Z',
        body: turn(
          '33333333-3333-4333-8333-333333333333',
          'command contains model_needs_follow_up=false has_pending_input=false needs_follow_up=false'
        ),
        target: 'codex_core::stream_events_utils'
      }
    ])

    const result = new CodexLogActivitySource(databasePath, () => NOW).observe([
      'thread-marker-text'
    ])

    expect(result.get('thread-marker-text')).toMatchObject({
      status: 'running',
      confidence: 'confirmed'
    })
  })

  it('keeps a stale unfinished turn unknown', () => {
    const databasePath = createLogDatabase([
      {
        threadId: 'thread-stale',
        at: '2026-07-30T12:30:00.000Z',
        body: turn('44444444-4444-4444-8444-444444444444', 'sampling started')
      }
    ])

    const result = new CodexLogActivitySource(databasePath, () => NOW).observe([
      'thread-stale'
    ])

    expect(result.get('thread-stale')).toMatchObject({
      status: 'unknown',
      confidence: 'unknown'
    })
  })

  it('uses the newest turn instead of an older finalized turn', () => {
    const databasePath = createLogDatabase([
      {
        threadId: 'thread-new-turn',
        at: '2026-07-30T12:55:00.000Z',
        body: turn(
          '55555555-5555-4555-8555-555555555555',
          'model_needs_follow_up=false has_pending_input=false needs_follow_up=false'
        )
      },
      {
        threadId: 'thread-new-turn',
        at: '2026-07-30T12:59:00.000Z',
        body: turn('66666666-6666-4666-8666-666666666666', 'sampling started')
      }
    ])

    const result = new CodexLogActivitySource(databasePath, () => NOW).observe([
      'thread-new-turn'
    ])

    expect(result.get('thread-new-turn')).toMatchObject({
      status: 'running',
      confidence: 'confirmed'
    })
  })
})
