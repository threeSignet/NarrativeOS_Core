// =============================================================================
// W6 测试：ViewModel 投影层 + visibilityMode 字段过滤（§9.1/§9.2）
// =============================================================================
// 验证：
//   1. 标签映射——把内部枚举（ProjectStatus/WorkspaceMode/DraftStatus/DecisionKind）
//      翻译为面向作者的人话标签（§9.2 示例：构思中/写作中/审核中、规划/写作/审核 …）。
//   2. buildProjectHomeView 投影——普通模式只产出人话字段（无 id/无技术块）；
//      debug 模式额外附带 _debug 技术诊断块。
//   3. §9.1 过滤——normal 模式下绝不能出现 Core 内部 ID（ent_/fct_/evt_…）、
//      谓词、EntityKind、表名、请求 ID 等技术字段；filter 能检出并剥离。
//
// 设计文档：Phase7-Refinement.md §9.1/§9.2，§25 #8。
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  projectStatusLabel,
  workspaceModeLabel,
  draftStatusLabel,
  decisionKindLabel,
  buildProjectHomeView,
} from '../../src/writing/view-models/project-home.js';
import {
  findForbiddenField,
  stripForbiddenFields,
  assertNoForbiddenFields,
} from '../../src/writing/view-models/filter.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import type { WritingProject, WritingDraft, PendingDecisionItem } from '../../src/writing/models/types.js';

// ---- 构造测试用的原始领域对象（带技术字段，投影后应被过滤）----
function makeProject(over: Partial<WritingProject> = {}): WritingProject {
  return {
    id: 'prj_test_01',
    title: '长庚站纪事',
    premise: '一个灰域科幻故事',
    status: 'drafting',
    workspaceMode: 'writing',
    sourceRefs: [],
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-14T00:00:00Z',
    ...over,
  };
}
function makeDraft(over: Partial<WritingDraft> = {}): WritingDraft {
  return {
    id: 'drf_001',
    projectId: 'prj_test_01',
    kind: 'event',
    chapter: 1,
    content: '草案内容……',
    status: 'simulated',
    version: 1,
    sourceRefs: [],
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-14T00:00:00Z',
    ...over,
  };
}
function makeDecision(over: Partial<PendingDecisionItem> = {}): PendingDecisionItem {
  return {
    id: 'dec_001',
    projectId: 'prj_test_01',
    kind: 'confirm_proposal',
    title: '是否提交「黑晶碎片发热」事件？',
    sourceRefs: [],
    status: 'open',
    createdAt: '2026-06-14T00:00:00Z',
    updatedAt: '2026-06-14T00:00:00Z',
    ...over,
  };
}

describe('W6 标签映射（枚举 → 人话，§9.2）', () => {
  it('ProjectStatus → 中文状态标签', () => {
    expect(projectStatusLabel('planning')).toBe('构思中');
    expect(projectStatusLabel('drafting')).toBe('写作中');
    expect(projectStatusLabel('reviewing')).toBe('审核中');
    expect(projectStatusLabel('paused')).toBe('已暂停');
    expect(projectStatusLabel('archived')).toBe('已归档');
  });

  it('WorkspaceMode → 中文模式标签', () => {
    expect(workspaceModeLabel('planning')).toBe('规划');
    expect(workspaceModeLabel('writing')).toBe('写作');
    expect(workspaceModeLabel('reviewing')).toBe('审核');
    expect(workspaceModeLabel('analysis')).toBe('分析');
    expect(workspaceModeLabel('importing')).toBe('导入');
  });

  it('DraftStatus → 中文草案状态标签', () => {
    expect(draftStatusLabel('drafting')).toBe('起草中');
    expect(draftStatusLabel('ready_to_simulate')).toBe('可推演');
    expect(draftStatusLabel('simulated')).toBe('已推演');
    expect(draftStatusLabel('committed')).toBe('已提交');
    expect(draftStatusLabel('archived')).toBe('已归档');
    expect(draftStatusLabel('error')).toBe('出错');
  });

  it('DecisionKind → 中文决策类型标签', () => {
    expect(decisionKindLabel('confirm_entity')).toBe('实体注册');
    expect(decisionKindLabel('confirm_draft')).toBe('草案确认');
    expect(decisionKindLabel('confirm_proposal')).toBe('提案审核');
    expect(decisionKindLabel('confirm_retcon')).toBe('修订审核');
    expect(decisionKindLabel('confirm_blueprint')).toBe('蓝图确认');
    expect(decisionKindLabel('confirm_rule')).toBe('规则确认');
  });

  it('未知枚举值降级为原始字符串（不崩、可追溯）', () => {
    expect(projectStatusLabel('unknown_x' as never)).toBe('unknown_x');
    expect(decisionKindLabel('mystery' as never)).toBe('mystery');
  });
});

