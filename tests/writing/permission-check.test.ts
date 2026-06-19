// =============================================================================
// W2：权限矩阵单元测试（AGENT_PERMISSIONS + assertAgentMayCall）
// =============================================================================
// 纯函数测试——不实例化 Agent/Core/LLM。验证 §8.3.2 矩阵的 9 处修正（重命名/删幽灵/新增）、
// COMMIT_FORBIDDEN 集合完备性、assertAgentMayCall 的 caller-tagged 豁免与抛错语义。
// 范式对齐 tool-permissions.test.ts。
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  AGENT_PERMISSIONS,
  AgentCapability,
  assertAgentMayCall,
  AUTHOR_CONFIRM_CHANNEL,
} from '../../src/writing/agent/permission-check.js';
import { WritingError, WritingErrorCode } from '../../src/writing/errors/error-codes.js';

/** 取某能力下的全部方法名 */
function methodsOf(cap: AgentCapability): string[] {
  return Object.entries(AGENT_PERMISSIONS)
    .filter(([, c]) => c === cap)
    .map(([k]) => k);
}

describe('W2 · AGENT_PERMISSIONS 权限矩阵', () => {
  describe('COMMIT_FORBIDDEN 集合（Agent 自动路径绝对不能调用）', () => {
    const forbidden = methodsOf(AgentCapability.COMMIT_FORBIDDEN);
    // 逐一断言关键禁止方法在集合内——这些是作者确认通道经 caller 豁免、裸路径必被拦的方法
    it.each([
      'CoreBridgeService.commitReviewedProposal',
      'CoreBridgeService.registerReviewedEntity',
      'WorkflowService.resolvePendingDecision',
      'ProjectService.setWorkspaceMode',
      'ProjectService.archiveProject',
      'ProjectService.transitionProjectStatus', // 新增（docstring 明确 COMMIT_FORBIDDEN）
      'BlueprintService.acceptBlueprintDraft',
      'BlueprintService.acceptBlueprintChange',
    ])('%s 为 COMMIT_FORBIDDEN', (m) => {
      expect(forbidden).toContain(m);
    });
  });

  describe('矩阵修正：spec 原表 3 个幽灵方法名已重命名为真实方法', () => {
    it('ProjectService.getProject（spec 误作 getProjectSettings）', () => {
      expect(AGENT_PERMISSIONS['ProjectService.getProject']).toBe(AgentCapability.READ_QUERY);
      // 旧幽灵名不得残留（否则矩阵与真实代码不符）
      expect(AGENT_PERMISSIONS['ProjectService.getProjectSettings']).toBeUndefined();
    });

    it('DraftService.getDraft（spec 误作 getDraftEditorView）', () => {
      expect(AGENT_PERMISSIONS['DraftService.getDraft']).toBe(AgentCapability.READ_QUERY);
      expect(AGENT_PERMISSIONS['DraftService.getDraftEditorView']).toBeUndefined();
    });

    it('EntityService.getEntitySketch（spec 误作 getEntityProfileView）', () => {
      expect(AGENT_PERMISSIONS['EntityService.getEntitySketch']).toBe(AgentCapability.READ_QUERY);
      expect(AGENT_PERMISSIONS['EntityService.getEntityProfileView']).toBeUndefined();
    });
  });

  describe('矩阵修正：5 个幽灵方法（代码中不存在）已从矩阵删除', () => {
    it.each([
      'DraftService._markCommitted',
      'EntityService._markRegistered',
      'CoreBridgeService.commitReviewedThreadChange',
      'CoreBridgeService.commitReviewedKnowledgeChange',
      'CoreBridgeService.commitReviewedWorldPackageChange',
    ])('%s 不在矩阵（避免给读者"存在此方法"的错误印象）', (m) => {
      expect(AGENT_PERMISSIONS[m]).toBeUndefined();
    });
  });

  describe('低层级能力（Agent 可调用，assert 不抛错）', () => {
    it('READ_QUERY 含修正后真名 + CoreBridge 只读', () => {
      expect(AGENT_PERMISSIONS['CoreBridgeService.readCurrentWorldSnapshot']).toBe(AgentCapability.READ_QUERY);
      expect(AGENT_PERMISSIONS['CoreBridgeService.explainCoreFailure']).toBe(AgentCapability.READ_QUERY);
    });
    it('CANDIDATE_WRITE / REVIEW_CREATE 各有代表条目', () => {
      expect(AGENT_PERMISSIONS['EntityService.approveCandidate']).toBe(AgentCapability.CANDIDATE_WRITE);
      expect(AGENT_PERMISSIONS['CoreBridgeService.simulateProposal']).toBe(AgentCapability.REVIEW_CREATE);
    });
    // BlueprintService accept/reject 权限不对称设计：reject 仅标 dismissed（不改蓝图结构）= LOW_RISK_WRITE，
    // accept 落地结构变更（加 entityType/relationType）= COMMIT_FORBIDDEN。锁定防回归。
    it('BlueprintService accept/reject 不对称：reject=LOW_RISK_WRITE（不改结构），accept=COMMIT_FORBIDDEN（改结构）', () => {
      expect(AGENT_PERMISSIONS['BlueprintService.rejectBlueprintChange']).toBe(AgentCapability.LOW_RISK_WRITE);
      expect(AGENT_PERMISSIONS['BlueprintService.acceptBlueprintChange']).toBe(AgentCapability.COMMIT_FORBIDDEN);
    });
  });
});

