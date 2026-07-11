// /api/relations HTTP 封装——关系提示/候选/创作关联（里程碑④a）
import axios from 'axios';

const http = axios.create({ baseURL: '/api' });

/** 一步创建关系（createCandidate + submit，生成待确认决策） */
export async function createRelation(
  projectId: string,
  input: {
    sourceEntityId: string;
    targetEntityId: string;
    relationTypeId: string;
    layer?: string;
    direction?: string;
    strength?: number;
  },
): Promise<{ success: boolean; candidateId: string; proposalViewId?: string; isSafe?: boolean }> {
  const { data } = await http.post(`/projects/${projectId}/relations`, input);
  return data;
}

/** 确认关系提交（写进 Core） */
export async function confirmRelation(
  projectId: string,
  relationId: string,
  proposalViewId: string,
): Promise<{ success: boolean; coreEventId?: string }> {
  const { data } = await http.post(`/projects/${projectId}/relations/${relationId}/confirm`, { proposalViewId });
  return data;
}

/** 废弃关系候选 */
export async function deprecateRelation(projectId: string, id: string): Promise<void> {
  await http.post(`/projects/${projectId}/relations/${id}/deprecate`);
}

/** 创建创作关联（不进 Core） */
export async function createAssociation(
  projectId: string,
  input: {
    sourceObjectId: string; targetObjectId: string;
    sourceObjectType?: string; targetObjectType?: string;
    label: string; kind?: string;
  },
): Promise<unknown> {
  const { data } = await http.post(`/projects/${projectId}/associations`, input);
  return data;
}
