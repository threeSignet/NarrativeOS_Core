// =============================================================================
// FactRenderer —— 结构化事实 → LLM 可读 Markdown 渲染层
// =============================================================================
// Phase 3 核心产出。将 FactStore/ThreadStore/KnowledgeStore 中的结构化数据
// 渲染为 LLM 可读的 Markdown 文本，包含实体档案、线索清单、审计报告、知识视角。
//
// 设计原则：
//   - 单向输出：只负责渲染，不解析输入（与已删除的 WikiParser 职责分离）
//   - 实体名映射：通过 entityNames 将 ent_* ID 转为可读中文名
//   - EntityRef 渲染：{ type: 'entity_ref', entityId: 'ent_lisi' } → 李四（ent_lisi）
//   - 关系方向：subject = 实体自身 → 主动；subject ≠ 实体 → 被动
//   - 线索超期：回溯型线索 currentChapter - (createdAtChapter + withinChapters) 计算超期章数
//
// 与架构文档的对应关系：
//   §8.1 定位           → 单向输出层，原 WikiRenderer 重命名
//   §8.2 接口           → 5 个渲染方法
//   §8.3 输出示例       → renderEntityProfile Markdown 格式
//   §8.4 输出示例       → renderSimulationReport Markdown 格式
// =============================================================================

import type {
  Fact,
  FactValue,
  NarrativeThread,
  Knowledge,
  EventConsequence,
  RelevantFactSet,
} from '../types.js';

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 尝试将 FactValue 渲染为可读字符串
 *
 * EntityRef → "实体名（ent_id）"
 * 标量 → String(value)
 */
function formatFactValue(value: FactValue, entityNames: Record<string, string>): string {
  if (isEntityRef(value)) {
    const name = entityNames[value.entityId] ?? value.entityId;
    return `${name}（${value.entityId}）`;
  }
  return String(value);
}

/**
 * 判断 FactValue 是否为 EntityRef
 */
function isEntityRef(value: FactValue): value is { type: 'entity_ref'; entityId: string } {
  return typeof value === 'object' && value !== null && (value as any).type === 'entity_ref';
}

/**
 * Severity → 视觉标签映射
 */
function severityTag(severity: string): string {
  switch (severity) {
    case 'critical': return '🔴';
    case 'major': return '🟡';
    case 'minor': return '⚪';
    default: return '⚪';
  }
}

/**
 * 确信度 → 中文分组标签
 */
function confidenceGroup(confidence: number): string {
  if (confidence >= 1.0) return '完全确定';
  if (confidence >= 0.8) return '高度确信';
  return '不确定';
}

/**
 * 计算回溯型线索的超期章数
 * 返回负数 = 未超期（还有 N 章余量），正数 = 已超期 N 章
 */
function chaptersOverdue(thread: NarrativeThread, currentChapter: number): number {
  if (thread.direction !== 'retroactive') return -1;
  if (!thread.closeCondition.withinChapters) return -1;
  const deadline = thread.createdAtChapter + thread.closeCondition.withinChapters;
  return currentChapter - deadline;
}

/**
 * 统计渐进型线索的暗示次数
 */
function countHints(thread: NarrativeThread): number {
  return thread.milestones.filter(m => m.status === 'HINTED').length;
}

// ---------------------------------------------------------------------------
// FactRenderer
// ---------------------------------------------------------------------------

export class FactRenderer {
  // =========================================================================
  // renderEntityProfile：实体完整档案
  // =========================================================================

