// =============================================================================
// Phase 12 · RetconViewService——Retcon 影响报告的业务逻辑（§10.5/§19.4）
// =============================================================================
// 职责：
//   - 从 Core propose_retcon 的结果（RetconProposal）投影出写作层影响报告
//   - 标记受影响的 Fact/Thread/Knowledge/Entity/Event + 写作层对象重检项
//   - 报告状态推进（pending→confirmed/rejected）
//
// 核心不变式（Feature-Spec §10.5）：
//   - Retcon 影响图不等于已修改状态（确认前只读，不改变正式图谱）
//   - 作者能看见 Thread / Knowledge 影响
//   - 提交前不改变正式图谱
//   - 写作层重检项可追踪
//   - 本 service 不调 Core commit（确认由 CoreBridge.commitReviewedRetcon 负责）
//
// 与 ChapterService 范式一致：构造注入 store + audit，方法首参 ctx，更新记审计。
// =============================================================================

import type { SQLiteWritingStore } from '../repositories/writing-store.js';
import type { AuditService } from './audit-service.js';
import type { WritingRequestContext } from './context.js';
import { WritingError, WritingErrorCode } from '../errors/error-codes.js';
import type {
  RetconImpactReport, RetconReportStatus,
  RetconAffectedNode, RetconAffectedEdge, WritingArtifactRecheckItem,
  RevisionTargetType,
} from '../models/types.js';

/**
 * Core propose_retcon 返回的精简投影输入。
 * 写作层不直接依赖 RetconProposal 类型（避免跨层耦合），由调用方提取关键字段传入。
 */
export interface RetconProposalProjection {
  proposalId: string;
  affectedFactIds: string[];
  affectedEventIds: string[];
  /** 受影响的 Thread ID（从 cascadeResult 或 proposal 提取，可能为空） */
  affectedThreadIds?: string[];
  /** 受影响的 Knowledge 实体 ID（可能为空） */
  affectedKnowledgeEntityIds?: string[];
  /** Core 生成的级联报告 Markdown（原文展示） */
  cascadeReportMarkdown?: string;
}

export class RetconViewService {
  constructor(
    private store: SQLiteWritingStore,
    private audit: AuditService,
  ) {}

  /**
   * 构建 Retcon 影响报告并落库（pending 态）。
   * 调用时机：Core propose_retcon 成功后，作者确认前。
   * §10.5 验收：提交前不改变正式图谱——本方法只写写作层报告，不调 Core commit。
   */
  buildRetconImpactReport(
    ctx: WritingRequestContext,
    projection: RetconProposalProjection,
  ): RetconImpactReport {
    const affectedNodes = this.projectAffectedNodes(projection);
    const affectedEdges = this.projectAffectedEdges(affectedNodes);
    const recheckList = this.buildRecheckList(ctx, projection);
    const summary = this.buildSummary(projection, affectedNodes);

    const report = this.store.createRetconReport(ctx.projectId, {
      retconProposalId: projection.proposalId,
      affectedNodes, affectedEdges, recheckList, summary,
    });

    this.audit.record(ctx, {
      action: 'create_retcon_report', targetType: 'retcon_report',
      targetId: report.id, result: 'success',
      detail: {
        retconProposalId: projection.proposalId,
        affectedNodeCount: affectedNodes.length,
        recheckCount: recheckList.length,
      },
    });
    return report;
  }

