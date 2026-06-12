# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## 项目概况

Narrative-OS-Core 是一个面向长篇叙事写作的世界状态一致性引擎。核心能力：追踪小说中的设定、角色状态、伏笔、知识可见性，确保长篇写作中不出现设定矛盾。

**当前阶段**：设计阶段，仅有架构文档，尚无源代码。

## 唯一核心文档

`docs/Narrative-OS-Core-Architecture.md`（4200+ 行）是唯一的权威设计规格。所有实现决策以此文档为准。修改此文档前必须理解完整上下文。

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

## 实现注意事项

文档附录 C 定义了 Phase 0-5 的开发顺序，实现前必须阅读。已知实现陷阱：

1. `commit_event` 中 `cost_id` 显式核销的校验位置在处理函数，不在 `isCostFilled` 内
2. LanceDB 布尔字段 metadata filter 兼容性不确定，集成测试先验证 `is_current = true`，降级方案改用 integer 0/1
3. `better-sqlite3` 不默认启用 WAL，需在 `open()` 中显式 `db.pragma('journal_mode = WAL')`
4. `markInvalid` 必须同时更新 `valid_to` 和 `is_current` 两个字段，保证原子性
