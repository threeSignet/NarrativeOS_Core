# Phase 3 开发计划 ✅ 全部完成

> 本文件是 Phase 3（渲染与工具）的持久化路线图。
> 每完成一步，更新本文件的状态标记。
> 引擎读取此文件确定"下一步做什么"，完成后更新状态并记录到开发日志。
>
> **完成日期**：2026-06-12。Phase 3A/3B/3C 全部完成，10 个 Tool 全部实现，ToolService 已接入 FactRenderer。

---

## 全局验收标准

每个 Step 完成前必须满足：
- [x] `npm run typecheck` 零错误
- [x] `npm test` 全量通过（无回归）
- [x] 新增/修改的测试覆盖新逻辑
- [x] 交叉核对架构文档 `docs/Narrative-OS-Core-Architecture.md` 对应章节，实现与文档一致
- [x] `docs/core-development-log.md` 记录了变更内容

---

## Phase 3 概述

Phase 3 分为三个子阶段：

| 子阶段 | 目标 | 架构章节 |
|--------|------|----------|
| **3A FactRenderer** | 实现 5 种渲染格式，将结构化 Fact/Thread/Knowledge 转为 LLM 可读 Markdown | §8 |
| **3B Tool Interface 补齐** | 实现 Tool 6 (resolve_thread) + Tool 9/10 (Schema Extension 两阶段提交) | §9.2 |
| **3C 现有 Tool 接入 FactRenderer** | 将 FactRenderer 接入所有已实现 Tool 的返回值 | §8 + §9.2 |

### 当前 Tool 实现状态

| Tool | 状态 | 实现位置 |
|------|------|----------|
| 1. get_context_slice | ✅ 已完成 | ToolService.getContextSlice → FactRenderer.renderEntityProfile |
| 2. propose_event | ✅ 已完成 | ProposalManager.proposeEvent → FactRenderer.renderSimulationReport |
| 3. commit_event | ✅ 已完成 | ProposalManager.commitEvent（无需 FactRenderer） |
| 4. propose_retcon | ✅ 已完成 | RetconEngine.proposeRetcon（内建 generateCascadeReport） |
| 5. commit_retcon | ✅ 已完成 | RetconEngine.commitRetcon（无需 FactRenderer） |
| 6. resolve_thread | ✅ 已完成 | ProposalManager.resolveThread（手动关闭 + 自动目标状态） |
| 7. get_open_threads | ✅ 已完成 | ToolService.getOpenThreads → FactRenderer.renderThreadSummary |
| 8. register_entity | ✅ 已完成 | 直接调用 FactStore + EventStore |
| 9. propose_schema_extension | ✅ 已完成 | SchemaExtensionManager.proposePredicate/Rule/Template/ScopePreset |
| 10. commit_schema_extension | ✅ 已完成 | SchemaExtensionManager.commitExtension（事务化两阶段提交） |

---

## Phase 3A：FactRenderer（事实渲染层）

> 目标：实现 5 种渲染格式，将结构化数据转为 LLM 可读的 Markdown。
> 架构文档：§8.2（5 个接口方法）、§8.3（renderEntityProfile 示例）、§8.4（renderSimulationReport 示例）

### Step 3A-1：renderEntityProfile —— 实体完整档案渲染

**状态**：✅ 已完成

**任务**：
- 参数：entityId / snapshot / relations / openThreads / atChapter / entityNames
- 渲染为 §8.3 格式的 Markdown：核心属性表 + 关系列表 + 未关闭线索清单
- 属性表标注每条 Fact 的 causeEvent 和章节号
- 关系列表区分方向（主动→被动，被动←来源）
- 线索清单标注方向和超期状态
- `entityNames` 映射用于实体 ID → 可读名称转换

**验收条件**：
- [x] 正确渲染实体属性和来源事件
- [x] 正确渲染双向关系
- [x] 正确渲染关联线索及超期标记
- [x] 空关系/无线索时不崩溃

**架构文档对照**：§8.2 renderEntityProfile + §8.3 输出示例

**测试**：
- [x] 修仙角色档案渲染（含境界、状态、武器、关系、线索）
- [x] 无线索的实体渲染
- [x] 无关系的实体渲染

---

### Step 3A-2：renderThreadSummary —— 叙事线索清单渲染

**状态**：✅ 已完成

**任务**：
- 参数：threads / currentChapter
- 分组渲染：回溯型线索 + 渐进型线索
- 回溯型：标注截止章节、超期状态、severity
- 渐进型：标注当前状态（PLANTED/HINTED/PARTIALLY_REVEALED）、暗示次数
- 输出包含 expiring_soon（距截止 ≤5 章）和 hintable 列表

