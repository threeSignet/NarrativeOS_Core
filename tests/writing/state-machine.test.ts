// =============================================================================
// StateMachine 状态跳转校验测试
// =============================================================================
// 验证各对象的状态/成熟度跳转表与复合校验。
// 纯函数测试，不依赖数据库。
//
// 重点覆盖本次修复涉及的语义点：
//   - IdeaCard: ready_for_draft 自转拒绝（promoteIdeaToDraft 幂等陷阱）
//   - WritingEntitySketch: registered 为状态机死态（仅 Retcon 可达）、merge 仅允许 candidate 源
//   - ProjectBlueprint: evolving → active 放行
//   - WritingProposalView: commit_failed → open 恢复路径
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  validateProjectTransition,
  validateIdeaTransition,
  validateBlueprintTransition,
  validateDraftTransition,
  validateEntitySketchTransition,
  validateProposalViewTransition,
  validateCommitReadiness,
  validateDraftSimulationReadiness,
  StateMachineError,
} from '../../src/writing/models/state-machine.js';
import { WritingErrorCode } from '../../src/writing/errors/error-codes.js';

// 工具：断言某跳转会抛出带特定 code 的 StateMachineError
function expectRejected(
  fn: () => void,
  expectedFrom: string,
  expectedTo: string,
) {
  expect(fn).toThrow(StateMachineError);
  let caught: unknown;
  try { fn(); } catch (e) { caught = e; }
  const err = caught as StateMachineError;
  expect(err.code).toBe(WritingErrorCode.INVALID_STATUS_TRANSITION);
  expect(err.currentStatus).toBe(expectedFrom);
  expect(err.targetStatus).toBe(expectedTo);
}

// =============================================================================
// WritingProject
// =============================================================================

describe('validateProjectTransition', () => {
  it('允许合法跳转', () => {
    expect(() => validateProjectTransition('planning', 'drafting', 'p1')).not.toThrow();
    expect(() => validateProjectTransition('reviewing', 'archived', 'p1')).not.toThrow();
    expect(() => validateProjectTransition('paused', 'reviewing', 'p1')).not.toThrow();
  });

  it('拒绝非法跳转', () => {
    // archived 为终态
    expectRejected(() => validateProjectTransition('archived', 'drafting', 'p1'), 'archived', 'drafting');
    // drafting 不能回退到 planning（drafting 仅可向前或暂停/归档）
    expectRejected(() => validateProjectTransition('drafting', 'planning', 'p1'), 'drafting', 'planning');
  });
});

// =============================================================================
// IdeaCard
// =============================================================================

describe('validateIdeaTransition', () => {
  it('允许 raw → candidate / archived', () => {
    expect(() => validateIdeaTransition('raw', 'candidate', 'i1')).not.toThrow();
    expect(() => validateIdeaTransition('raw', 'archived', 'i1')).not.toThrow();
  });

  it('允许 candidate → structured / ready_for_draft / archived', () => {
    expect(() => validateIdeaTransition('candidate', 'structured', 'i1')).not.toThrow();
    // 关键：candidate 可直接转草案（快捷路径，与 promoteIdeaToDraft 一致）
    expect(() => validateIdeaTransition('candidate', 'ready_for_draft', 'i1')).not.toThrow();
  });

  it('允许 structured → ready_for_draft', () => {
    expect(() => validateIdeaTransition('structured', 'ready_for_draft', 'i1')).not.toThrow();
  });

  it('拒绝 raw → ready_for_draft（必须先分类）', () => {
    expectRejected(() => validateIdeaTransition('raw', 'ready_for_draft', 'i1'), 'raw', 'ready_for_draft');
  });

  it('拒绝 archived → ready_for_draft', () => {
    expectRejected(() => validateIdeaTransition('archived', 'ready_for_draft', 'i1'), 'archived', 'ready_for_draft');
  });

  it('拒绝 ready_for_draft 自转（promoteIdeaToDraft 幂等陷阱）', () => {
    // IDEA_TRANSITIONS['ready_for_draft'] = ['archived']，自转不在其中
    // 这正是 IdeaService.promoteIdeaToDraft 需特判 maturity !== 'ready_for_draft' 的原因
    expectRejected(
      () => validateIdeaTransition('ready_for_draft', 'ready_for_draft', 'i1'),
      'ready_for_draft', 'ready_for_draft',
    );
  });
});

