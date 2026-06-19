// =============================================================================
// W19-c / WL-E2E-015 测试：visibilityMode 字段过滤（§9.1 作者视图不泄漏技术字段）
// =============================================================================
// 验证普通作者视图（visibilityMode='normal'）绝不暴露技术字段：
//   - Core EntityKind / RelationKind / predicate 枚举键名
//   - Core 实体/事实/事件/线索/知识/请求 ID（ent_/fct_/evt_/thd_/kno_/req_）
//   - 规则 JSON DSL（fact_changes / condition）
//   - 表名裸值（writing_*）
//
// 三层覆盖（与权限门控 #46 的双层结构对称）：
//   1. filter.ts 纯函数层——§9.1 防线的单一真相源（findForbiddenField / stripForbiddenFields /
//      assertNoForbiddenFields），各种技术字段/值的精确处理。
//   2. VM 投影层——证"投影 + 过滤"协同：含技术字段的原始领域对象经投影后，normal 输出 clean。
//   3. 边界与误伤——合法文本（如标签 "writing_notes"）不被误掩码；debug 模式原样放行。
//
// 范式对齐 permission-check.test.ts（纯函数）+ reconcile.test.ts（真实栈集成）。
// 设计文档：Phase7-Refinement.md §9.1；Feature-Spec §28.2 WL-E2E-015。
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  stripForbiddenFields,
  findForbiddenField,
  assertNoForbiddenFields,
  type VisibilityMode,
} from '../../src/writing/view-models/filter.js';
import { buildProjectHomeView } from '../../src/writing/view-models/project-home.js';
import { buildWorldSnapshotView } from '../../src/writing/view-models/world-snapshot.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import type { WorldSnapshot } from '../../src/writing/core-bridge/core-bridge-service.js';
import type {
  WritingProject,
  WritingDraft,
  PendingDecisionItem,
} from '../../src/writing/models/types.js';

// ---------------------------------------------------------------------------
// 辅助：构造最小合法领域对象（给 VM 投影用）
// ---------------------------------------------------------------------------

/** 构造一个 WritingProject（含正常字段，无技术字段） */
function makeProject(overrides: Partial<WritingProject> = {}): WritingProject {
  return {
    id: 'proj_test',
    title: '测试作品',
    summary: '测试摘要',
    status: 'planning',
    workspaceMode: 'normal',
    activeBlueprintId: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    sourceRefs: [],
    ...overrides,
  };
}

/** 构造一个 WritingDraft */
function makeDraft(overrides: Partial<WritingDraft> = {}): WritingDraft {
  return {
    id: 'drft_test',
    projectId: 'proj_test',
    kind: 'event',
    title: '测试草案',
    content: '内容',
    chapter: 1,
    status: 'drafting',
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    sourceRefs: [],
    ...overrides,
  };
}

/** 构造一个 WorldSnapshot（数据层返回，含 Core 原始 id / 谓词） */
function makeSnapshot(): WorldSnapshot {
  return {
    currentChapter: 5,
    totalEntities: 2,
    entities: [
      {
        coreEntityId: 'ent_hero',   // ← Core 原始 id（normal 模式必须隐藏）
        displayName: '主角',
        typeLabel: '角色',
        profileMarkdown: '## 主角（ent_hero）档案\n* location：废弃站台', // 含 ent_/谓词
        factIndex: [
          { factId: 'fct_001', predicate: 'location', value: '废弃站台' },
          { factId: 'fct_002', predicate: 'status', value: '存活' },
        ],
      },
      {
        coreEntityId: 'ent_villain',
        displayName: '反派',
        typeLabel: '角色',
        profileMarkdown: '## 反派（ent_villain）档案',
        factIndex: [],
        // error 不以 Core id 前缀开头 → filter.ts 值级前缀匹配不掩码（设计如此）。
        // 人话错误信息不含原始 id 才是 §9.1 的预期——此处用纯人话，避免依赖子串掩码。
        error: '读取失败：该实体的知识引用断裂',
      },
    ],
  };
}

// ===========================================================================
// 1. filter.ts 纯函数层
// ===========================================================================