  /** 获取指定报告 */
  getReport(ctx: WritingRequestContext, id: string): RetconImpactReport {
    const report = this.store.getRetconReport(id);
    if (!report) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `Retcon 影响报告不存在: ${id}`);
    if (report.projectId !== ctx.projectId) throw new WritingError(WritingErrorCode.WRITING_OBJECT_NOT_FOUND, `报告不属于当前项目: ${id}`);
    return report;
  }

  /** 按 Core proposal id 查最新报告（一个 proposal 可能多次 build，取最新） */
  getReportByProposal(retconProposalId: string): RetconImpactReport | undefined {
    return this.store.getRetconReportByProposal(retconProposalId);
  }

  /** 列出项目所有报告（按时间倒序） */
  listReports(ctx: WritingRequestContext): RetconImpactReport[] {
    return this.store.listRetconReports(ctx.projectId);
  }

  /** 推进报告状态（作者确认/拒绝/作废） */
  updateReportStatus(
    ctx: WritingRequestContext,
    id: string,
    status: RetconReportStatus,
  ): void {
    this.getReport(ctx, id); // 校验归属
    this.store.updateRetconReportStatus(id, status);
    this.audit.record(ctx, {
      action: 'update_retcon_report_status', targetType: 'retcon_report',
      targetId: id, result: 'success', detail: { status },
    });
  }

  // -------------------------------------------------------------------------
  // 投影逻辑：Core Fact/Event/Thread/Knowledge → 受影响节点 + 重检项
  // -------------------------------------------------------------------------

  /** 把 Core 受影响 ID 投影为作者可读的受影响节点 */
  private projectAffectedNodes(projection: RetconProposalProjection): RetconAffectedNode[] {
    const nodes: RetconAffectedNode[] = [];
    // Fact：争议化（retcon 会让旧 Fact 失效/争议）
    for (const fid of projection.affectedFactIds) {
      nodes.push({ kind: 'fact', id: fid, label: fid, effect: 'contested', reason: '回溯变更导致此事实需要重新裁决' });
    }
    // Event：需重检
    for (const eid of projection.affectedEventIds) {
      nodes.push({ kind: 'event', id: eid, label: eid, effect: 'needs_recheck', reason: '下游事件依赖被回溯的事件' });
    }
    // Thread：失效风险（reactivated 或依赖受影响 Fact）
    for (const tid of projection.affectedThreadIds ?? []) {
      nodes.push({ kind: 'thread', id: tid, label: tid, effect: 'invalidated', reason: '线索依赖的事实被回溯' });
    }
    // Knowledge：需重检（谁知道什么可能因 Fact 变化而失效）
    for (const eid of projection.affectedKnowledgeEntityIds ?? []) {
      nodes.push({ kind: 'knowledge', id: eid, label: eid, effect: 'needs_recheck', reason: '相关实体的认知状态可能失效' });
    }
    return nodes;
  }

  /** 受影响节点间的关联边（简化：fact→event、event→thread 因果链） */
  private projectAffectedEdges(nodes: RetconAffectedNode[]): RetconAffectedEdge[] {
    const edges: RetconAffectedEdge[] = [];
    const facts = nodes.filter(n => n.kind === 'fact');
    const events = nodes.filter(n => n.kind === 'event');
    // 每个 event 关联到所有受影响 fact（粗粒度因果链，作者可展开看细节）
    for (const ev of events) {
      for (const f of facts) {
        edges.push({ sourceNodeId: f.id, targetNodeId: ev.id, kind: 'causes', label: '因果' });
      }
    }
    return edges;
  }

  /**
   * 写作层对象重检项：retcon 影响的实体/事实，关联的伏笔计划/线索/时间线条目需重新检查。
   * §10.5 WritingArtifactRecheckList——保守策略：所有受影响 fact 关联的伏笔计划都进入重检。
   */
  private buildRecheckList(ctx: WritingRequestContext, projection: RetconProposalProjection): WritingArtifactRecheckItem[] {
    const items: WritingArtifactRecheckItem[] = [];
    // 伏笔计划：若其关联实体在受影响集合，需重检
    const foreshadowingPlans = this.store.listForeshadowingPlans(ctx.projectId);
    const affectedEntityIds = new Set(projection.affectedKnowledgeEntityIds ?? []);
    for (const fp of foreshadowingPlans) {
      // listForeshadowingPlans 返回 raw 行（linked_entity_refs_json 未映射为 linkedEntityRefs），
      // 这里用类型擦除读取原始 JSON 字段，避免改动 Phase 11 的 store 映射签名引发回归。
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawRow = fp as any;
      const rawJson: string = rawRow.linked_entity_refs_json ?? rawRow.linkedEntityRefs;
      let linkedEntities: string[] = [];
      try { linkedEntities = typeof rawJson === 'string' ? JSON.parse(rawJson) : (Array.isArray(rawJson) ? rawJson : []); } catch { linkedEntities = []; }
      const hit = linkedEntities.some((ref: string) => affectedEntityIds.has(ref));
      if (hit) {
        items.push({
          targetType: 'foreshadowing_plan' as RevisionTargetType,
          targetId: fp.id,
          label: fp.label,
          reason: '关联实体的认知状态因回溯变更可能失效',
        });
      }
    }
    // 时间线条目：受影响事件对应的 timeline 条目需重检（粗粒度提示）
    if (projection.affectedEventIds.length > 0) {
      items.push({
        targetType: 'other' as RevisionTargetType,
        targetId: projection.affectedEventIds.join(','),
        label: `${projection.affectedEventIds.length} 个下游事件`,
        reason: '依赖被回溯事件的下游事件需重新检查时间线一致性',
      });
    }
    return items;
  }

  private buildSummary(projection: RetconProposalProjection, nodes: RetconAffectedNode[]): string {
    const factCount = projection.affectedFactIds.length;
    const eventCount = projection.affectedEventIds.length;
    const threadCount = (projection.affectedThreadIds ?? []).length;
    const parts: string[] = [];
    if (factCount > 0) parts.push(`${factCount} 个事实`);
    if (eventCount > 0) parts.push(`${eventCount} 个下游事件`);
    if (threadCount > 0) parts.push(`${threadCount} 个线索`);
    const subject = parts.length > 0 ? parts.join('、') : '无直接受影响项';
    return `回溯变更 ${projection.proposalId} 将影响：${subject}（共 ${nodes.length} 个受影响节点）。确认前不改变正式世界状态。`;
  }
}