// =============================================================================
// ProjectBlueprint
// =============================================================================

describe('validateBlueprintTransition', () => {
  it('允许 drafted / reviewed → active', () => {
    expect(() => validateBlueprintTransition('drafted', 'active', 'b1')).not.toThrow();
    expect(() => validateBlueprintTransition('reviewed', 'active', 'b1')).not.toThrow();
  });

  it('允许 evolving → active（演化后激活）', () => {
    // blueprint-service.acceptBlueprintDraft 接入后此路径放行
    expect(() => validateBlueprintTransition('evolving', 'active', 'b1')).not.toThrow();
  });

  it('拒绝 active → active（已激活）与终态跳转', () => {
    expectRejected(() => validateBlueprintTransition('active', 'active', 'b1'), 'active', 'active');
    expectRejected(() => validateBlueprintTransition('archived', 'active', 'b1'), 'archived', 'active');
    expectRejected(() => validateBlueprintTransition('superseded', 'active', 'b1'), 'superseded', 'active');
  });
});

// =============================================================================
// WritingDraft
// =============================================================================

describe('validateDraftTransition', () => {
  it('允许主闭环 drafting → ready_to_simulate → simulated → committed', () => {
    expect(() => validateDraftTransition('drafting', 'ready_to_simulate', 'd1')).not.toThrow();
    expect(() => validateDraftTransition('ready_to_simulate', 'simulated', 'd1')).not.toThrow();
    expect(() => validateDraftTransition('simulated', 'committed', 'd1')).not.toThrow();
  });

  it('允许 simulated 回退 drafting（内容修改需重新推演）', () => {
    expect(() => validateDraftTransition('simulated', 'drafting', 'd1')).not.toThrow();
  });

  it('拒绝 committed 的任何转换（终态）', () => {
    expectRejected(() => validateDraftTransition('committed', 'drafting', 'd1'), 'committed', 'drafting');
  });
});

// =============================================================================
// WritingEntitySketch（本次修正重点）
// =============================================================================

describe('validateEntitySketchTransition', () => {
  it('允许 hint → candidate / deprecated', () => {
    expect(() => validateEntitySketchTransition('hint', 'candidate', 'e1')).not.toThrow();
    expect(() => validateEntitySketchTransition('hint', 'deprecated', 'e1')).not.toThrow();
  });

  it('允许 candidate → approved / merged / deprecated', () => {
    expect(() => validateEntitySketchTransition('candidate', 'approved', 'e1')).not.toThrow();
    // 关键：合并源必须是 candidate（mergeSketches 依赖此规则）
    expect(() => validateEntitySketchTransition('candidate', 'merged', 'e1')).not.toThrow();
  });

  it('拒绝 hint → merged（必须先 promote 到 candidate）', () => {
    // 收紧：原 mergeSketches 允许 hint 作源，现由状态机拒绝
    expectRejected(() => validateEntitySketchTransition('hint', 'merged', 'e1'), 'hint', 'merged');
  });

  it('拒绝 approved → merged（已批准的应注册或废弃，不应直接合并）', () => {
    // ENTITY_SKETCH_TRANSITIONS['approved'] = ['registered', 'deprecated', 'candidate']，无 merged
    expectRejected(() => validateEntitySketchTransition('approved', 'merged', 'e1'), 'approved', 'merged');
  });

  it('registered 为状态机死态：拒绝任何普通转换（含 deprecated）', () => {
    // 本次修正：registered: [] —— 已被 Core 引用，废弃/合并必须经 Retcon 通道
    // EntityService.deprecateEntitySketch / mergeSketches 均前置拦截 registered
    expectRejected(() => validateEntitySketchTransition('registered', 'deprecated', 'e1'), 'registered', 'deprecated');
    expectRejected(() => validateEntitySketchTransition('registered', 'merged', 'e1'), 'registered', 'merged');
  });

  it('merged 为终态', () => {
    expectRejected(() => validateEntitySketchTransition('merged', 'deprecated', 'e1'), 'merged', 'deprecated');
  });
});

