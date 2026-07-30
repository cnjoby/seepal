# Epic 1 Context: 打开 Project Console，看懂所有历史 Session 的状态

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

交付一个可安装的 macOS 本地应用，使同时使用大量 AI 编码 Session 的个人开发者可以添加一个或多个本地 Git 项目，明确授权 Codex 历史读取，在统一 Project Console 中理解历史 Session 的活动、类型、改动、Review、Commit、Worktree 和数据新鲜度。Epic 1 只回答“这些 Session 现在怎么样”，不实现 Attention Queue 排序、Provider 焦点跳转、上下文承接操作、WorkItem 聚合或多 Provider 接入。

## Stories

- Story 1.1: 添加第一个本地项目
- Story 1.2: 授权并同步 Codex 历史
- Story 1.3: 在 Project Console 看懂所有 Session
- Story 1.4: 查看一个 Session 的完整状态依据
- Story 1.5: 确认或纠正 Session 类型
- Story 1.6: 管理多个项目并删除本地数据

## Requirements & Constraints

- 应用以无需登录的 macOS 桌面应用交付；核心数据、状态计算和 Console 默认在本机完成，断网时仍可查看和重算已有事实。
- 用户选择本地 Git 仓库创建项目。仓库、Worktree、子模块、符号链接和 Provider 历史的读取范围必须在扫描前明确展示；取消操作不能留下虚假项目。
- 同一仓库不能创建重复项目。多个项目的数据、授权、筛选、Session 和派生状态必须隔离；无法确定归属的 Session 不得静默加入项目。
- Codex 授权与仓库授权分离。至少支持“最小信息”和“本机完整内容”两种策略；读取完整会话前需显式确认。无法稳定发现 Session 时显示连接或导入指引。
- 同步必须显示阶段、覆盖区间、最后成功时间、数据源失败和受影响范围。中断或部分失败不得隐藏已成功读取的数据，也不能把局部覆盖呈现为完整事实。
- Console 默认按“需要我处理、AI 正在工作、等待其他 Session、已经收尾、状态不明确”分组，并支持按 Session 主要类型查看或筛选。状态和类型筛选可组合。
- 主要类型使用受控列表：需求/功能实现、BUG 修复、调研/问题排查、代码审查、测试/验收、文档、工程治理、发布/部署/运维、产品/UX/设计、其他/未知。
- 类型建议必须带依据和置信度；低置信度保留未知。用户修正后重算类型分组和适用状态解释，同时保留系统建议与修正历史。
- Session 详情分别展示活动、改动、人工 Review、Commit、Worktree/集成和承接状态。聚合摘要不能掩盖各状态轴，也不能把 Session 结束表述为需求完成。
- 每条状态包含来源、发生时间、采集时间和新鲜度。缺失、过期、冲突或弱关联必须显示数据不足或候选关系。
- 调研、审查、测试、文档等类型可能没有代码变化；不得只因没有 Diff 生成未完成结论。
- 用户删除项目时先看到 SeePal 保存的数据类别。删除覆盖应用管理的记录、索引、派生状态、提醒、缓存、临时文件和相关日志，不修改 Provider Session、源码、Git 对象、Branch、Worktree 或原始文档。

## Technical Decisions

- 采用单机模块化结构，桌面壳、UI、应用服务、Provider Adapter、Git Adapter、规范事实和派生投影之间保持明确边界。
- V0.1 使用 Electron + React + TypeScript；本地持久化使用 SQLite。具体库只服务当前故事，不提前建设插件系统或多租户抽象。
- 规范模型至少覆盖 Project、Session、SessionType、Worktree、Evidence 和 Assessment；只在当前故事需要时创建表和索引。
- 原始事实只追加，Console 状态属于可重算投影。重复、乱序和中断导入必须幂等，不能制造重复 Session 或错误完成状态。
- Codex 首版优先验证只读 Thread 列表、读取与状态能力。Adapter 维护只读方法白名单、Schema Fixtures、Contract Tests 和支持版本矩阵；不兼容时停止受影响判断。
- 默认不持久化非必要完整 Transcript、源码、Prompt、终端输出或 Tool Result。远端增强不属于 Epic 1。
- 本地进程通信不得监听 LAN 或公网；如使用 localhost，需随机凭证和 Origin 限制。优先避免不必要的本地 HTTP 服务。
- 自动化测试必须证明扫描前后 Provider、Git Index 和 Worktree 未改变。派生状态必须可从固定事实重算。

## UX & Interaction Patterns

- Project Console 是主窗口和首屏；空状态引导添加项目，失败状态说明原因和修复动作。
- Session 行在有限空间内显示 Provider、标题、主要类型、主状态、最后活动时间、关联 Branch/Worktree 和下一步；完整状态轴在详情中展开。
- “当前无需处理”“Session 已结束”“证据完整”“状态不明确”使用不同文案。
- 候选关联使用弱确认样式并展示依据；监控中断时保留上次成功结果，同时明显标注数据截止时间。
- 从 Console 到 Session 详情不超过两次交互。界面不复制完整聊天记录，也不呈现虚假完成百分比。

## Cross-Story Dependencies

- Story 1.1 建立项目与本地应用入口；Story 1.2 在其上增加 Codex 授权和同步。
- Story 1.3 使用前两者产生的项目与 Session 事实建立 Console；Story 1.4 复用同一状态投影展示证据详情。
- Story 1.5 在 Story 1.3/1.4 的类型展示基础上增加用户修正；Story 1.6 将既有项目能力扩展到多项目隔离和完整删除。
