---
name: narrative-dev
description: |
  Narrative-OS-Core 自主开发模式。给定目标后自动执行"读规格→实现→测试→交叉核对→记录"循环。
  适用于所有 Phase（2-5），不绑定特定阶段。
  触发词：自主开发、goal、按计划开发、继续开发。
---

# Narrative-OS 自主开发 Skill

## 参数

由调用方传入，或从对话上下文推断：

- **`goal`**（必填）：开发目标。示例：
  - `"Phase 2C"`
  - `"完成 commit_event 集成 ThreadResolver"`
  - `"Phase 3 FactRenderer"`
  - `"全部剩余 Phase 2"`
- **`step`**（可选）：从哪个 Step 开始，省略则从计划文件中第一个 `⬜` 开始
- **`max_steps`**（可选）：本次最多执行几个 Step，默认 1（每步完成后报告）

## 依赖文件

| 文件 | 用途 |
|------|------|
| `docs/Narrative-OS-Core-Architecture.md` | 唯一权威设计规格（5500+ 行） |
| `docs/phase*-development-plan.md` | 当前阶段的持久化开发计划 |
| `docs/core-development-log.md` | 开发日志（追加写入） |
| `CLAUDE.md` | 编码约定 + 开发纪律 |

## 可组合的子 Skill

在开发循环中，按需调用以下已有 skill 辅助：

| 时机 | Skill | 用途 |
|------|-------|------|
| 实现前 | `superpowers:test-driven-development` | 先写测试再写实现（红-绿循环） |
| 实现前 | `superpowers:writing-plans` | 复杂 Step 先拆子计划再动手 |
| 实现后 | `superpowers:verification-before-completion` | 跑验证命令，证据先于断言 |
| 完成后 | `superpowers:requesting-code-review` | 自我审查实现质量 |
| 遇到 bug | `superpowers:systematic-debugging` | 系统化定位，不猜测 |
| 多文件修改 | `superpowers:subagent-driven-development` | 并行实现独立子任务 |

## 执行流程

### 第一步：初始化上下文

```
1. 读取 CLAUDE.md（编码约定 + 开发纪律）
2. 确定当前阶段：
   a. 如果 goal 包含 "Phase X"，使用对应阶段的 plan 文件
   b. 否则查找 docs/ 下最新的 phase*-development-plan.md
3. 读取计划文件，找到第一个 ⬜ 状态的 Step
   （如果用户指定了 step 参数，跳到对应 Step）
4. 读取该 Step 的"架构文档对照"中引用的 Architecture 文档章节
5. 向用户简要报告即将开始的 Step 和目标
```

### 第二步：开发循环（每个 Step 重复）

```
┌─────────────────────────────────────────────────┐
│  2a. 读规格                                      │
│      读取 Architecture 文档中对应章节的完整内容    │
│      理解接口定义、不变式、状态机、数据流           │
│                                                   │
│  2b. 设计决策                                     │
│      如果 Step 有多种实现路径，先列出方案并选择     │
│      记录"为什么选 A 而非 B"                       │
│                                                   │
│  2c. 实现（TDD）                                  │
│      调用 superpowers:test-driven-development     │
│      先写失败测试 → 写最小实现 → 测试通过          │
│                                                   │
│  2d. 验证                                        │
│      调用 superpowers:verification-before-completion│
│      - npm run typecheck                          │
│      - npm test（全量，确认无回归）                 │
│      - 新测试覆盖了 Step 的验收条件                 │
│                                                   │
│  2e. 交叉核对                                    │
│      对照 Architecture 文档，逐项检查：             │
│      - 接口签名是否与文档一致                      │
│      - 不变式是否被遵守（I-9/I-10 等）             │
│      - 数据流是否符合 §10.1 描述                   │
│      - 状态机转换是否与 §6.2.1 一致                │
│      如有偏差，立即修正代码                        │
│                                                   │
│  2f. 记录                                       │
│      更新 docs/core-development-log.md：           │
│      - 目标、触达层级、设计决策                    │
│      - 变更文件列表                               │
│      - 验证结果（typecheck + test 数量）           │
│      - 剩余风险 / 下一依赖                        │
│                                                   │
│  2g. 更新计划                                    │
│      在 phase*-development-plan.md 中：            │
│      - 将 Step 状态改为 ✅ 已完成                   │
│      - 勾选所有验收条件的复选框                     │
│                                                   │
│  2h. 报告                                       │
│      向用户展示：                                 │
│      - 完成了什么                                 │
│      - 验证结果                                   │
│      - 下一步是什么                               │
│      如果 max_steps > 1，询问是否继续下一个 Step    │
└─────────────────────────────────────────────────┘
```

### 第三步：阶段完成检查

当一个 Phase 的所有 Step 都标记为 ✅ 时：

```
1. 运行全量 npm test，确认所有测试通过
2. 对照 Architecture 文档的 Phase 定义（附录 C），检查是否满足阶段验收标准
3. 汇总该 Phase 的开发日志
4. 建议用户创建下一个 Phase 的 development-plan.md
```

## 关键纪律

1. **每步必须回头看**：完成 2c 后立即做 2d+2e，不允许连续实现多个 Step 再统一验证
2. **证据先于断言**：不说"应该没问题"，必须贴出 typecheck 和 test 的实际输出
3. **架构文档是法官**：代码与文档不一致时，要么改代码，要么明确提出需要修改文档的理由
4. **测试是安全网**：任何修改后必须全量测试通过。新增逻辑必须有对应测试
5. **日志不可省略**：每个 Step 完成后必须更新 dev-log，这是可追溯性的基础

## 异常处理

| 情况 | 处理方式 |
|------|----------|
| 测试失败 | 不跳过。调用 `systematic-debugging` 定位并修复 |
| 架构文档与代码冲突 | 停下来向用户报告冲突点，说明两种选择的影响 |
| Step 拆分过粗 | 调用 `writing-plans` 拆成更小的子 Step |
| 不确定设计选择 | 向用户简要说明选项，请求裁决 |
| npm test 回归 | 立即定位引入回归的变更，修复后再继续 |

## 使用示例

```
# 用户触发方式：
自主开发，目标是 Phase 2C
自主开发 Phase 2C
goal: Phase 2C Step 2C-3
按计划开发
继续开发下一个 Step
```
