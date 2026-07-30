---
title: 'Configurable AI Connector'
type: 'feature'
created: '2026-07-30'
status: 'done'
baseline_commit: '3b0eaa8f0adb041cf87de1f6d270c14618bfff79'
context:
  - 'docs/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** SeePal 尚不能连接可配置模型，也就无法继续把 Session 转写成目标、结果、缺口和下一步。

**Approach:** 增加全局 AI 设置入口，支持 OpenAI-compatible 与 Anthropic-compatible 两种协议，安全保存本机配置并执行一次由用户明确触发的最小连通性测试；同时提供后续 Session Interpreter 可复用的主进程客户端，但本规格不批量分析 Session。

## Boundaries & Constraints

**Always:** 默认示例为 OpenAI `https://api.deepseek.com`、Anthropic `https://api.deepseek.com/anthropic`、模型 `deepseek-v4-flash` 和占位 Key `sk-your-api-key`；真实 Key 不得进入源码、Git、普通 SQLite、Renderer 返回值、错误或日志；仅在 Electron `safeStorage` 可用时加密落盘，Renderer 只看到 `hasApiKey`；只允许无账号、Query 或 Fragment 的 HTTPS URL；测试连接由用户点击触发，15 秒超时、禁止重定向并限制响应大小。

**Ask First:** 实现过程中使用用户真实 Key 发起可能计费的联网测试；新增第三方 SDK、遥测、自动重试或自动模型调用；把模型配置改为项目级而非全局。

**Never:** 把真实 Key 作为默认值、夹具或文档；明文保存或由 Renderer 直接调用模型；在本规格内上传/批量分析 Session；让模型推断成为交付事实；调用 Codex/Claude Code CLI 形成监控污染。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 首次打开设置 | 尚无配置 | 显示协议选择、对应 DeepSeek Base URL、模型和 Key 占位文本 | 不创建配置文件、不联网 |
| 保存配置 | 合法协议、URL、模型和新 Key | 非敏感字段落入本机配置文件，Key 加密 | 加密不可用或输入非法时不覆盖旧配置 |
| 重新打开 | 已保存配置 | 恢复协议、URL、模型并显示“已保存密钥”，不返回明文 | 配置损坏时回退示例并显示可恢复错误 |
| 更新但 Key 留空 | 已有密钥、修改 URL/模型 | 保留原密钥并更新其他字段 | 不把空字符串写成密钥 |
| 清除密钥 | 用户明确点击清除 | 删除加密密钥并将状态改为未配置 | 其他设置保留 |
| 测试 OpenAI 协议 | 已保存完整配置 | 请求 `{baseUrl}/chat/completions`，显示模型和耗时 | 超时、HTTP 或格式异常时显示脱敏错误 |
| 测试 Anthropic 协议 | 已保存完整配置 | 请求 `{baseUrl}/v1/messages`，显示模型和耗时 | 同上 |

</frozen-after-approval>

## Code Map

- `src/main/ai-provider.ts` -- 配置校验、两种协议请求、超时、响应解析与错误脱敏。
- `src/main/ai-config-store.ts` -- JSON 配置与注入式密钥加解密边界。
- `src/main/index.ts`、`src/main/ipc.ts` -- 使用 `safeStorage` 组装服务并注册受信 IPC。
- `src/shared/ipc.ts`、`src/preload/index.ts`、`src/renderer/api.ts`、`src/renderer/types.ts` -- 不泄露明文的跨进程契约。
- `src/renderer/App.tsx`、`src/renderer/styles.css`、`src/renderer/icons.tsx` -- 项目轨设置入口、AI 配置弹窗、保存/清除/测试反馈。
- `tests/main/ai-provider.test.ts`、`tests/main/ai-config-store.test.ts`、`tests/renderer/App.test.tsx` -- 协议、安全边界和用户流程。

## Tasks & Acceptance