**验收条件**：
- [x] 回溯型/渐进型分组正确
- [x] 超期阈值计算正确（currentChapter - withinChapters > 0）
- [x] severity 标签渲染（🔴 critical / 🟡 major / ⚪ minor）

**架构文档对照**：§8.2 renderThreadSummary + Tool 7 返回值

**测试**：
- [x] 多种状态线索混合渲染
- [x] 全部已超期场景
- [x] 无线索时返回空清单

---

### Step 3A-3：renderSimulationReport —— 推演审计报告渲染

**状态**：✅ 已完成

**任务**：
- 参数：proposalId / consequences / isSafe
- 渲染 §8.4 格式：状态（SAFE/UNSAFE）+ 新产生 Fact 列表 + 生成线索 + 推理附带 Fact + 警告
- SAFE_TO_COMMIT（含警告）vs UNSAFE_TO_COMMIT 不同展示风格
- 警告信息从 consequences.warnings 提取

**验收条件**：
- [x] SAFE/UNSAFE 状态正确渲染
- [x] 推理 Fact 和规则产生线索区分展示
- [x] 警告和建议段落

**架构文档对照**：§8.2 renderSimulationReport + §8.4 输出示例

**测试**：
- [x] SAFE_TO_COMMIT 渲染
- [x] UNSAFE_TO_COMMIT 渲染
- [x] 无推理 Fact 的干净报告

---

### Step 3A-4：renderKnowledgePerspective —— 角色知识视角渲染

**状态**：✅ 已完成

**任务**：
- 参数：entityId / knowledge / facts / atChapter / entityNames
- 渲染角色在指定章节"知道什么"：Facts by predicate 分组 + 来源 + 确信度
- 标注每个 Knowledge 的 source（self_action/witnessed/informed 等）和 confidence
- 确认度分组：完全确定(1.0) / 高度确信(0.8-0.99) / 不确定(<0.8)

**验收条件**：
- [x] 按确信度分组展示
- [x] source 标签渲染
- [x] 空白知识视角返回"该角色当前无确定认知"

**架构文档对照**：§8.2 renderKnowledgePerspective

**测试**：
- [x] 混合确信度的知识视角
- [x] 含多个 source 的知识视角
- [x] 空知识视角

---

### Step 3A-5：renderRelevantFacts —— 相关 Fact 集合渲染

**状态**：✅ 已完成

**任务**：
- 参数：factSet (RelevantFactSet) / entityNames
- 渲染 Semantic Retrieval 注入 LLM 上下文前的 Fact 集合
- 分组：核心实体属性 / 相关实体关系 / 场景状态
- 每项 Fact 标注宿主实体 + 命名 + 来源事件
- 与 renderEntityProfile 不同——这是"集合摘要"而非"单实体深度档案"

**验收条件**：
- [x] 分组逻辑合理
- [x] 实体名称正确映射
- [x] 空集合返回空字符串

**架构文档对照**：§8.2 renderRelevantFacts

**测试**：
- [x] 多实体混合 Fact 集合渲染
- [x] 单实体 Fact 集合渲染

---

## Phase 3B：Tool Interface 补齐

> 目标：实现 Phase 0-2 尚未完成的 Tool 6/9/10。
> 架构文档：§9.2 Tool 6/9/10

### Step 3B-1：Tool 6 resolve_thread —— 手动关闭叙事线索

**状态**：✅ 已完成

**任务**：
- 参数：thread_id / resolution_event_id / explanation / new_status?
- 校验线程存在且状态可关闭（OPEN_STATUSES）
- 根据 direction 自动选择目标状态（回溯→FILLED，渐进→RESOLVED），除非显式传入 new_status
- 调用 ThreadStore.updateStatus + addMilestone
- 返回 resolution 状态 + milestone_id

**验收条件**：
- [x] 回溯型线索手动关闭 → FILLED
- [x] 渐进型线索手动关闭 → RESOLVED
- [x] 自定义 target 状态（ABANDONED）
- [x] 已关闭线索返回 rejected
- [x] 不存在的线程返回 rejected

**架构文档对照**：§9.2 Tool 6

**测试**：
- [x] 回溯型正常关闭
- [x] 渐进型正常关闭
- [x] 手动 ABANDONED
- [x] 重复关闭拒绝
- [x] 线程不存在拒绝

---

### Step 3B-2：Tool 9 propose_schema_extension —— 提议 Schema 扩展

**状态**：✅ 已完成