// =============================================================================
// WritingProposalView
// =============================================================================

describe('validateProposalViewTransition', () => {
  it('允许 open → author_approved / author_rejected / expired', () => {
    expect(() => validateProposalViewTransition('open', 'author_approved', 'pv1')).not.toThrow();
    expect(() => validateProposalViewTransition('open', 'author_rejected', 'pv1')).not.toThrow();
    expect(() => validateProposalViewTransition('open', 'expired', 'pv1')).not.toThrow();
  });

  it('允许 author_approved → committed / commit_failed', () => {
    expect(() => validateProposalViewTransition('author_approved', 'committed', 'pv1')).not.toThrow();
    expect(() => validateProposalViewTransition('author_approved', 'commit_failed', 'pv1')).not.toThrow();
  });

  it('允许 commit_failed → open（失败后可重新审核）', () => {
    expect(() => validateProposalViewTransition('commit_failed', 'open', 'pv1')).not.toThrow();
  });

  it('拒绝 open → committed（必须先经 author_approved）', () => {
    // P0-1 修复的关键不变式：CoreBridge.commitReviewedProposal 前置校验 status === 'author_approved'
    expectRejected(() => validateProposalViewTransition('open', 'committed', 'pv1'), 'open', 'committed');
  });

  it('committed 为终态', () => {
    expectRejected(() => validateProposalViewTransition('committed', 'open', 'pv1'), 'committed', 'open');
  });
});

// =============================================================================
// 复合校验
// =============================================================================

describe('validateCommitReadiness', () => {
  it('author_approved + 草案未变 → 合法', () => {
    expect(validateCommitReadiness({
      proposalViewStatus: 'author_approved',
      sourceDraftStatus: 'simulated',
    })).toEqual({ valid: true });
  });

  it('未批准 → 非法', () => {
    const r = validateCommitReadiness({ proposalViewStatus: 'open' });
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('批准');
  });

  it('来源草案在审核期被修改（drafting/ready_to_simulate）→ 非法', () => {
    const r = validateCommitReadiness({
      proposalViewStatus: 'author_approved',
      sourceDraftStatus: 'drafting',
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('重新推演');
  });

  it('来源草案被删除 → 非法', () => {
    const r = validateCommitReadiness({
      proposalViewStatus: 'author_approved',
      sourceDraftStatus: 'simulated',
      sourceDraftDeleted: true,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('删除');
  });
});

describe('validateDraftSimulationReadiness', () => {
  it('有内容且非终态 → 合法', () => {
    expect(validateDraftSimulationReadiness({
      status: 'ready_to_simulate',
      content: '这是一段足够长的草案内容用于推演',
    })).toEqual({ valid: true });
  });

  it('committed / archived → 非法', () => {
    expect(validateDraftSimulationReadiness({ status: 'committed', content: 'x'.repeat(20) }).valid).toBe(false);
    expect(validateDraftSimulationReadiness({ status: 'archived', content: 'x'.repeat(20) }).valid).toBe(false);
  });

  it('内容过短（<10 字符）→ 非法', () => {
    const r = validateDraftSimulationReadiness({ status: 'drafting', content: '短' });
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('过短');
  });

  it('空内容 → 非法', () => {
    expect(validateDraftSimulationReadiness({ status: 'drafting', content: '' }).valid).toBe(false);
    expect(validateDraftSimulationReadiness({ status: 'drafting', content: '   ' }).valid).toBe(false);
  });
});
