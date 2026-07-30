---
title: '修复 macOS AI Key 安全存储不可用'
type: 'bugfix'
created: '2026-07-31'
status: 'done'
baseline_commit: 'd2cca23'
context:
  - 'docs/implementation-artifacts/spec-configurable-ai-connector.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 用户在打包后的 macOS 应用中保存 AI API Key 时，主进程同步调用 `safeStorage.isEncryptionAvailable()` 返回 false，保存被直接拒绝，导致 AI 扫描无法使用。Electron 当前推荐异步安全存储；它会延迟初始化钥匙串并处理暂时不可用。

**Approach:** 将主进程密钥保存与读取链路改为 Electron 异步 `safeStorage`，让 macOS 有机会完成钥匙串初始化或授权；保留现有加密文件格式与 Renderer 无明文边界。若钥匙串最终确实不可用，继续拒绝保存并返回用户可执行的安全提示。

## Boundaries & Constraints

**Always:** API Key 只在主进程短暂存在；只以 `safeStorage` 密文落盘；保存、读取、测试连接和 AI 扫描都等待异步密钥操作完成；已有密文配置保持可读；错误不得包含 Key、密文或底层钥匙串细节。

**Ask First:** 引入第三方凭证库、修改配置文件版本、清除或迁移用户已有密钥、要求用户手工修改钥匙串。

**Never:** 明文保存、使用可逆的固定应用密钥、自建弱加密作为降级、把 Key 返回 Renderer、因安全存储不可用而静默报告保存成功。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 首次保存 | 同步检查不可用，但异步钥匙串可初始化 | 等待初始化，加密并原子保存，返回已保存 | 不显示同步检查错误 |
| 钥匙串确实不可用 | 异步安全存储返回不可用或加密失败 | 不创建或覆盖配置 | 提示解锁 macOS 登录钥匙串后重试 |
| 已有密钥 | 重启后读取旧密文 | 异步解密并供模型客户端使用，不回传明文 | 解密失败时保留文件并提示重新保存 |
| 并发调用 | 保存、测试或扫描等待密钥操作 | 每个调用取得完整配置或明确失败 | 不产生半写入配置 |

</frozen-after-approval>

## Code Map

- `src/main/ai-config-store.ts` -- 配置持久化与注入式异步密钥加解密边界。
- `src/main/index.ts` -- 将 Electron 异步 `safeStorage` 组装进配置服务。
- `src/main/ai-provider.ts`、`src/main/project-ai-scan-service.ts` -- 等待异步 Provider 配置后再请求。
- `src/main/ipc.ts` -- 等待保存、清除和读取配置操作。
- `tests/main/ai-config-store.test.ts`、`tests/main/ai-provider.test.ts`、`tests/main/project-ai-scan-service.test.ts` -- 回归与调用链测试。

## Tasks & Acceptance

**Execution:**
- [x] `src/main/ai-config-store.ts` -- 将密钥 Cipher 与公开方法改为异步，保留原子写入和旧密文兼容。
- [x] `src/main/index.ts` -- 使用 `isAsyncEncryptionAvailable`、`encryptStringAsync`、`decryptStringAsync`，将底层错误转成安全提示。
- [x] `src/main/ai-provider.ts`、`src/main/project-ai-scan-service.ts`、`src/main/ipc.ts` -- 传播异步等待，不改变网络协议或 Renderer 契约。
- [x] `tests/main/ai-config-store.test.ts` 及相关测试 -- 先复现同步不可用/异步可用，再覆盖不可用、旧配置和调用链。
- [x] 重新构建并挂载 DMG，验证打包应用可保存 Key；通过后替换待发布 DMG。

**Acceptance Criteria:**
- Given macOS 同步安全存储检查不可用但异步钥匙串可初始化，when 用户保存 Key，then 配置成功保存且磁盘文件不含明文。
- Given Key 已保存，when 用户测试连接或启动 Session AI 扫描，then 主进程等待解密完成后发起请求。
- Given macOS 钥匙串最终不可用，when 用户保存 Key，then 原配置保持不变并得到“解锁登录钥匙串后重试”的提示。

## Spec Change Log

## Verification

**Commands:**
- `npm run typecheck` -- Main、Preload、Renderer 类型通过。
- `npm test` -- 安全存储及 AI 调用链回归通过。
- `npm run build` -- 生产构建通过。
- `npx electron-builder --mac dmg --arm64` -- 生成替换后的 DMG。
- `hdiutil verify` -- DMG 校验通过。

**Packaged app validation:**
- 在已解锁 macOS 登录钥匙串后，用临时测试 Key 完成保存；配置文件权限为 `600`，磁盘文件不含明文。
- 退出并重新打开打包应用后，界面仍显示密钥已保存，证明异步解密可读取持久化密文。
- 通过应用界面清除临时测试 Key；配置文件已移除 `encryptedApiKey`，未留下测试凭证。

## Suggested Review Order

**状态并发与钥匙串边界**

- 优先从配置服务切入，先确认竞态与 keychain 不可用分支都已闭环。
  [`ai-config-store.ts:45`](../../src/main/ai-config-store.ts#L45)
- 并发保存/清除通过 `mutationVersion` 和预先写入令牌避免“旧请求覆盖新决策”。
  [`ai-config-store.ts:126`](../../src/main/ai-config-store.ts#L126)
- `getPublicConfig` 在钥匙串不可用时不再误报已保存，避免 UI 导航误导。
  [`ai-config-store.ts:169`](../../src/main/ai-config-store.ts#L169)

**扫描流程并发保护**

- 对 prepare/start 增加状态闸门，避免同项目重复构建和发起重复扫描。
  [`project-ai-scan-service.ts:234`](../../src/main/project-ai-scan-service.ts#L234)

**回归测试**

- 新增并发保存/清除回归，覆盖旧请求被后续调用覆盖、clear 被 resurrect 的典型路径。
  [`ai-config-store.test.ts:85`](../../tests/main/ai-config-store.test.ts#L85)
- 新增并发 prepare/start 回归，覆盖同项目并发创建和启动分支。
  [`project-ai-scan-service.test.ts:230`](../../tests/main/project-ai-scan-service.test.ts#L230)