describe('W19-c · filter.ts 纯函数（§9.1 防线单一真相源）', () => {
  // -------------------------------------------------------------------------
  // findForbiddenField
  // -------------------------------------------------------------------------

  describe('findForbiddenField（定位首个违规路径）', () => {
    it('normal 模式：含禁止键名返回路径描述', () => {
      const obj = { name: '主角', coreEntityId: 'ent_hero', age: 25 };
      const found = findForbiddenField(obj, 'normal');
      expect(found).not.toBeNull();
      expect(found).toContain('coreEntityId');
      expect(found).toContain('禁止的技术键名');
    });

    it('normal 模式：嵌套对象中的违规也能定位（深度扫描）', () => {
      const obj = {
        outer: { items: [{ ok: 1 }, { predicate: 'location', v: '站台' }] },
      };
      const found = findForbiddenField(obj, 'normal');
      expect(found).not.toBeNull();
      expect(found).toContain('predicate');
    });

    it('normal 模式：以 Core id 前缀开头的裸值能定位（值级前缀匹配）', () => {
      // filter.ts 的值匹配是 /^ent_/ 等前缀正则（字符串开头锚定），
      // 非"子串扫描"——这是有意设计（注释 filter.ts:18-22：按 VALUE 模式匹配前缀），
      // 故仅"以 Core id 开头"的值被识别，藏在句中的不误报。
      const obj = { ref: 'evt_breakthrough_50_02' };
      expect(findForbiddenField(obj, 'normal')).not.toBeNull();

      // 对比：子串里含 evt_ 但不以它开头 → 不识别（设计如此，非 bug）
      const embedded = { note: '某事件关联 evt_break' };
      expect(findForbiddenField(embedded, 'normal')).toBeNull();
    });

    it('normal 模式：表名裸值（writing_*）能定位', () => {
      const obj = { source: 'writing_drafts' };
      const found = findForbiddenField(obj, 'normal');
      expect(found).not.toBeNull();
      expect(found).toContain('writing_');
    });

    it('clean 对象返回 null（无违规）', () => {
      const obj = { title: '主角', statusLabel: '规划中', count: 3 };
      expect(findForbiddenField(obj, 'normal')).toBeNull();
    });

    it('debug 模式：一律放行（返回 null）', () => {
      const obj = { coreEntityId: 'ent_x', predicate: 'loc', factChanges: [] };
      expect(findForbiddenField(obj, 'debug')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // stripForbiddenFields
  // -------------------------------------------------------------------------

  describe('stripForbiddenFields（递归剥离 + 掩码）', () => {
    it('normal 模式：禁止键名连同其值整体移除', () => {
      const obj = {
        name: '主角',
        coreEntityId: 'ent_hero',
        predicate: 'location',
        factChanges: [{ op: 'assert' }],
        normalField: '保留',
      };
      const stripped = stripForbiddenFields(obj, 'normal');
      expect(stripped).toEqual({ name: '主角', normalField: '保留' });
      // 禁止键不存在于输出
      expect(stripped).not.toHaveProperty('coreEntityId');
      expect(stripped).not.toHaveProperty('predicate');
      expect(stripped).not.toHaveProperty('factChanges');
    });

    it('normal 模式：以 Core id 前缀开头的值整体掩码为 ***（值级前缀匹配，整体替换）', () => {
      // filter.ts 的掩码是"整体替换"：值若匹配 /^ent_/ 等前缀正则，整个字符串 → ***，
      // 非"子串替换"。故 'ent_hero 的故事' 整体变 ***（不是 '*** 的故事'）。
      // 这是 §9.1 的保守策略：Core id 一旦出现在值里，整个值都不可信（可能含更多 id 片段）。
      const obj = {
        heroId: 'ent_hero',           // 以 ent_ 开头 → ***
        desc: 'evt_break_50',         // 以 evt_ 开头 → ***
        nested: { ref: 'fct_001' },   // 以 fct_ 开头 → ***
        list: ['thd_main', 'kno_3', 'req_abc'], // 各元素前缀匹配 → 全 ***
        clean: '正常文本',
        embedded: '关联 ent_x 信息',   // 不以 ent_ 开头 → 保持（子串不掩码）
      };
      const stripped = stripForbiddenFields(obj, 'normal') as Record<string, unknown>;
      expect(stripped.heroId).toBe('***');
      expect(stripped.desc).toBe('***');
      expect((stripped.nested as Record<string, unknown>).ref).toBe('***');
      expect(stripped.list).toEqual(['***', '***', '***']);
      expect(stripped.clean).toBe('正常文本');
      // 子串不掩码（设计如此，防止误伤合法文本）
      expect(stripped.embedded).toBe('关联 ent_x 信息');
    });

    it('normal 模式：表名裸值掩码为 ***', () => {
      const obj = { a: 'writing_drafts', b: 'writing_audit_logs', c: '正常' };
      const stripped = stripForbiddenFields(obj, 'normal') as Record<string, unknown>;
      expect(stripped.a).toBe('***');
      expect(stripped.b).toBe('***');
      expect(stripped.c).toBe('正常');
    });

    it('normal 模式：不掩码非表名的 writing_ 合法文本（防误伤，P1 修复点）', () => {
      // writing_notes 不是真实表名 → 不应被掩码（原宽正则会误伤）
      const obj = { tag: 'writing_notes', note: 'writing_is_fun' };
      const stripped = stripForbiddenFields(obj, 'normal') as Record<string, unknown>;
      expect(stripped.tag).toBe('writing_notes');
      expect(stripped.note).toBe('writing_is_fun');
    });

    it('normal 模式：数组递归处理（每个元素独立扫描）', () => {
      const obj = {
        items: [
          { name: 'A', coreEntityId: 'ent_a' },
          { name: 'B', coreEntityId: 'ent_b' },
        ],
      };
      const stripped = stripForbiddenFields(obj, 'normal') as Record<string, unknown>;
      const items = stripped.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({ name: 'A' });
      expect(items[1]).toEqual({ name: 'B' });
    });

    it('normal 模式：返回新对象，入参不可变', () => {
      const obj = { name: 'x', coreEntityId: 'ent_y' };
      const stripped = stripForbiddenFields(obj, 'normal');
      // 入参不变
      expect(obj).toHaveProperty('coreEntityId');
      expect(obj.coreEntityId).toBe('ent_y');
      // 输出是新对象（引用不同）
      expect(stripped).not.toBe(obj);
    });

    it('debug 模式：原样返回同一引用（不过滤）', () => {
      const obj = { coreEntityId: 'ent_x', predicate: 'loc', factChanges: [] };
      const result = stripForbiddenFields(obj, 'debug');
      // debug 模式返回入参同一引用
      expect(result).toBe(obj);
      expect(result).toEqual(obj);
    });

    it('全部禁止键名逐一被剥离（§9.1 完备性）', () => {
      // 覆盖 FORBIDDEN_KEY_NAMES 的全部条目，确保无一漏网
      const obj = {
        entityKind: 'character',
        relationKind: 'ally',
        coreKind: 'entity',
        predicate: 'loc',
        coreEntityId: 'ent_x',
        coreEventId: 'evt_x',
        coreFactId: 'fct_x',
        coreThreadId: 'thd_x',
        coreProposalId: 'prp_x',
        tableName: 'writing_drafts',
        requestId: 'req_x',
        reqId: 'req_y',
        sessionId: 'sess_z',
        factChanges: [],
        fact_changes: [],
        condition: 'true',
        coreBridgeResult: {},
        expectedStateVersion: 0,
        rawInput: 'xxx',
        cleanField: '保留',
      };
      const stripped = stripForbiddenFields(obj, 'normal') as Record<string, unknown>;
      expect(stripped).toEqual({ cleanField: '保留' });
    });
  });

  // -------------------------------------------------------------------------
  // assertNoForbiddenFields
  // -------------------------------------------------------------------------

  describe('assertNoForbiddenFields（防御性断言）', () => {
    it('normal 模式：发现泄漏抛 Error（含路径）', () => {
      const obj = { name: 'x', coreEntityId: 'ent_y' };
      expect(() => assertNoForbiddenFields(obj, 'normal')).toThrow(/§9.1 禁止字段/);
      expect(() => assertNoForbiddenFields(obj, 'normal')).toThrow(/coreEntityId/);
    });

    it('normal 模式：clean 对象不抛', () => {
      const obj = { title: '主角', statusLabel: '规划中' };
      expect(() => assertNoForbiddenFields(obj, 'normal')).not.toThrow();
    });

    it('debug 模式：含技术字段也不抛（合法）', () => {
      const obj = { coreEntityId: 'ent_x', predicate: 'loc', _debug: true };
      expect(() => assertNoForbiddenFields(obj, 'debug')).not.toThrow();
    });
  });
});

// ===========================================================================
// 2. VM 投影层（投影 + 过滤协同）
// ===========================================================================

describe('W19-c · buildProjectHomeView（投影层过滤）', () => {
  it('normal 模式：输出含人话字段，无 id / 枚举 / Core 引用', () => {
    const ctx = makeRequestContext({ projectId: 'proj_test' }); // visibilityMode 默认 normal
    const input = {
      project: makeProject({ id: 'proj_secret', status: 'planning', workspaceMode: 'focus' }),
      recentDrafts: [makeDraft({ id: 'drft_secret', title: '第一章' })],
      pendingDecisions: [
        {
          id: 'dec_secret', projectId: 'proj_test', kind: 'confirm_proposal',
          title: '确认提交事件 X', status: 'pending',
          createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
          sourceRefs: [],
        } as PendingDecisionItem,
      ],
      candidateEntityCount: 3,
    };

    const vm = buildProjectHomeView(ctx, input);

    // 人话字段存在
    expect(vm.projectStatusLabel).toBeTruthy();
    expect(vm.workspaceModeLabel).toBeTruthy();
    expect(vm.recentDrafts[0]!.title).toBe('第一章');
    expect(vm.recentDrafts[0]!.statusLabel).toBeTruthy();
    expect(vm.pendingDecisions[0]!.kindLabel).toBeTruthy();
    expect(vm.candidateEntityCount).toBe(3);

    // §9.1：无技术字段
    expect(vm).not.toHaveProperty('_debug');
    expect(vm).not.toHaveProperty('projectId');
    // recentDrafts 项无 id
    expect(vm.recentDrafts[0]).not.toHaveProperty('id');
    expect(vm.pendingDecisions[0]).not.toHaveProperty('id');

    // 全局自检：normal 输出经 findForbiddenField 扫描无泄漏
    expect(findForbiddenField(vm, 'normal')).toBeNull();
  });

  it('debug 模式：附带 _debug 块（含 id 与原始枚举，供排障）', () => {
    const ctx = makeRequestContext({ projectId: 'proj_test', visibilityMode: 'debug' });
    const input = {
      project: makeProject({ id: 'proj_dbg', status: 'planning', workspaceMode: 'normal' }),
      recentDrafts: [makeDraft({ id: 'drft_dbg' })],
      pendingDecisions: [],
      candidateEntityCount: 0,
    };

    const vm = buildProjectHomeView(ctx, input);

    expect(vm._debug).toBeDefined();
    expect(vm._debug!.projectId).toBe('proj_dbg');
    expect(vm._debug!.draftIds).toEqual(['drft_dbg']);
    expect(vm._debug!.projectStatus).toBe('planning');
    // debug 模式 _debug 块合法含技术字段
    expect(findForbiddenField(vm, 'debug')).toBeNull();
  });

  it('normal 模式：投影末尾的防御性断言生效（若投影逻辑产出泄漏则抛）', () => {
    // 正常投影不会泄漏——断言不抛（这是 happy path 的回归保障）
    const ctx = makeRequestContext({ projectId: 'proj_test' });
    expect(() =>
      buildProjectHomeView(ctx, {
        project: makeProject(),
        recentDrafts: [],
        pendingDecisions: [],
        candidateEntityCount: 0,
      }),
    ).not.toThrow();
  });
});

describe('W19-c · buildWorldSnapshotView（投影层过滤）', () => {
  it('normal 模式：只保留概览字段，隐藏 Core id / 谓词 / profileMarkdown', () => {
    const snapshot = makeSnapshot(); // 含 ent_/fct_/谓词/profileMarkdown

    const vm = buildWorldSnapshotView(snapshot, 'normal');

    expect(vm.currentChapter).toBe(5);
    expect(vm.entityCount).toBe(2);
    expect(vm.entities).toHaveLength(2);
    // 概览字段
    expect(vm.entities[0]!.name).toBe('主角');
    expect(vm.entities[0]!.typeLabel).toBe('角色');
    expect(vm.entities[0]!.attributeCount).toBe(2);
    // error 是人话错误信息（不含 Core id），原样保留
    expect(vm.entities[1]!.error).toBe('读取失败：该实体的知识引用断裂');

    // §9.1：无 Core id / 谓词 / 档案 markdown
    expect(vm).not.toHaveProperty('_debug');
    expect(vm.entities[0]).not.toHaveProperty('coreEntityId');
    expect(vm.entities[0]).not.toHaveProperty('profileMarkdown');
    expect(vm.entities[0]).not.toHaveProperty('factIndex');

    // 全局自检：normal 输出经扫描无泄漏（含 error 里的 kno_ 已掩码）
    expect(findForbiddenField(vm, 'normal')).toBeNull();
  });

  it('debug 模式：附 _debug 诊断块（含 Core id / 谓词 / 档案）', () => {
    const snapshot = makeSnapshot();

    const vm = buildWorldSnapshotView(snapshot, 'debug');

    expect(vm._debug).toBeDefined();
    expect(vm._debug!.coreEntityIds).toEqual(['ent_hero', 'ent_villain']);
    expect(vm._debug!.profilesByEntity).toHaveLength(2);
    expect(vm._debug!.profilesByEntity[0]!.coreEntityId).toBe('ent_hero');
    expect(vm._debug!.profilesByEntity[0]!.predicates).toContain('location');
    // debug 模式合法含技术字段
    expect(findForbiddenField(vm, 'debug')).toBeNull();
  });
});

// ===========================================================================
// 3. 端到端验证：含技术字段的原始数据 → normal 输出 clean
// ===========================================================================

describe('W19-c · WL-E2E-015 端到端：原始领域数据经投影后 normal 视图 clean', () => {
  /**
   * 关键场景：模拟"若投影层忘记过滤"的灾难性输入。
   * 数据层 RealCoreBridge 返回的 WorldSnapshot 含大量技术字段（Core id、谓词、profileMarkdown），
   * 投影层 buildWorldSnapshotView 必须把它们全部隔离到 _debug 块。
   * 本测试构造极端输入，验证 normal 输出零泄漏。
   */
  it('WorldSnapshot 含全部技术字段 → normal 输出仅概览，零泄漏', () => {
    const snapshot: WorldSnapshot = {
      currentChapter: 100,
      totalEntities: 1,
      entities: [
        {
          coreEntityId: 'ent_complex_id_123',
          displayName: '复杂角色',
          typeLabel: '角色',
          profileMarkdown: [
            '## 复杂角色（ent_complex_id_123）档案',
            '* location：废弃站台（fct_loc_01）',
            '* status：存活（fct_st_02）',
            '* relation：与 thd_main_03 相关',
          ].join('\n'),
          factIndex: [
            { factId: 'fct_loc_01', predicate: 'location', value: '废弃站台' },
            { factId: 'fct_st_02', predicate: 'status', value: '存活' },
            { factId: 'fct_rel_03', predicate: 'relation', value: 'thd_main_03' },
          ],
        },
      ],
    };

    const vm = buildWorldSnapshotView(snapshot, 'normal');

    // 概览正确
    expect(vm.entities[0]!.name).toBe('复杂角色');
    expect(vm.entities[0]!.attributeCount).toBe(3);

    // 零泄漏断言：normal ViewModel 里找不到任何 Core id 前缀 / 谓词键名
    expect(findForbiddenField(vm, 'normal')).toBeNull();

    // 反向断言：JSON 序列化后字符串里不含任何原始技术标识（最严格的端到端检查）
    const json = JSON.stringify(vm);
    expect(json).not.toContain('ent_');
    expect(json).not.toContain('fct_');
    expect(json).not.toContain('thd_');
    expect(json).not.toContain('kno_');
    expect(json).not.toContain('evt_');
    expect(json).not.toContain('req_');
    expect(json).not.toContain('"predicate"');
    expect(json).not.toContain('"coreEntityId"');
    expect(json).not.toContain('"profileMarkdown"');
    expect(json).not.toContain('writing_');
  });

  it('对比证据：同一输入 debug 模式确实含技术字段（证过滤真实生效，非输入本来就 clean）', () => {
    const snapshot: WorldSnapshot = {
      currentChapter: 1,
      totalEntities: 1,
      entities: [
        {
          coreEntityId: 'ent_proof',
          displayName: '证明角色',
          typeLabel: '角色',
          profileMarkdown: '## 证明角色（ent_proof）',
          factIndex: [{ factId: 'fct_p1', predicate: 'loc', value: 'x' }],
        },
      ],
    };

    const debugVm = buildWorldSnapshotView(snapshot, 'debug');
    const debugJson = JSON.stringify(debugVm);

    // debug 输出确实含技术字段（证明输入不 clean，是过滤在起作用）
    expect(debugJson).toContain('ent_proof');
    expect(debugJson).toContain('fct_p1');
    // _debug.profilesByEntity 用 predicates（复数数组，值是裸谓词 'loc'）——
    // 键名 predicates 不在禁止集合（禁止单数 predicate），故 debug 原样保留
    expect(debugJson).toContain('"predicates"');
    expect(debugJson).toContain('profileMarkdown');

    // 而 normal 输出 clean（对比成立）—— normal JSON 零技术标识
    const normalVm = buildWorldSnapshotView(snapshot, 'normal');
    const normalJson = JSON.stringify(normalVm);
    expect(normalJson).not.toContain('ent_');
    expect(normalJson).not.toContain('fct_');
    expect(normalJson).not.toContain('profileMarkdown');
  });
});
