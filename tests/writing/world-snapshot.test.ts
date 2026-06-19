// =============================================================================
// W8 单元测试：WorldSnapshot ViewModel 投影（buildWorldSnapshotView）
// =============================================================================
// 验证 §7.7 步骤 2/3：数据层 WorldSnapshot（含 ent_/fct_ 原始 id + Core profileMarkdown）
//   → 面向作者 ViewModel。
//   - normal：只留 §9.1-clean 概览（显示名/类型/设定计数），剥离 coreEntityId / factIndex /
//     profileMarkdown（Core 渲染的档案含原始 id 与谓词，不满足可见性）
//   - debug ：附 _debug 诊断块（原始 id / 谓词 / 档案）
// =============================================================================

import { describe, it, expect } from 'vitest';
import { buildWorldSnapshotView } from '../../src/writing/view-models/world-snapshot.js';
import type { WorldSnapshot } from '../../src/writing/core-bridge/core-bridge-service.js';

/** 构造带原始 Core id + 含泄漏的 profileMarkdown 的数据层快照 */
function snapshot(): WorldSnapshot {
  return {
    currentChapter: 3,
    totalEntities: 2,
    entities: [
      {
        displayName: '沈笙', typeLabel: '角色', coreEntityId: 'ent_shensheng',
        // 注：Core renderEntityProfile 输出的档案含原始 id（## 沈笙（ent_shensheng））与谓词
        profileMarkdown: '## 沈笙（ent_shensheng）档案\n* location：废弃站台',
        factIndex: [{ factId: 'fct_loc_1', predicate: 'location', value: '废弃站台' }],
      },
      {
        displayName: '黑晶碎片', typeLabel: '物品', coreEntityId: 'ent_heijing',
        profileMarkdown: '', factIndex: [],
        error: '[ENTITY_NOT_FOUND] 实体在 Core 不存在',
      },
    ],
  };
}

describe('W8 buildWorldSnapshotView · normal 模式', () => {
  it('保留显示名/类型/设定计数，剥离 coreEntityId / factIndex / profileMarkdown', () => {
    const vm = buildWorldSnapshotView(snapshot(), 'normal');

    expect(vm.currentChapter).toBe(3);
    expect(vm.entityCount).toBe(2);
    expect(vm.entities).toHaveLength(2);

    expect(vm.entities[0]!.name).toBe('沈笙');
    expect(vm.entities[0]!.typeLabel).toBe('角色');
    expect(vm.entities[0]!.attributeCount).toBe(1);
    // 数据层字段全部剥离（§9.1）
    expect('coreEntityId' in vm.entities[0]!).toBe(false);
    expect('factIndex' in vm.entities[0]!).toBe(false);
    expect('profileMarkdown' in vm.entities[0]!).toBe(false);
  });

  it('读取失败的实体保留人话 error，不泄漏原始 id', () => {
    const vm = buildWorldSnapshotView(snapshot(), 'normal');
    expect(vm.entities[1]!.error).toBe('[ENTITY_NOT_FOUND] 实体在 Core 不存在');
    expect('coreEntityId' in vm.entities[1]!).toBe(false);
  });

  it('normal 模式无 _debug 块，序列化后绝不出现 ent_/fct_/evt_ 与裸谓词 location', () => {
    const vm = buildWorldSnapshotView(snapshot(), 'normal');
    expect('_debug' in vm).toBe(false);
    // 深度扫描：整个 ViewModel 序列化不含任何 Core 前缀（数据层 id / Core 档案均未带入）
    const json = JSON.stringify(vm);
    expect(json).not.toMatch(/ent_|fct_|evt_|thd_/);
    // 裸谓词 token 'location' 也不得泄漏（仅 debug _debug 块可携带）
    expect(json).not.toContain('location');
  });
});

describe('W8 buildWorldSnapshotView · debug 模式', () => {
  it('附 _debug 诊断块（含原始 coreEntityId / factId / 谓词 / 档案）', () => {
    const vm = buildWorldSnapshotView(snapshot(), 'debug');

    expect(vm._debug).toBeDefined();
    expect(vm._debug!.coreEntityIds).toEqual(['ent_shensheng', 'ent_heijing']);
    const hero = vm._debug!.profilesByEntity[0]!;
    expect(hero.name).toBe('沈笙');
    expect(hero.factIds).toEqual(['fct_loc_1']);
    expect(hero.predicates).toEqual(['location']);
    expect(hero.profileMarkdown).toContain('ent_shensheng'); // debug 允许原始 id
    expect(vm._debug!.profilesByEntity[1]!.factIds).toEqual([]); // 失败实体无 fact
  });

  it('debug 模式主体字段与 normal 一致（_debug 是额外附加，主体仍 clean）', () => {
    const vm = buildWorldSnapshotView(snapshot(), 'debug');
    expect(vm.entities[0]!.name).toBe('沈笙');
    expect(vm.entities[0]!.attributeCount).toBe(1);
    // 主体仍剥离技术字段，仅 _debug 携带
    expect('coreEntityId' in vm.entities[0]!).toBe(false);
    expect('profileMarkdown' in vm.entities[0]!).toBe(false);
  });
});

describe('W8 buildWorldSnapshotView · 边界', () => {
  it('空快照（无实体）投影为空列表，不崩溃', () => {
    const vm = buildWorldSnapshotView(
      { currentChapter: 1, totalEntities: 0, entities: [] },
      'normal',
    );
    expect(vm.entityCount).toBe(0);
    expect(vm.entities).toEqual([]);
    expect(JSON.stringify(vm)).not.toMatch(/ent_|fct_/);
  });
});
