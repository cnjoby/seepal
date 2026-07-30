import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { ActivityStatus } from '../shared/domain.js'

export interface CodexActivityObservation {
  status: ActivityStatus
  observedAt: string
  confidence: 'confirmed' | 'unknown'
  summary: string
}

export interface CodexActivitySource {
  observe(providerSessionIds: string[]): Map<string, CodexActivityObservation>
}

interface ActivityRow {
  thread_id: string
  ts: number
  turn_id: string
  is_final: number
}

interface TurnState {
  turnId: string
  latestAtMs: number
  finalAtMs?: number
}

const DEFAULT_LIVE_WINDOW_MS = 15 * 60 * 1_000
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1_000
const BATCH_SIZE = 200

export class CodexLogActivitySource implements CodexActivitySource {
  constructor(
    private readonly databasePath = join(
      process.env.CODEX_HOME || join(homedir(), '.codex'),
      'logs_2.sqlite',
    ),
    private readonly now = () => new Date(),
    private readonly liveWindowMs = DEFAULT_LIVE_WINDOW_MS,
  ) {}

  observe(providerSessionIds: string[]): Map<string, CodexActivityObservation> {
    const observations = new Map<string, CodexActivityObservation>()
    if (providerSessionIds.length === 0 || !existsSync(this.databasePath)) {
      return observations
    }

    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(this.databasePath, { readOnly: true })
      const cutoffSeconds = Math.floor(
        (this.now().getTime() - DEFAULT_LOOKBACK_MS) / 1_000,
      )
      const states = new Map<string, TurnState>()

      for (let offset = 0; offset < providerSessionIds.length; offset += BATCH_SIZE) {
        const batch = providerSessionIds.slice(offset, offset + BATCH_SIZE)
        const placeholders = batch.map(() => '?').join(', ')
        const rows = database
          .prepare(
            `SELECT
               thread_id,
               ts,
               substr(
                 feedback_log_body,
                 instr(feedback_log_body, 'turn.id=') + length('turn.id='),
                 36
               ) AS turn_id,
               CASE
                 WHEN target = 'codex_core::session::turn'
                   AND feedback_log_body LIKE '%model_needs_follow_up=false has_pending_input=false needs_follow_up=false%'
                 THEN 1 ELSE 0
               END AS is_final
             FROM logs
             WHERE thread_id IN (${placeholders})
               AND ts >= ?
               AND instr(feedback_log_body, 'turn.id=') > 0
             ORDER BY thread_id ASC, ts DESC, ts_nanos DESC, id DESC`,
          )
          .all(...batch, cutoffSeconds) as unknown as ActivityRow[]

        for (const row of rows) {
          if (!/^[0-9a-f-]{36}$/i.test(row.turn_id)) continue
          const observedAtMs = row.ts * 1_000
          const state = states.get(row.thread_id)
          if (!state) {
            states.set(row.thread_id, {
              turnId: row.turn_id,
              latestAtMs: observedAtMs,
              finalAtMs: row.is_final ? observedAtMs : undefined
            })
            continue
          }
          if (state.turnId !== row.turn_id) continue
          if (row.is_final) state.finalAtMs = Math.max(state.finalAtMs ?? 0, observedAtMs)
        }
      }

      const nowMs = this.now().getTime()
      for (const [threadId, state] of states) {
        const observedAt = new Date(
          state.finalAtMs ?? state.latestAtMs,
        ).toISOString()
        if (state.finalAtMs) {
          observations.set(threadId, {
            status: 'unknown',
            observedAt,
            confidence: 'unknown',
            summary:
              'Codex 本机活动日志显示最新 Turn 已结束；这不代表 Session 事项已经完成。',
          })
        } else if (nowMs - state.latestAtMs <= this.liveWindowMs) {
          observations.set(threadId, {
            status: 'running',
            observedAt,
            confidence: 'confirmed',
            summary: 'Codex 本机活动日志显示最新 Turn 仍在执行。',
          })
        } else {
          observations.set(threadId, {
            status: 'unknown',
            observedAt,
            confidence: 'unknown',
            summary: 'Codex 活动日志已超过实时窗口，无法确认 Session 是否仍在执行。',
          })
        }
      }
    } catch {
      return new Map()
    } finally {
      database?.close()
    }

    return observations
  }
}