  /**
   * 渲染实体完整档案
   *
   * 格式对齐架构文档 §8.3 输出示例：
   *   ## 实体名（ent_id）档案 · 第N章视角
   *   ### 核心属性
   *   ### 关系
   *   ### 📋 未关闭叙事线索
   */
  renderEntityProfile(
    entityId: string,
    snapshot: Record<string, FactValue>,
    relations: Fact[],
    openThreads: NarrativeThread[],
    atChapter: number,
    entityNames: Record<string, string>,
  ): string {
    const entityName = entityNames[entityId] ?? entityId;
    const lines: string[] = [];

    // 标题
    lines.push(`## ${entityName}（${entityId}）档案 · 第${atChapter}章视角`);
    lines.push('');

    // ---- 核心属性 ----
    lines.push('### 核心属性');
    lines.push('');
    const predicates = Object.keys(snapshot);
    if (predicates.length === 0) {
      lines.push('*（暂无记录）*');
      lines.push('');
    } else {
      for (const predicate of predicates) {
        const value = snapshot[predicate]!;
        const rendered = formatFactValue(value, entityNames);
        lines.push(`* ${predicate}：${rendered}`);
      }
      lines.push('');
    }

    // ---- 关系 ----
    if (relations.length > 0) {
      lines.push('### 关系');
      lines.push('');
      for (const rel of relations) {
        const isOutgoing = rel.subject === entityId; // 实体自身是主体 → 主动
        const otherEntityId = isOutgoing
          ? (isEntityRef(rel.value) ? rel.value.entityId : String(rel.value))
          : rel.subject;
        const otherName = entityNames[otherEntityId] ?? otherEntityId;
        const direction = isOutgoing ? '→' : '←';
        const relationDesc = isOutgoing
          ? `${entityName} ${rel.predicate} ${otherName}`
          : `${otherName} ${rel.predicate} ${entityName}`;
        lines.push(`* ${direction} ${relationDesc}（${otherEntityId}）← ${rel.causeEvent}（第${rel.validFrom}章）`);
      }
      lines.push('');
    }

    // ---- 未关闭叙事线索 ----
    if (openThreads.length > 0) {
      lines.push('### 📋 未关闭叙事线索');
      lines.push('');
      for (const thread of openThreads) {
        const tag = severityTag(thread.severity);
        const overdue = chaptersOverdue(thread, atChapter);

        lines.push(`* ${tag} [${thread.severity}] ${thread.id}：${thread.description}`);

        // 回溯型：显示截止条件
        if (thread.direction === 'retroactive' && thread.closeCondition.withinChapters) {
          const deadline = thread.createdAtChapter + thread.closeCondition.withinChapters;
          const reqTypeStr = thread.closeCondition.requiredEventType
            ? `\`${thread.closeCondition.requiredEventType}\` 类型事件 | `
            : '';
          const overdueStr = overdue > 0
            ? ` **已超期${overdue}章**`
            : ` 剩余${-overdue}章`;
          const minHintsStr = thread.closeCondition.minHints
            ? ` | 至少暗示${thread.closeCondition.minHints}次`
            : '';
          lines.push(`  填补条件：${reqTypeStr}截止第${deadline}章${minHintsStr}${overdueStr}`);
        }

        // 渐进型：显示暗示进度
        if (thread.direction === 'progressive') {
          const hints = countHints(thread);
          const minHints = thread.closeCondition.minHints ?? 0;
          if (minHints > 0) {
            lines.push(`  暗示进度：${hints}/${minHints}（状态：${thread.status}）`);
          } else {
            lines.push(`  状态：${thread.status}`);
          }
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // =========================================================================
  // renderThreadSummary：叙事线索清单
  // =========================================================================

  /**
   * 渲染叙事线索清单
   *
   * 回溯型/渐进型分组展示，标注超期状态和 severity 标签。
   */
  renderThreadSummary(threads: NarrativeThread[], currentChapter: number): string {
    if (threads.length === 0) {
      return '暂无未关闭的叙事线索。';
    }

    const lines: string[] = [];
    lines.push('## 📋 叙事线索清单');
    lines.push('');

    const retroactive = threads.filter(t => t.direction === 'retroactive');
    const progressive = threads.filter(t => t.direction === 'progressive');

    // ---- 回溯型线索 ----
    if (retroactive.length > 0) {
      lines.push('### 回溯型线索（先写结果，后补原因）');
      lines.push('');
      for (const t of retroactive) {
        const tag = severityTag(t.severity);
        const overdue = chaptersOverdue(t, currentChapter);
        const overdueStr = overdue > 0 ? ` **已超期${overdue}章**` : '';
        const deadline = t.closeCondition.withinChapters
          ? `截止第${t.createdAtChapter + t.closeCondition.withinChapters}章`
          : '无限期';
        const reqType = t.closeCondition.requiredEventType
          ? `需 \`${t.closeCondition.requiredEventType}\` 类型事件`
          : '';
        lines.push(`* ${tag} \`${t.id}\` ${t.description}`);
        lines.push(`  ${reqType} | ${deadline}${overdueStr} | 状态：${t.status}`);
      }
      lines.push('');
    }

    // ---- 渐进型线索 ----
    if (progressive.length > 0) {
      lines.push('### 渐进型线索（先埋种子，后开花）');
      lines.push('');
      for (const t of progressive) {
        const tag = severityTag(t.severity);
        const hints = countHints(t);
        const minHints = t.closeCondition.minHints;
        const progress = minHints ? `暗示 ${hints}/${minHints}` : `状态：${t.status}`;
        lines.push(`* ${tag} \`${t.id}\` ${t.description}`);
        lines.push(`  ${progress} | 埋种子第${t.createdAtChapter}章`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // =========================================================================
  // renderSimulationReport：推演审计报告
  // =========================================================================

  /**
   * 渲染推演审计报告
   *
   * 格式对齐架构文档 §8.4 输出示例。
   */
  renderSimulationReport(
    proposalId: string,
    consequences: EventConsequence,
    isSafe: boolean,
  ): string {
    const lines: string[] = [];
    const statusText = isSafe ? 'SAFE_TO_COMMIT' : 'UNSAFE_TO_COMMIT';
    const statusNote = isSafe && consequences.warnings.length > 0 ? '（含警告）' : '';

    lines.push(`## 推演报告 · ${proposalId}`);
    lines.push('');
    lines.push(`**状态**：${statusText}${statusNote}`);
    lines.push('');

    // ---- 新产生的事实 ----
    lines.push('### 新产生的事实');
    lines.push('');
    const newFacts = consequences.generatedFacts ?? [];
    if (newFacts.length === 0) {
      lines.push('（无）');
      lines.push('');
    } else {
      for (const f of newFacts) {
        lines.push(`* ${f.subject} ${f.predicate} = ${formatFactValue(f.value, {})} ← ${f.causeEvent}（第${f.validFrom}章）`);
      }
      lines.push('');
    }

    // ---- 产生的叙事线索 ----
    lines.push('### 产生的叙事线索');
    lines.push('');
    const threads = consequences.generatedThreads ?? [];
    if (threads.length === 0) {
      lines.push('（无）');
      lines.push('');
    } else {
      for (const t of threads) {
        const tag = severityTag(t.severity);
        lines.push(`* ${tag} [${t.severity}] ${t.id}：${t.description}`);
      }
      lines.push('');
    }

    // ---- 推理规则产生的附带事实 ----
    const inferredFacts = (consequences.generatedFacts ?? []).filter(
      f => f.certainty === 'potential'
    );
    if (inferredFacts.length > 0) {
      lines.push('### 推理规则产生的附带事实');
      lines.push('');
      for (const f of inferredFacts) {
        lines.push(`* \`${f.id}\` ${f.subject} ${f.predicate} = ${formatFactValue(f.value, {})}（将随主 FactGroup 提升为 canonical）`);
      }
      lines.push('');
    }

    // ---- 警告 ----
    if (consequences.warnings.length > 0) {
      lines.push('### ⚠️ 警告');
      lines.push('');
      for (const w of consequences.warnings) {
        lines.push(`* ${w}`);
      }
      lines.push('');
    }

    // ---- 操作建议 ----
    lines.push('### 操作建议');
    lines.push('');
    if (isSafe) {
      lines.push(`确认无误后调用 \`commit_event\`，传入 \`proposal_id = "${proposalId}"\`。`);
    } else {
      lines.push('请修正上述警告中的问题后重新 `propose_event`。');
    }
    lines.push('');

    return lines.join('\n');
  }

  // =========================================================================
  // renderKnowledgePerspective：角色知识视角
  // =========================================================================

  /**
   * 渲染角色在指定章节的知识视角
   *
   * 按确信度分组：完全确定(1.0) / 高度确信(0.8-0.99) / 不确定(<0.8)
   */
  renderKnowledgePerspective(
    entityId: string,
    knowledge: Knowledge[],
    facts: Fact[],
    atChapter: number,
    entityNames: Record<string, string>,
  ): string {
    const entityName = entityNames[entityId] ?? entityId;
    const lines: string[] = [];

    lines.push(`## ${entityName}（${entityId}）的知识视角 · 第${atChapter}章`);
    lines.push('');

    if (knowledge.length === 0) {
      lines.push('*该角色当前无确定认知。*');
      lines.push('');
      return lines.join('\n');
    }

    // 构建 factId → Fact 映射
    const factMap = new Map<string, Fact>();
    for (const f of facts) {
      factMap.set(f.id, f);
    }

    // 按确信度分组
    const groups = new Map<string, Array<{ knowledge: Knowledge; fact: Fact | undefined }>>();
    for (const k of knowledge) {
      const group = confidenceGroup(k.confidence);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push({ knowledge: k, fact: factMap.get(k.factId) });
    }

    const groupOrder = ['完全确定', '高度确信', '不确定'];
    for (const group of groupOrder) {
      const entries = groups.get(group);
      if (!entries || entries.length === 0) continue;

      lines.push(`### ${group}`);
      lines.push('');

      for (const { knowledge: k, fact } of entries) {
        const factDesc = fact
          ? `${fact.subject}.${fact.predicate}=${String(fact.value)}`
          : `Fact ${k.factId}`;
        const sourceLabel = k.source;
        lines.push(`* ${factDesc}`);
        lines.push(`  - 来源：${sourceLabel} | 确信度：${k.confidence} | 已知自第${k.knownSince}章`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // =========================================================================
  // renderRelevantFacts：相关 Fact 集合摘要
  // =========================================================================

  /**
   * 渲染语义检索注入 LLM 上下文前的 Fact 集合
   */
  renderRelevantFacts(
    factSet: RelevantFactSet,
    entityNames: Record<string, string>,
  ): string {
    const hasContent =
      Object.keys(factSet.entitySnapshots).length > 0 ||
      factSet.entityRelations.length > 0 ||
      factSet.semanticFacts.length > 0 ||
      factSet.openThreads.length > 0;

    if (!hasContent) return '';

    const lines: string[] = [];
    lines.push('## 相关世界状态');
    lines.push('');

    // ---- 核心实体属性 ----
    const snapshotEntries = Object.entries(factSet.entitySnapshots);
    if (snapshotEntries.length > 0) {
      lines.push('### 核心实体属性');
      lines.push('');
      for (const [entityId, snapshot] of snapshotEntries) {
        const name = entityNames[entityId] ?? entityId;
        lines.push(`**${name}（${entityId}）**`);
        for (const [predicate, value] of Object.entries(snapshot as Record<string, FactValue>)) {
          const rendered = formatFactValue(value as FactValue, entityNames);
          lines.push(`* ${predicate}：${rendered}`);
        }
        lines.push('');
      }
    }

    // ---- 实体关系 ----
    if (factSet.entityRelations.length > 0) {
      lines.push('### 相关关系');
      lines.push('');
      for (const rel of factSet.entityRelations) {
        const subjName = entityNames[rel.subject] ?? rel.subject;
        const valueRendered = formatFactValue(rel.value, entityNames);
        lines.push(`* ${subjName} ${rel.predicate} ${valueRendered} ← ${rel.causeEvent}`);
      }
      lines.push('');
    }

    // ---- 语义检索相关 Fact ----
    if (factSet.semanticFacts.length > 0) {
      lines.push('### 语义相关设定');
      lines.push('');
      for (const f of factSet.semanticFacts) {
        const subjName = entityNames[f.subject] ?? f.subject;
        const valueRendered = formatFactValue(f.value, entityNames);
        lines.push(`* ${subjName} ${f.predicate}：${valueRendered} ← ${f.causeEvent}（第${f.validFrom}章）`);
      }
      lines.push('');
    }

    // ---- 活跃线索 ----
    if (factSet.openThreads.length > 0) {
      lines.push('### ⚠️ 活跃叙事线索');
      lines.push('');
      for (const t of factSet.openThreads) {
        const tag = severityTag(t.severity);
        lines.push(`* ${tag} \`${t.id}\` ${t.description}（状态：${t.status}）`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}