describe('W2 · assertAgentMayCall 强制语义', () => {
  describe('作者确认通道豁免', () => {
    it('AUTHOR_CONFIRM_CHANNEL 标记放行 commitReviewedProposal', () => {
      expect(() =>
        assertAgentMayCall('CoreBridgeService.commitReviewedProposal', { caller: AUTHOR_CONFIRM_CHANNEL }),
      ).not.toThrow();
    });
    it('AUTHOR_CONFIRM_CHANNEL 标记放行 registerReviewedEntity', () => {
      expect(() =>
        assertAgentMayCall('CoreBridgeService.registerReviewedEntity', { caller: AUTHOR_CONFIRM_CHANNEL }),
      ).not.toThrow();
    });
    it('AUTHOR_CONFIRM_CHANNEL 标记放行 resolvePendingDecision', () => {
      expect(() =>
        assertAgentMayCall('WorkflowService.resolvePendingDecision', { caller: AUTHOR_CONFIRM_CHANNEL }),
      ).not.toThrow();
    });
  });

  describe('裸路径（无 caller 标记）命中 COMMIT_FORBIDDEN → 抛错', () => {
    it('commitReviewedProposal → WritingError(AGENT_COMMIT_FORBIDDEN)', () => {
      try {
        assertAgentMayCall('CoreBridgeService.commitReviewedProposal');
        throw new Error('应抛错但未抛');
      } catch (e) {
        expect(e).toBeInstanceOf(WritingError);
        expect((e as WritingError).code).toBe(WritingErrorCode.AGENT_COMMIT_FORBIDDEN);
        // 错误消息含被禁方法名，便于定位
        expect((e as Error).message).toContain('commitReviewedProposal');
      }
    });

    it('registerReviewedEntity → WritingError(AGENT_REGISTER_FORBIDDEN)（区别于提交类）', () => {
      try {
        assertAgentMayCall('CoreBridgeService.registerReviewedEntity');
        throw new Error('应抛错但未抛');
      } catch (e) {
        expect(e).toBeInstanceOf(WritingError);
        // 激活原本无 throw 点的 AGENT_REGISTER_FORBIDDEN 死错误码
        expect((e as WritingError).code).toBe(WritingErrorCode.AGENT_REGISTER_FORBIDDEN);
      }
    });

    it('resolvePendingDecision / transitionProjectStatus → AGENT_COMMIT_FORBIDDEN', () => {
      for (const m of ['WorkflowService.resolvePendingDecision', 'ProjectService.transitionProjectStatus']) {
        try {
          assertAgentMayCall(m);
          throw new Error(`${m} 应抛错但未抛`);
        } catch (e) {
          expect((e as WritingError).code).toBe(WritingErrorCode.AGENT_COMMIT_FORBIDDEN);
        }
      }
    });
  });

  describe('不抛错的情形（防御性放行）', () => {
    it('未收录在矩阵的方法 → 放行（避免新 service 方法被误拦致回归）', () => {
      expect(() => assertAgentMayCall('SomeService.brandNewMethod')).not.toThrow();
    });
    it('低层级方法（READ/LOW_RISK/CANDIDATE/REVIEW_CREATE）→ 放行', () => {
      expect(() => assertAgentMayCall('ProjectService.getProject')).not.toThrow();
      expect(() => assertAgentMayCall('DraftService.createDraft')).not.toThrow();
      expect(() => assertAgentMayCall('EntityService.approveCandidate')).not.toThrow();
      expect(() => assertAgentMayCall('CoreBridgeService.simulateProposal')).not.toThrow();
    });
  });
});