**任务**：
- 参数：extension_type (predicate/rule/entity_template/scope_preset) + 对应的扩展数据
- 校验：谓词不与现有重名、规则 JSON 格式合法、模板父类存在、preset 名称不重复
- 生成 proposal_id
- 返回：proposal_id + 扩展摘要 + 冲突列表
- 保存 proposal 到内存 Map（同 ProposalStore 模式）

**验收条件**：
- [x] 新增谓词提案生成成功
- [x] 与已有谓词重名时返回冲突
- [x] 规则格式不合法时返回错误
- [x] proposal_id 格式正确

**架构文档对照**：§9.2 Tool 9 + §3.9 四层来源模型

**测试**：
- [x] 谓词扩展提案
- [x] 规则扩展提案
- [x] 实体模板扩展提案
- [x] 作用域预设扩展提案
- [x] 重名冲突检测

---

### Step 3B-3：Tool 10 commit_schema_extension —— 确认 Schema 扩展

**状态**：✅ 已完成

**任务**：
- Phase A：从内存读取 proposal，重新校验无冲突
- Phase B 事务：
  - 递增 state_version
  - INSERT events: evt_schema_* 系统事件 (kind='system', type='schema')
  - INSERT/UPDATE wp_* 表（wp_predicates/wp_rules/wp_entity_templates/wp_scope_presets）
  - INSERT audit_log
  - 不写 Fact/Knowledge/Thread/sync_queue
- Phase C：重建 World Package 摘要缓存
- 返回：schema_event_id + affected_tables + new_predicate_names / new_rule_ids

**验收条件**：
- [x] 系统事件 kind='system', type='schema' 正确创建
- [x] wp_* 表写入成功
- [x] state_version 递增
- [x] audit_log 写入
- [x] 重复提交拒绝

**架构文档对照**：§9.2 Tool 10 + commit_schema_extension Phase A/B/C 分解

**测试**：
- [x] 谓词扩展提交成功
- [x] 规则扩展提交成功
- [x] 重复提交失败
- [x] proposal 不存在失败

---

## Phase 3C：现有 Tool 接入 FactRenderer

> 目标：将 Phase 3A 的 FactRenderer 接入所有现有 Tool 的返回值，
> 使 LLM 获得 Markdown 渲染输出而非纯结构化 JSON。

### Step 3C-1：get_context_slice 接入 renderEntityProfile

**状态**：✅ 已完成

**任务**：
- ToolService.getContextSlice 调用 FactRenderer.renderEntityProfile
- 返回 profile_markdown + fact_index（FactIndexEntry[]）
- 实现 ID 传递契约：fact_index 中的 factId 供 LLM 后续 update/retract 使用

**验收条件**：
- [x] 返回 profile_markdown 和 fact_index
- [x] fact_index 中每个条目包含 action_hint
- [x] 与现有 QueryEngine 接口兼容

**架构文档对照**：§9.2 Tool 1 + ID 传递契约

---

### Step 3C-2：propose_event 接入 renderSimulationReport

**状态**：✅ 已完成

**任务**：
- ProposalManager.proposeEvent 内部已生成 simulationReportMarkdown
- 确保 report 包含推理 Fact、线索、警告、操作建议

**验收条件**：
- [x] simulationReportMarkdown 由 FactRenderer 生成
- [x] 格式对齐 §8.4 输出示例
- [x] 现有依赖 simulationReportMarkdown 的测试不回归

**架构文档对照**：§8.2 renderSimulationReport + §8.4

---

### Step 3C-3：get_open_threads 接入 renderThreadSummary

**状态**：✅ 已完成

**任务**：
- ToolService.getOpenThreads 调用 FactRenderer.renderThreadSummary
- 返回 threads_markdown + expiring_soon + hintable + total_open
- 内部调用 ThreadResolver.getExpiringThreads / getHintableThreads

**验收条件**：
- [x] threads_markdown 包含完整的线索清单渲染
- [x] expiring_soon 正确列出超期线索
- [x] hintable 正确列出可暗示线索

**架构文档对照**：§9.2 Tool 7

---

## Phase 3 完成标准 ✅ 全部达成

- [x] FactRenderer 5 个方法全部实现并通过测试（`tests/integration/fact-renderer.test.ts`）
- [x] 10 个 Tool 全部实现（ToolService + ProposalManager + SchemaExtensionManager 覆盖）
- [x] 所有 LLM 可读输出由 FactRenderer 统一渲染
- [x] ID 传递契约（get_context_slice → propose_event）完整闭环
- [x] 全量测试通过（312 个测试，18 个测试文件，零回归）
