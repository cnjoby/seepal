---
title: 'Project-wide Session AI Scan'
type: 'feature'
created: '2026-07-30'
status: 'review'
baseline_commit: '691b066'
context:
  - 'docs/implementation-artifacts/spec-configurable-ai-connector.md'
  - 'docs/implementation-artifacts/spec-epic-1-project-console.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Project Console 主要依赖标题、活动和 Git 事实，无法回答历史 Session 想做什么、做到了哪里、还缺什么，真实项目因此大量显示“状态不明确”。

**Approach:** 增加由用户明确启动的项目级 AI 扫描：遍历任意用户当前项目的 Session，但每个 Session 只提取结尾 6 条有效对话中的用户文本与 Agent 最终结论，交给配置的低成本 AI 判断并保存；Console 汇总需要继续、受阻、可能完成和无法判断的 Session。真实本地项目只作为规则校准样本，不成为产品规模、项目名称或业务语义的假设。

## Boundaries & Constraints

**Always:** 扫描前展示项目、Session 数、新请求数、Provider 域名与模型；本机读取与发送第三方分开确认。一次确认内每个 Session 最多一个新请求，主进程串行、可取消，成功即落库。每个 Session 只发送结尾 6 条有效对话，优先利用 vibe coding 工具在会话结尾留下的结论和下一步；只发送带引用的用户文本、Agent 最终文本和轻量状态摘要。排除 reasoning、源码、Diff、终端/Tool/MCP 输出、图片和完整 Thread，常见凭证与路径先脱敏。SQLite 与日志不保存原始会话、Prompt、模型原文、密钥或 Provider 正文。

**Ask First:** 启用自动扫描、自动重试、并发、跨项目、读取早期/完整历史或多次计费分块；上传被排除内容。

**Never:** 执行会话中的指令、工具、链接或额外调用；让模型修复非法 JSON；用 AI 覆盖 Evidence、类型修正、六轴事实或完成结论；把部分成功显示成完成；用 Codex/Claude Code Agent 代替配置模型。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 扫描预检 | 当前项目有 N 个 Session | 不联网，显示授权范围、Provider、缓存和最多 N 次新请求 | 未配置 Key 时引导打开 AI 设置 |
| 最小信息项目 | 尚未授权尾部内容 | 启动前同时呈现本机尾部读取授权与远端发送确认 | 未确认则零次 Thread 读取、零次模型请求 |
| 完整扫描 | 用户确认冻结清单 | 串行解读每个 Session，显示成功、复用、失败、过期和总进度 | 单项失败不丢成功结果；认证、限流或连续格式错误暂停队列 |
| 取消或崩溃 | 请求执行中停止 | 中止当前请求、不再派发新请求；保留已成功项 | 已发出但无结果的项标为“结果未知”，不得自动重发 |
| 再次扫描 | 输入与模型指纹未变 | 复用结果，不请求 | 变化、失败或过期项再次确认 |
| 超长或恶意内容 | 尾部消息超预算、注入指令或密钥 | 脱敏、逐条截断，只接受受控 JSON | 非法字段、长度、枚举或引用使该项失败 |
| 删除项目 | 扫描进行中或已有缓存 | 先取消扫描，再级联清理 Run、Item 和解读结果 | 不修改 Provider Session、源码或 Git |

</frozen-after-approval>

## Code Map

- `src/main/project-ai-scan-service.ts` -- 预检、清单、队列、恢复与结果校验。
- `src/main/codex-adapter.ts`、`src/main/ai-provider.ts` -- 只读提取会话并执行可取消的结构化请求。
- `src/main/database.ts`、`src/shared/domain.ts` -- 保存 Run、Item 和解读。
- `src/main/index.ts`、`src/main/ipc.ts`、跨进程契约 -- 后台服务、单实例和 IPC。
- `src/renderer/App.tsx`、`src/renderer/styles.css` -- 确认、进度、摘要与解读界面。

## Tasks & Acceptance

