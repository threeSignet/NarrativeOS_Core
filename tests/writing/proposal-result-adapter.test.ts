// =============================================================================
// ProposalResult → SimulationResult 适配器单测（W13-b P1）
// =============================================================================
// 验证 Agent 路径把已推演的 ProposalResult 投影为写作层 SimulationResult 的正确性。
// 镜像 real-bridge.ts:runProposeEvent 原内联逻辑（182-207）的期望，确保抽取无损。
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  proposalResultToSimulationResult,
  type ProposalResultLike,
} from '../../src/writing/core-bridge/proposal-result-adapter.js';

describe('proposalResultToSimulationResult（ProposalResult→SimulationResult 适配器）', () => {
  it('完整映射：标量直传 + threads/warnings 投影', () => {
    const pr: ProposalResultLike = {
      proposalId: 'prop_test_1',
      isSafeToCommit: true,
      simulationReportMarkdown: '## 推演报告\n- 事件安全',
      consequences: {
        generatedThreads: [
          { severity: 'minor', type: 'foreshadow', description: '埋了一条伏笔' },
          { severity: 'major', type: 'rule_violation', description: '触发规则' },
        ],
        warnings: ['世界状态已更新', '注意角色动机'],
      },
    };

    const sim = proposalResultToSimulationResult(pr);

    expect(sim.proposalId).toBe('prop_test_1');
    expect(sim.isSafeToCommit).toBe(true);
    expect(sim.report).toBe('## 推演报告\n- 事件安全');
    expect(sim.consequenceThreads).toHaveLength(2);
    expect(sim.consequenceThreads[0]).toEqual({
      severity: 'minor',
      type: 'foreshadow',
      description: '埋了一条伏笔',
    });
    expect(sim.consequenceWarnings).toEqual(['世界状态已更新', '注意角色动机']);
  });

  it('过滤掉 severity 非字符串的脏线索', () => {
    const pr: ProposalResultLike = {
      proposalId: 'p2',
      isSafeToCommit: false,
      simulationReportMarkdown: '',
      consequences: {
        generatedThreads: [
          { severity: 'critical', type: 't', description: 'd' },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { severity: undefined, type: 'x', description: 'y' } as any, // 脏数据：缺 severity
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { type: 'no-sev', description: 'no' } as any, // 完全无 severity 字段
        ],
      },
    };

    const sim = proposalResultToSimulationResult(pr);

    // 仅保留第一条（severity 是字符串），其余两条脏数据被丢弃
    expect(sim.consequenceThreads).toHaveLength(1);
    expect(sim.consequenceThreads[0]!.severity).toBe('critical');
  });

  it('线索的 type/description 缺失时降级为空字符串（不丢弃整条）', () => {
    const pr: ProposalResultLike = {
      proposalId: 'p3',
      isSafeToCommit: true,
      simulationReportMarkdown: 'r',
      consequences: {
        generatedThreads: [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { severity: 'major' } as any, // 有 severity 但缺 type/description
        ],
      },
    };

    const sim = proposalResultToSimulationResult(pr);

    expect(sim.consequenceThreads).toHaveLength(1);
    expect(sim.consequenceThreads[0]).toEqual({
      severity: 'major',
      type: '',
      description: '',
    });
  });

  it('过滤掉非字符串的 warnings 项', () => {
    const pr: ProposalResultLike = {
      proposalId: 'p4',
      isSafeToCommit: true,
      simulationReportMarkdown: '',
      consequences: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        warnings: ['合法警告', 42, null, { not: 'string' }, '另一条'] as any,
      },
    };

    const sim = proposalResultToSimulationResult(pr);

    expect(sim.consequenceWarnings).toEqual(['合法警告', '另一条']);
  });

  it('consequences 缺失（undefined）时回退空数组，不抛错', () => {
    const pr: ProposalResultLike = {
      proposalId: 'p5',
      isSafeToCommit: true,
      simulationReportMarkdown: 'report',
      // 无 consequences 字段
    };

    const sim = proposalResultToSimulationResult(pr);

    expect(sim.proposalId).toBe('p5');
    expect(sim.isSafeToCommit).toBe(true);
    expect(sim.report).toBe('report');
    expect(sim.consequenceThreads).toEqual([]);
    expect(sim.consequenceWarnings).toEqual([]);
  });

  it('consequences 为空对象时也回退空数组', () => {
    const pr: ProposalResultLike = {
      proposalId: 'p6',
      isSafeToCommit: false,
      simulationReportMarkdown: '',
      consequences: {}, // 既无 generatedThreads 也无 warnings
    };

    const sim = proposalResultToSimulationResult(pr);

    expect(sim.consequenceThreads).toEqual([]);
    expect(sim.consequenceWarnings).toEqual([]);
    expect(sim.isSafeToCommit).toBe(false);
  });

  it('isSafeToCommit=false 但无线索时仍如实反映（buildProposalReviewData 会补防御兜底 blocker）', () => {
    // 验证适配器不做 isSafeToCommit 与线索的关联推断——分级兜底是 buildProposalReviewData 的职责
    const pr: ProposalResultLike = {
      proposalId: 'p7',
      isSafeToCommit: false,
      simulationReportMarkdown: 'r',
      consequences: { generatedThreads: [], warnings: [] },
    };

    const sim = proposalResultToSimulationResult(pr);

    expect(sim.isSafeToCommit).toBe(false);
    expect(sim.consequenceThreads).toEqual([]);
    expect(sim.consequenceWarnings).toEqual([]);
  });
});
