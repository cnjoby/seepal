---
title: 'Epic 1 Project Console'
type: 'feature'
created: '2026-07-30'
status: 'done'
baseline_commit: 'NO_VCS'
context:
  - 'docs/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** AI vibe coding 用户无法快速判断大量历史 Session 当前怎么样，常遗漏 Review、Commit、Worktree 收尾或数据异常。当前 SeePal 仓库为空，还没有可运行的 macOS 产品。

**Approach:** 建立 Electron + React + TypeScript + SQLite 的本地 macOS 应用，完成 Epic 1 六个故事：项目接入、Codex 授权同步、Project Console、Session 状态详情、类型纠正、多项目隔离与删除。

## Boundaries & Constraints

**Always:** 无账号、离线可查看；Renderer 沙箱化且仅通过类型化 IPC 访问本机能力；Codex/Git 只读；状态保留来源、时间和新鲜度；未知或冲突证据保守显示；UI 文案站在用户角度；自动化测试覆盖边界；只修改独立 SeePal 仓库。

**Ask First:** 增加本规格未列出的运行时依赖；启用任何联网、遥测、代码签名或公证；读取授权范围外的完整 Session；改变 Provider/Git 数据；调整已批准的 Session 类型或分组。

**Never:** 实现 Epic 2 Attention 排序、Provider 焦点跳转、上下文承接操作、WorkItem 聚合、Claude Code/OpenCode、终端直播、自动发送 Prompt、通用 Kanban、云端多租户。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 首次项目 | 有效 Git 仓库 | 确认范围后创建唯一项目 | 取消时不留项目 |
| 无效或重复项目 | 非 Git 路径或已存在路径 | 不创建副本 | 显示原因并允许重选 |
| Codex 同步 | 用户选择最小信息或本机全文 | 显示覆盖、阶段、成功时间 | 无法发现时给连接/导入指引 |
| 部分失败 | 已有部分 Session，后续读取失败 | 保留已读数据并标记受影响范围 | 不呈现虚假完整性 |
| 状态异常 | 缺失、过期、冲突或弱关联 | 显示未知/候选及依据 | 不推断完成 |
| 删除项目 | 用户确认删除 | 清除 SeePal 副本 | 原 Session、源码和 Git 不变 |

</frozen-after-approval>

## Code Map

- `package.json`、`electron-builder.yml`、`electron.vite.config.ts`、`tsconfig*.json` -- Electron 开发、测试、构建和 macOS `.app` 打包。
- `src/shared/` -- Project、Session、Evidence、Assessment、IPC 请求/响应等跨进程契约。
- `src/main/` -- SQLite、项目服务、Git/Codex 只读 Adapter、状态投影、IPC 和删除。
- `src/preload/index.ts` -- 向 Renderer 暴露最小 SeePal API。
- `src/renderer/` -- 项目栏、接入流程、Console、筛选、Session 详情和删除确认。
- `tests/` -- 领域规则、数据库、Adapter、服务、React 交互和关键端到端流程。

## Tasks & Acceptance

**Execution:**
- [x] `package.json`、构建配置、`src/main/index.ts`、`src/preload/index.ts`、`src/renderer/index.html` -- 建立可运行、沙箱化、可打包的 Electron 骨架；仅使用 Electron、React、electron-vite、node:sqlite、Vitest/Testing Library 和 electron-builder。
- [x] `src/shared/domain.ts`、`src/shared/ipc.ts`、`src/main/assessment.ts` -- 定义规范模型、受控 Session 类型、多轴状态、分组与保守投影规则。
- [x] `src/main/database.ts`、`src/main/project-service.ts` -- 实现项目唯一性、多项目隔离、原始事实/用户修正持久化和完整本地删除。
- [x] `src/main/git-adapter.ts` -- 验证仓库并只读采集 Branch、Worktree、状态和 Commit 事实，保留扫描前后不变证据。
- [x] `src/main/codex-adapter.ts` -- 通过 stdio App Server 只读发现、分页读取 Codex Thread，支持两种内容策略、部分失败、覆盖和兼容状态。
- [x] `src/main/ipc.ts`、`src/preload/index.ts` -- 校验 IPC sender 与输入，提供项目、同步、Session 详情、类型修正和删除 API。
- [x] `src/renderer/` -- 实现“精密仪表台”界面：项目轨、状态/类型组合分组、Session evidence spine、授权流程、详情抽屉与删除反馈；使用 Avenir Next、系统字体和 SF Mono，支持键盘焦点与 reduced motion。
- [x] `tests/` -- 对 I/O 矩阵、只读性、幂等同步、状态投影、类型纠正、多项目隔离、删除和 UI 主流程执行测试先行。
- [x] `README.md` -- 记录安装、开发、测试、数据边界、支持的 Codex 版本与未实现范围。

