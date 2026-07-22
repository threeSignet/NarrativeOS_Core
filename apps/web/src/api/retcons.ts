// /api/retcons HTTP 封装——Retcon 影响报告只读查看器（迭代 D4）
import axios from 'axios';
const http = axios.create({ baseURL: '/api' });

export type RetconReportStatus = 'pending' | 'confirmed' | 'rejected' | 'superseded';
export type RetconAffectedKind = 'fact' | 'thread' | 'knowledge' | 'entity' | 'event' | 'timeline_item' | 'spatial_node' | 'foreshadowing_plan';
export type RetconAffectedEffect = 'invalidated' | 'contested' | 'replaced' | 'rederived' | 'needs_recheck';

export interface RetconAffectedNode {
  kind: RetconAffectedKind; id: string; label: string;
  effect: RetconAffectedEffect; reason?: string;
}
export interface RetconAffectedEdge {
  sourceNodeId: string; targetNodeId: string; kind: string; label?: string;
}
export interface RecheckItem {
  targetType: string; targetId: string; label: string; reason: string;
}
export interface RetconImpactReport {
  id: string; projectId: string; retconProposalId: string;
  status: RetconReportStatus;
  affectedNodes: RetconAffectedNode[];
  affectedEdges: RetconAffectedEdge[];
  recheckList: RecheckItem[];
  summary: string;
  createdAt: string; confirmedAt?: string;
}

export const STATUS_LABELS: Record<RetconReportStatus, string> = {
  pending: '待确认', confirmed: '已确认', rejected: '已拒绝', superseded: '已覆盖',
};
export const STATUS_COLORS: Record<RetconReportStatus, string> = {
  pending: 'var(--st-candidate)', confirmed: 'var(--success)', rejected: 'var(--danger)', superseded: 'var(--text-3)',
};
export const KIND_LABELS: Record<RetconAffectedKind, string> = {
  fact: '事实', thread: '线索', knowledge: '认知', entity: '实体', event: '事件',
  timeline_item: '时间线', spatial_node: '空间', foreshadowing_plan: '伏笔计划',
};
export const EFFECT_LABELS: Record<RetconAffectedEffect, string> = {
  invalidated: '已失效', contested: '有争议', replaced: '已替换', rederived: '需重推导', needs_recheck: '需重检',
};
export const EFFECT_COLORS: Record<RetconAffectedEffect, string> = {
  invalidated: 'var(--danger)', contested: 'var(--warning)', replaced: 'var(--st-draft)',
  rederived: 'var(--accent)', needs_recheck: 'var(--st-hint)',
};

// ---- HTTP ----

export async function listRetcons(projectId: string): Promise<RetconImpactReport[]> {
  const { data } = await http.get<RetconImpactReport[]>(`/projects/${projectId}/retcons`);
  return data;
}

export async function getRetcon(projectId: string, id: string): Promise<RetconImpactReport> {
  const { data } = await http.get<RetconImpactReport>(`/projects/${projectId}/retcons/${id}`);
  return data;
}

export async function updateRetconStatus(projectId: string, id: string, status: RetconReportStatus): Promise<RetconImpactReport> {
  const { data } = await http.post<RetconImpactReport>(`/projects/${projectId}/retcons/${id}/status`, { status });
  return data;
}
