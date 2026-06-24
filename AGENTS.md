# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## 项目概况

Narrative-OS-Core 是一个面向长篇叙事写作的世界状态一致性引擎。核心能力：追踪小说中的设定、角色状态、伏笔、知识可见性，确保长篇写作中不出现设定矛盾。

**当前阶段**：Phase 7 后期。Core 引擎（五大抽象 + 11 个 Tool 接口）已完整实现；Writing Layer 完成约 65%（安全地基 W1-W5 + 验收功能 W6-W9 + 一致性 W10-W17 均已完成，测试 W18-W19 待完成）。

## 核心文档

- `docs/Narrative-OS-Core-Architecture.md`（4200+ 行）：权威设计规格，所有实现决策以此文档为准
- `docs/core-development-log.md`：Core 层开发日志，记录每次变更的设计决策、验证结果和剩余风险
- `docs/Writing-Layer-Gap-Register.md`：写作层缺口登记表，追踪 W1-W19 开发进度
- `docs/Writing-Layer-Feature-Spec.md`：写作层功能规格
- `docs/Phase7-Refinement.md`：Phase 7 细化设计

## 源码结构

```
src/
├── types/          # 15 个类型文件（base/fact/entity/event/knowledge/thread/rule/tool/...）
├── core/           # 核心引擎（proposal-manager/retcon-engine/rule-engine/query-engine/thread-resolver/context-analyzer/fact-renderer/tool-router/...）
├── adapters/       # 适配器（sqlite/ lancedb/ llm/ embedding/）
├── agent/          # NarrativeAgent ReAct 循环 + 记忆管理 + 上下文压缩
├── writing/        # 写作层（services/ repositories/ view-models/ core-bridge/ agent/ errors/ models/）
├── cli/            # CLI 入口（chat.ts + 命令处理）
└── index.ts        # 主入口导出
```

## 架构核心概念

**五大抽象**（引擎只理解这五个概念，题材特定的一切通过 World Package 注入）：

- **Fact**：不可变时序三元组 (subject, predicate, value, time)，世界状态的最小单元
- **NarrativeThread**：叙事线索追踪（回溯型伏笔 + 渐进型铺垫），带生命周期状态机
- **Knowledge**：per-entity 可见性/确信度模型——"谁在什么时候以什么确信度知道了什么"
- **ContextScope**：作用域继承 + 遮蔽机制（副本/梦境/异世界），作者控制退出持久化
- **Rule Engine**：四类规则（Transition/Inference/Constraint/Propagation），沙盒推演后提交

**World Package**：题材无关配置包，定义谓词注册表、规则集、实体模板、作用域预设。引擎零题材假设，所有题材特定规则通过 World Package 外挂加载。

**关键技术选型**：
- 存储：SQLite via better-sqlite3（WAL 模式）
- 语义检索：LanceDB + 硅基流动 bge-m3 embedding
- LLM：DeepSeek v4-flash / v4-pro
- 适配器模式：所有外部依赖通过接口抽象

**数据流三条线**：
- 写入流：作者→LLM→propose_event（沙盒预演）→commit_event（确定性写入）
- 读取流：系统 Push 模式，语义检索主动注入 LLM 上下文
- 校验流：Rule Engine 持续运行约束检查

## 编码约定

- 所有代码注释使用中文，注释解释"为什么"而非"是什么"
- 函数/类的文档注释（docstring/JSDoc）使用中文
- 提交信息使用中文

## 已知实现陷阱

1. `commit_event` 中 `cost_id` 显式核销的校验位置在处理函数，不在 `isCostFilled` 内
2. LanceDB 布尔字段 metadata filter 兼容性不确定，集成测试先验证 `is_current = true`，降级方案改用 integer 0/1
3. `better-sqlite3` 不默认启用 WAL，需在 `open()` 中显式 `db.pragma('journal_mode = WAL')`
4. `markInvalid` 必须同时更新 `valid_to` 和 `is_current` 两个字段，保证原子性
5. Fact ID 生成使用完整事件标识前缀 `fct_{causeEvent去evt_}_{seq}`，解决多词事件类型冲突
6. `register_entity` 的 `events` 写入与 `entities` 写入必须原子（共享 Database 事务）
7. ToolRouter 返回 camelCase（`profileMarkdown`/`factIndex`），非 snake_case
8. `propose_event` 的 `subject` 是实体 ID（如 `ent_zhangsan`），非显示名，全链契约一致

## 测试

```bash
npx tsc --noEmit          # 类型检查
npx vitest run            # 全量测试
```

所有测试使用真实 DeepSeek LLM（无 Mock）。Agent 驱动的测试需要 `DEEPSEEK_API_KEY` 环境变量，无 key 时 `describeIf` 门控跳过。

## 开发顺序

尊重依赖顺序，除非用户明确重定向：

```
Meta Model → Ontology Validation → Graph Validation → Query/State Reader
→ Event Engine → EventLog/Temporal Validity → Belief/Knowledge Engine
→ Rule Engine → Analyzer → Snapshot/Diff → Scale Readiness
```

写作层开发顺序见 `docs/Writing-Layer-Gap-Register.md`：Wave 1 安全地基 → Wave 2 验收功能 → Wave 3 一致性 → Wave 4 测试。