**Acceptance Criteria:**
- Given 新用户打开构建后的 `.app`，when 添加并授权一个真实 Git/Codex 项目，then 10 分钟内看到 Console 或明确的数据不足结果，且无需账号或网络。
- Given 已同步 Session，when 查看 Console，then 可按行动状态与主要类型组合查看，并能展开六条状态轴、依据和新鲜度。
- Given 用户修改 Session 类型，when 保存，then 分组与适用状态重新计算，同时保留系统建议和修正历史。
- Given 多个项目，when 切换或删除，then 数据严格隔离；删除 SeePal 副本后原 Provider、源码、Branch 和 Worktree 不变。
- Given 重复、部分失败或过期输入，when 重算，then 不产生重复 Session、虚假完成或静默降级。

## Design Notes

采用冷银灰、深海军蓝、钴蓝、信号琥珀与苔绿的 macOS 仪表台语汇。独特元素是 Session `evidence spine`：一条纵向轨道以六个节点表达活动、改动、Review、Commit、Worktree 和承接；节点状态取代装饰性图表。左侧为紧凑项目轨，中间为可分组 Console，右侧为详情抽屉。

## Verification

**Commands:**
- `npm test` -- 领域、服务、Adapter 和 Renderer 测试全部通过。
- `npm run typecheck` -- 主进程、Preload、Renderer 无类型错误。
- `npm run build` -- Electron 生产构建成功。
- `npm run package:mac` -- 生成可启动的未签名 macOS `.app`。

## Suggested Review Order

**用户主流程**

- 从项目选择到 Console、刷新与删除的完整状态协调。
  [`App.tsx:65`](../../src/renderer/App.tsx#L65)

- 授权确认后才创建项目并读取 Codex 历史。
  [`App.tsx:903`](../../src/renderer/App.tsx#L903)

- 六轴证据、来源、新鲜度与类型纠正集中呈现。
  [`App.tsx:714`](../../src/renderer/App.tsx#L714)

**事实与状态投影**

- 用保守规则把独立事实归入行动状态。
  [`assessment.ts:198`](../../src/main/assessment.ts#L198)

- 同步保留部分成功，并把异常收口为明确失败。
  [`project-service.ts:122`](../../src/main/project-service.ts#L122)

- 用户语言、候选关系和逐轴新鲜度在 IPC 前统一投影。
  [`view-model.ts:67`](../../src/main/view-model.ts#L67)

**本机只读集成**

- Codex state-DB-only 读取、超时、分页和兼容性边界。
  [`codex-adapter.ts:341`](../../src/main/codex-adapter.ts#L341)

- Git 命令白名单和扫描前后状态不变验证。
  [`git-adapter.ts:114`](../../src/main/git-adapter.ts#L114)

- SQLite 隔离、修正历史和中断同步恢复。
  [`database.ts:274`](../../src/main/database.ts#L274)

**安全边界**

- 主进程校验发送者、绝对路径与受控枚举输入。
  [`ipc.ts:69`](../../src/main/ipc.ts#L69)

- Preload 仅暴露冻结的类型化最小 API。
  [`index.ts:27`](../../src/preload/index.ts#L27)

- CSP 与 Electron 沙箱共同限制 Renderer 能力。
  [`index.html:11`](../../src/renderer/index.html#L11)

**验证与交付**

- 服务测试覆盖失败收口、幂等同步和项目隔离。
  [`project-service.test.ts:100`](../../tests/main/project-service.test.ts#L100)

- Renderer 测试覆盖授权、组合筛选、修正和删除。
  [`App.test.tsx:155`](../../tests/renderer/App.test.tsx#L155)

- 开发、打包、数据边界和未实现范围集中说明。
  [`README.md:1`](../../README.md#L1)
