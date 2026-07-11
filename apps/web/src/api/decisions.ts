// /api/decisions HTTP 封装——待确认决策（里程碑③）
import axios from 'axios';

const http = axios.create({ baseURL: '/api' });

/** 待确认决策项（镜像后端 PendingDecisionItem 子集） */
export interface PendingDecision {
  id: string;
  kind: 'confirm_entity' | 'confirm_draft' | 'confirm_proposal' | 'confirm_retcon' | 'confirm_blueprint' | 'confirm_rule' | 'general';
  title: string;
  description?: string;
  linkedObjectId?: string;
  linkedObjectType?: string;
  status: 'open' | 'resolved' | 'dismissed' | 'expired';
}

/** 列出待确认决策 */
export async function listDecisions(projectId: string): Promise<PendingDecision[]> {
  const { data } = await http.get<PendingDecision[]>(`/projects/${projectId}/decisions`);
  return data;
}

/** 解决决策（confirm_entity + resolve → 触发注册进 Core） */
export async function resolveDecision(
  projectId: string,
  id: string,
  action: 'resolve' | 'dismiss' = 'resolve',
  note?: string,
): Promise<{ success: boolean; coreEntityId?: string }> {
  const { data } = await http.post(`/projects/${projectId}/decisions/${id}/resolve`, { action, note });
  return data;
}
