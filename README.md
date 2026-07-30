# SeePal

SeePal is a local macOS project console for understanding the state of AI
coding sessions. Epic 1 supports Codex sessions associated with local Git
repositories. It does not require an account or a network connection after the
application and dependencies are installed.

## Develop

Requirements: macOS, Node.js 24 or newer, npm, Git, and Codex CLI `0.139.x`.

```sh
npm install
npm run dev
```

Verification and packaging:

```sh
npm test
npm run typecheck
npm run build
npm run package:mac
```

The unsigned development application is written beneath
`release/mac*/SeePal.app`. macOS may require explicitly allowing an unsigned
local build in Privacy & Security.

## Data boundary

- Project setup requires explicit confirmation before SeePal creates a local
  record or reads Codex history.
- Repository and Codex authorization are separate. Metadata mode stores only
  identifiers, timestamps, status and a short provider preview. Full local
  content mode is opt-in and never uploads content.
- Git inspection uses read-only commands. SeePal records the working tree state
  before and after inspection and rejects a changed snapshot.
- Codex integration uses only `initialize`, state-database-only `thread/list`
  and `thread/read` over the local App Server stdio protocol. It never sends
  prompts, resumes sessions or invokes JSONL scan-and-repair behavior.
- When App Server reports a historical Thread as `notLoaded`, SeePal reads only
  bounded activity flags and timestamps from the local Codex `logs_2.sqlite`
  database. The database is opened read-only; log bodies, prompts and command
  content are neither returned to the renderer nor stored by SeePal.
- Renderer sandboxing, context isolation and a typed preload bridge keep file,
  process and database access in the main process.
- Global AI connector settings are stored in `ai-provider.json` beneath
  Electron's per-user application-data directory. Base URL, protocol and model
  are ordinary local settings; the API key is encrypted with Electron
  `safeStorage`, is never returned to the renderer, and is not stored in
  SQLite or logs.
- The connector supports OpenAI-compatible and Anthropic-compatible request
  shapes. The default examples are DeepSeek endpoints and
  `deepseek-v4-flash`; `sk-your-api-key` is only a placeholder.
- Opening or saving AI settings does not contact a provider. A minimal request
  is sent only when the user clicks **测试连接**. Requests use HTTPS, reject
  redirects, time out after 15 seconds and cap response bodies at 1 MiB.
- Deleting a project removes SeePal's database copy. It does not delete source
  files, Git objects, branches, worktrees, Codex sessions or source documents.

The application database is stored in Electron's per-user application-data
directory. Existing data remains available offline if a later provider sync
fails.

## Codex compatibility

| Codex CLI | Discovery | Thread details | Behavior outside matrix |
| --- | --- | --- | --- |
| `0.139.x` | `thread/list` with exact `cwd` | `thread/read` | Mark unverified versions degraded while responses remain compatible |

SeePal treats incomplete pages, incompatible responses and interrupted reads as
partial coverage. It does not present partial history as a complete project
record.

## Epic 1 scope

Implemented: local projects, Codex authorization and sync, status/type views,
six-axis evidence details, type corrections, project isolation and local data
deletion.

Not implemented: Session interpretation or bulk upload, Attention ranking,
provider focus/deep links, context handoff, work-item aggregation, OpenCode,
Claude Code, terminal streaming, automatic prompts, cloud accounts or Kanban
workflows.