**Execution:**
- [x] `src/main/ai-config-store.ts` -- 实现原子化本机配置持久化和可注入加密器；只向调用方返回是否已有 Key。
- [x] `src/main/ai-provider.ts` -- 用原生 `fetch` 实现两种协议、超时、响应校验和脱敏，不增加 SDK。
- [x] `src/main/index.ts`、`src/main/ipc.ts`、`src/shared/ipc.ts`、`src/preload/index.ts` -- 接入安全存储并暴露读取、保存、清除密钥和测试连接 IPC。
- [x] `src/renderer/App.tsx`、`src/renderer/styles.css`、`src/renderer/icons.tsx` -- 增加全局 AI 设置弹窗、默认示例、密码输入和测试反馈。
- [x] `tests/`、`README.md` -- 覆盖 I/O 矩阵并记录配置位置、协议、网络与隐私边界。

**Acceptance Criteria:**
- Given 全新安装，when 打开 AI 设置，then 不联网、不创建密钥且能直接看到用户给定的 DeepSeek 协议示例。
- Given 用户保存合法配置，when 重启并重开设置，then 非敏感字段恢复、Key 只显示“已保存”且不存在明文副本。
- Given 用户选择任一协议并点击测试，when 模拟服务返回合法响应，then 使用正确路径和认证 Header，并显示成功、模型与耗时。
- Given 远端超时、拒绝或返回异常，when 测试连接，then 保留配置并显示脱敏错误。
- Given 配置底座完成，when 后续 Session Interpreter 在主进程请求文本生成，then 可复用同一客户端而无需读取 Renderer 或再次处理密钥。

## Verification

**Commands:**
- `npm test` -- 配置、协议、IPC 与 Renderer 测试全部通过。
- `npm run typecheck` -- Main、Preload、Renderer 类型检查通过。
- `npm run build` -- 生产构建成功。
- `npm run package:mac` -- 生成可启动的 macOS `.app`。

**Manual checks:**
- 打开打包应用，确认两种协议切换、默认示例、密码遮罩、保存后重开、清除 Key 和失败反馈。

## Suggested Review Order

**安全配置边界**

- 从密钥保存入口理解加密、域名绑定与损坏配置恢复。
  [`ai-config-store.ts:118`](../../src/main/ai-config-store.ts#L118)

- macOS `safeStorage` 只在主进程组装，不向 Renderer 暴露明文。
  [`index.ts:66`](../../src/main/index.ts#L66)

- 受信 IPC 校验输入并限制 AI 操作入口。
  [`ipc.ts:203`](../../src/main/ipc.ts#L203)

**模型协议与网络边界**

- 单一客户端实现显式调用、超时、限流与脱敏错误。
  [`ai-provider.ts:23`](../../src/main/ai-provider.ts#L23)

- 两种协议分别组装路径、认证头和最小请求。
  [`ai-provider.ts:74`](../../src/main/ai-provider.ts#L74)

- 响应解析只接受文本并保留本地配置的模型标识。
  [`ai-provider.ts:155`](../../src/main/ai-provider.ts#L155)

**用户设置体验**

- 项目轨提供全局入口，不干扰项目与 Session 视图。
  [`App.tsx:358`](../../src/renderer/App.tsx#L358)

- 设置弹窗呈现示例、保存、清除、测试及键盘焦点约束。
  [`App.tsx:1262`](../../src/renderer/App.tsx#L1262)

- 弹窗视觉样式延续现有桌面控制台语言。
  [`styles.css:1752`](../../src/renderer/styles.css#L1752)

**契约与验证**

- 共享类型固定默认示例与无明文跨进程契约。
  [`ipc.ts:29`](../../src/shared/ipc.ts#L29)

- 配置测试覆盖加密、域名切换、损坏与非法输入。
  [`ai-config-store.test.ts:42`](../../tests/main/ai-config-store.test.ts#L42)

- 协议测试覆盖路径、认证、响应解析与脱敏失败。
  [`ai-provider.test.ts:22`](../../tests/main/ai-provider.test.ts#L22)

- Renderer 测试覆盖默认示例、显式测试和清除行为。
  [`App.test.tsx:301`](../../tests/renderer/App.test.tsx#L301)

- README 明确本地配置、联网时机和隐私边界。
  [`README.md:48`](../../README.md#L48)