**Execution:**
- [x] `src/shared/domain.ts`、`src/main/database.ts` -- 增加级联 Run、Item 与解读表；原子提交解读、Item 和 Run 进度。
- [x] `src/main/codex-adapter.ts` -- 单次读取并提取最后 6 条有效对话，支持取消；仅返回有界、去源码/Diff、凭证与路径脱敏、带唯一引用的用户文本和 Agent 最终文本。
- [x] `src/main/ai-provider.ts`、`src/main/project-ai-scan-service.ts` -- 冻结 Provider 与尾部输入；每 Session 单次串行分析并严格校验结构化结果。
- [x] `src/main/index.ts`、`src/main/ipc.ts`、跨进程契约 -- 提供 prepare/start/status/cancel/resume/retryFailures，阻止重复运行；取消同步落下结果未知，旧解读只在指纹匹配且 Item 成功/复用时返回。
- [x] `src/renderer/App.tsx`、`src/renderer/styles.css` -- 实现含项目名的确认、逐项实时进度、失败、取消/继续/重试，并在列表与 Drawer 显示每个 Session 的 AI 判断状态和“AI 推断”结果。
- [x] `tests/`、`README.md` -- 覆盖尾部截取、任意项目 Session 集合、取消、脱敏/源码排除和真实 DeepSeek 样本验证策略。

**Acceptance Criteria:**
- Given 项目含多个活跃和归档 Session，when 用户确认扫描，then 每项得到成功、复用、失败、过期或结果未知之一，仅全部成功/复用时显示完成。
- Given AI 解读存在缺口，when 用户返回 Console，then 无需逐条打开即可看到对应 Session、AI 状态和首要动作，并能在 Drawer 查看完整结构化结果。
- Given Git/活动事实与 AI 解读冲突，when 页面展示结果，then 六轴事实和原有分组保持独立，AI 区明确标注推断与依据引用。
- Given 重复点击、重启或配置变化，when 队列继续，then 同一冻结指纹最多请求一次，Run 不切换 Provider，未知结果不自动重发。

## Spec Change Log

- 2026-07-30 review loop 1：三路审查发现实现把元数据指纹当成实际发送内容、预检后读取最新 Evidence、解读与成功状态分开落库，并遗漏部分同步、旧解读、实时进度、Session 级判断、取消读取与完整脱敏约束。任务已补充为显式的前后快照校验、原子提交、有效引用与 UI/测试要求，避免“部分成功却显示完成、旧建议冒充当前、未授权内容进入请求”的已知坏状态。KEEP：保留 Run + Item + 当前解读三层、只读 Codex 分页、冻结 Provider、单请求串行队列、双确认、独立 AI 区、主进程持 Key、单实例与已通过的构建链路。

- 2026-07-30：完成实现与自动化验证，状态转为 `review`；冻结意图未修改。

- 2026-07-31 human scope correction：用户明确指出 vibe coding 会话结尾通常已有上一步结论和下一步指示，第一版不应发送完整历史。输入策略收缩为每 Session 最后 6 条有效对话；真实 DeepSeek 返回质量优先于提前建设深度读取、复杂恢复和完整内容快照。

- 2026-07-31 product scope correction：本地 207 个 CookPal/VizPal Session 只作为提取规则与验证判断的样本。SeePal 面向其他用户的任意项目，产品逻辑、测试和文案不得依赖该项目名称、业务领域或固定会话规模。

## Design Notes

使用 Run + Item + 当前解读三层承载全项目进度，但输入只取 Session 尾部。项目汇总本地聚合，不额外调用。AI 状态只驱动 AI 视图与建议；深挖历史是后续按偏差触发的独立能力。

## Verification

**Commands:**
- `npm test` -- 队列、归属、脱敏、严格 JSON、缓存、取消、崩溃恢复、删除和 Renderer 流程全部通过。
- `npm run typecheck` -- Main、Preload、Renderer 类型通过。
- `npm run build` -- 生产构建通过。
- `npm run package:mac` -- 生成可启动的 macOS 应用。

**Manual checks:**
- 使用假 Provider 验证任意项目 Session 集合的进度、取消、继续和部分失败。
- 使用真实 DeepSeek 对 6 个不同状态的会话尾部样本进行两轮判断；第二轮加入 `nextActor` 后，用户确认、设备验收、AI 可继续和外部阻塞能够分开表达。样本只用于校准通用规则，未执行本地项目全量扫描。