describe('W6 buildProjectHomeView 投影（§9.2 ProjectHomeViewModel）', () => {
  it('normal 模式：只产出人话字段，无任何 id、无 _debug 技术块', () => {
    const ctx = makeRequestContext({ projectId: 'prj_test_01', visibilityMode: 'normal' });
    const vm = buildProjectHomeView(ctx, {
      project: makeProject(),
      recentDrafts: [makeDraft({ title: undefined as never, summary: '第一幕事件' })],
      pendingDecisions: [makeDecision()],
      candidateEntityCount: 3,
    });

    // §9.2 期望的人话字段
    expect(vm.projectTitle).toBe('长庚站纪事');
    expect(vm.projectStatusLabel).toBe('写作中');
    expect(vm.workspaceModeLabel).toBe('写作');
    expect(vm.candidateEntityCount).toBe(3);
    expect(vm.recentDrafts[0]!.statusLabel).toBe('已推演');
    expect(vm.pendingDecisions[0]!.kindLabel).toBe('提案审核');

    // normal 模式绝不出现技术字段（§9.1）
    expect(vm._debug).toBeUndefined();
    // 深度扫描：整个 ViewModel 无 Core ID / 谓词 / 表名等技术字段
    expect(findForbiddenField(vm, 'normal')).toBeNull();
  });

  it('debug 模式：附带 _debug 技术诊断块（含 id / 原始枚举），供排查', () => {
    const ctx = makeRequestContext({ projectId: 'prj_test_01', visibilityMode: 'debug' });
    const vm = buildProjectHomeView(ctx, {
      project: makeProject(),
      recentDrafts: [makeDraft({ id: 'drf_001' })],
      pendingDecisions: [makeDecision({ id: 'dec_001' })],
      candidateEntityCount: 2,
    });

    expect(vm._debug).toBeDefined();
    expect(vm._debug!.projectId).toBe('prj_test_01');
    expect(vm._debug!.projectStatus).toBe('drafting');
    expect(vm._debug!.workspaceMode).toBe('writing');
    expect(vm._debug!.draftIds).toEqual(['drf_001']);
    expect(vm._debug!.pendingDecisionIds).toEqual(['dec_001']);
  });

  it('投影结果通过 §9.1 断言（normal 无技术字段泄漏）', () => {
    const ctx = makeRequestContext({ projectId: 'prj_test_01', visibilityMode: 'normal' });
    const vm = buildProjectHomeView(ctx, {
      project: makeProject(),
      recentDrafts: [],
      pendingDecisions: [],
      candidateEntityCount: 0,
    });
    // 不抛即通过——投影层内置防御性断言
    expect(() => assertNoForbiddenFields(vm, 'normal')).not.toThrow();
  });
});

describe('W6 §9.1 过滤器（forbidden field 检出 / 剥离）', () => {
  it('检出 Core 实体/事实/事件 ID 值泄漏（normal 违规，debug 放行）', () => {
    const leaky = { name: '沈笙', coreEntityId: 'ent_shensheng', factRef: 'fct_encounter_50_02' };
    expect(findForbiddenField(leaky, 'normal')).toBeTruthy();
    expect(findForbiddenField(leaky, 'debug')).toBeNull();
  });

  it('检出技术键名（entityKind / predicate / 表名）', () => {
    expect(findForbiddenField({ entityKind: 'character' }, 'normal')).toBeTruthy();
    expect(findForbiddenField({ predicate: 'location' }, 'normal')).toBeTruthy();
    expect(findForbiddenField({ tableName: 'writing_drafts' }, 'normal')).toBeTruthy();
    expect(findForbiddenField({ requestId: 'req_abc' }, 'normal')).toBeTruthy();
  });

  it('干净对象无违规', () => {
    const clean = { projectTitle: '长庚站纪事', statusLabel: '写作中', count: 3 };
    expect(findForbiddenField(clean, 'normal')).toBeNull();
  });

  it('stripForbiddenFields：normal 递归移除禁止键 + 掩码 Core ID 值；debug 原样返回', () => {
    const leaky = {
      title: '事件A',
      coreEntityId: 'ent_shensheng',
      nested: { predicate: 'location', ok: 1 },
      arr: [{ id: 'fct_001' }, { id: 'keep' }],
    };
    const stripped = stripForbiddenFields(leaky, 'normal');
    expect(stripped.coreEntityId).toBeUndefined();
    expect(stripped.nested.predicate).toBeUndefined();
    // Core ID 值被掩码（不泄漏原始前缀）
    expect(JSON.stringify(stripped.arr)).not.toContain('fct_001');
    // 非技术字段保留
    expect(stripped.title).toBe('事件A');
    expect(stripped.nested.ok).toBe(1);

    // debug 模式原样返回（不剥离）
    expect(stripForbiddenFields(leaky, 'debug')).toEqual(leaky);
  });

  it('assertNoForbiddenFields：normal 有泄漏则抛 WritingError(含违规描述)', () => {
    const leaky = { coreEntityId: 'ent_x' };
    expect(() => assertNoForbiddenFields(leaky, 'normal')).toThrow();
    expect(() => assertNoForbiddenFields(leaky, 'debug')).not.toThrow();
  });
});
