// =============================================================================
// W2：写作层上下文组装单元测试（assembleWritingContext）
// =============================================================================
// 验证 §8.3.3 写作层状态注入：已注册实体段 + 待确认决策段，含 >30 实体截断、过滤逻辑、空项目。
// 纯函数测试——直接调 assembleWritingContext，不经过 Agent / LLM（范式对齐 tool-permissions.test.ts）。
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { SQLiteFactStoreAdapter } from '../../src/adapters/sqlite/fact-store.js';
import { SQLiteWritingStore } from '../../src/writing/repositories/writing-store.js';
import { AuditService } from '../../src/writing/services/audit-service.js';
import { WorkflowService } from '../../src/writing/services/workflow-service.js';
import { makeRequestContext } from '../../src/writing/services/context.js';
import { assembleWritingContext } from '../../src/writing/agent/context-assembly.js';
import type { WritingLayerServices } from '../../src/writing/agent/agent-adapter.js';
import type { WorldSnapshot } from '../../src/writing/core-bridge/core-bridge-service.js';

interface Env {
  writingStore: SQLiteWritingStore;
  workflowService: WorkflowService;
  projectId: string;
  services: WritingLayerServices;
  ctx: ReturnType<typeof makeRequestContext>;
}

/** 搭建最小写作层栈（真实 SQLite :memory: + 真实 store/service），无 Core、无 LLM */
function createEnv(): Env {
  const factStore = new SQLiteFactStoreAdapter(':memory:', 'default');
  const db = factStore.getDatabase();
  const writingStore = new SQLiteWritingStore(db);
  writingStore.createTables();
  const audit = new AuditService(writingStore);
  const workflowService = new WorkflowService(writingStore, audit);
  const projectId = writingStore.createProject('ctx-asm 测试作品').id;
  const services: WritingLayerServices = { writingStore, workflowService };
  const ctx = makeRequestContext({ projectId, sessionId: 's1', trigger: 'agent_suggestion' });
  return { writingStore, workflowService, projectId, services, ctx };
}

/** 种一个已注册实体（status=registered + coreEntityId 已回填——真正写入 Core 的实体） */
function seedRegisteredEntity(env: Env, displayName: string, coreId: string, typeLabel = '角色'): void {
  const sketch = env.writingStore.createEntitySketch(env.projectId, {
    displayName,
    typeLabel,
    status: 'registered',
  });
  env.writingStore.updateEntitySketch(sketch.id, { coreEntityId: coreId });
}

describe('W2 · assembleWritingContext 写作层状态注入', () => {
  let env: Env;

  beforeEach(() => {
    env = createEnv();
  });

  it('空项目：无已注册实体且无待确认决策 → 返回空串', () => {
    expect(assembleWritingContext(env.services, env.ctx)).toBe('');
  });

  it('已注册实体段：含 displayName (coreEntityId, typeLabel)', () => {
    seedRegisteredEntity(env, '主角', 'ent_hero');
    const out = assembleWritingContext(env.services, env.ctx);
    // coreEntityId 注入给 LLM（system message 通道，§9.1 不适用于 LLM 上下文）
    expect(out).toContain('主角 (ent_hero, 角色)');
    expect(out).toContain('当前已注册实体');
    // 无决策时不出现决策段标题
    expect(out).not.toContain('当前有待确认事项');
  });

  it('过滤：未回填 coreEntityId 的 registered 草图不注入（避免 LLM 引用未注册实体）', () => {
    // 有 coreEntityId 的注册实体 → 注入
    seedRegisteredEntity(env, '主角', 'ent_hero');
    // 无 coreEntityId 的注册实体 → 过滤（commit_event 会因 entities FK 失败，见 CLAUDE.md 陷阱 5）
    env.writingStore.createEntitySketch(env.projectId, {
      displayName: '神秘人',
      typeLabel: '角色',
      status: 'registered',
    });
    const out = assembleWritingContext(env.services, env.ctx);
    expect(out).toContain('主角');
    expect(out).not.toContain('神秘人');
  });

  it('过滤：candidate 状态实体不注入（仅 registered 进 LLM 上下文）', () => {
    seedRegisteredEntity(env, '主角', 'ent_hero');
    env.writingStore.createEntitySketch(env.projectId, {
      displayName: '候选 NPC',
      typeLabel: '角色',
      status: 'candidate',
    });
    const out = assembleWritingContext(env.services, env.ctx);
    expect(out).not.toContain('候选 NPC');
  });

  it('待确认决策段：含 [kind] title + 提醒', () => {
    env.workflowService.createPendingDecision(env.ctx, {
      kind: 'confirm_proposal',
      title: '确认提交事件：主角抵达废弃站台',
    });
    const out = assembleWritingContext(env.services, env.ctx);
    expect(out).toContain('[confirm_proposal] 确认提交事件：主角抵达废弃站台');
    expect(out).toContain('请提醒用户确认或修改');
  });

  it('实体段 + 决策段同时存在：两段以空行分隔', () => {
    seedRegisteredEntity(env, '主角', 'ent_hero');
    env.workflowService.createPendingDecision(env.ctx, {
      kind: 'confirm_proposal',
      title: '确认提交',
    });
    const out = assembleWritingContext(env.services, env.ctx);
    expect(out).toContain('当前已注册实体');
    expect(out).toContain('当前有待确认事项');
    // 两段顺序：实体段在前，决策段在后
    expect(out.indexOf('当前已注册实体')).toBeLessThan(out.indexOf('当前有待确认事项'));
  });

  it('超过 30 个已注册实体：截断为 30 项并附截断提示', () => {
    for (let i = 0; i < 35; i++) {
      seedRegisteredEntity(env, `角色${i}`, `ent_${i}`);
    }
    const out = assembleWritingContext(env.services, env.ctx);
    // 截断提示明确告知总数与显示数（避免 LLM 误以为上下文即全部）
    expect(out).toContain('共 35 个已注册实体');
    expect(out).toContain('已截断仅显示前 30 个');
    // 顺序无关地断言"恰好显示 30 行"：每行实体以 ", 类型标签)" 结尾（typeLabel 固定为"角色"）
    const entityLineCount = (out.match(/, 角色\)/g) ?? []).length;
    expect(entityLineCount).toBe(30);
  });
});

// =============================================================================
// Fix-3：世界段注入（worldSnapshot 富实体段）—— §8.3.3 注入 Core 当前世界状态
// =============================================================================
// runReActLoop 每回合预取 WorldSnapshot 穿透进来时，启用"实体 + 当前设定事实"的富实体段
// （替代轻量 sketch 段）。验证：富段渲染、事实紧凑格式、读取失败标记、空事实标记、截断、
// snapshot 优先于 sketch、与决策段共存。
// =============================================================================

/** 构造最小 WorldSnapshot（纯数据对象，不经过 CoreBridge，直接喂给 assembleWritingContext） */
function makeSnapshot(
  entities: WorldSnapshot['entities'],
  currentChapter = 1,
): WorldSnapshot {
  return { currentChapter, totalEntities: entities.length, entities };
}

describe('W2 Fix-3 · assembleWritingContext 世界段注入（worldSnapshot 富实体段）', () => {
  let env: Env;

  beforeEach(() => {
    env = createEnv();
  });

  it('富实体段：渲染 displayName (coreEntityId, typeLabel) + 紧凑 predicate=value 事实 + 章节标', () => {
    const snapshot = makeSnapshot(
      [{
        displayName: '主角',
        typeLabel: '角色',
        coreEntityId: 'ent_hero',
        profileMarkdown: '（冗长 profile，不应注入——只取 factIndex）',
        factIndex: [
          { factId: 'fct_1', predicate: 'location', value: '废弃站台' },
          { factId: 'fct_2', predicate: 'status', value: '警戒' },
        ],
      }],
      3,
    );
    const out = assembleWritingContext(env.services, env.ctx, snapshot);
    // 富段标题 + 章节标
    expect(out).toContain('当前已注册实体与世界状态');
    expect(out).toContain('（第 3 章）');
    // 实体行：name (coreEntityId, typeLabel)——coreEntityId 注入给 LLM（system message 通道）
    expect(out).toContain('主角 (ent_hero, 角色)');
    // 紧凑事实格式：predicate=value，以"；"分隔
    expect(out).toContain('location=废弃站台；status=警戒');
    // profileMarkdown 是冗长人话，不应进 LLM 上下文（只取结构化 factIndex）
    expect(out).not.toContain('冗长 profile');
  });

  it('snapshot 优先于 sketch：传 worldSnapshot 时不回落 listEntitySketches 轻量段', () => {
    // store 里种了一个注册实体（轻量段会渲染它）
    seedRegisteredEntity(env, '主角', 'ent_hero');
    // 但 snapshot 描述的是另一个实体（Core 真相）
    const snapshot = makeSnapshot(
      [{
        displayName: '反派',
        typeLabel: '角色',
        coreEntityId: 'ent_villain',
        profileMarkdown: '',
        factIndex: [{ factId: 'fct_9', predicate: 'location', value: '暗影塔' }],
      }],
    );
    const out = assembleWritingContext(env.services, env.ctx, snapshot);
    // 富段渲染 snapshot 中的反派
    expect(out).toContain('反派 (ent_villain, 角色)');
    // snapshot 胜出：store 中的主角不被渲染（未回落 sketch 段）
    expect(out).not.toContain('主角');
  });

  it('读取失败实体：error 字段非空时标"（设定读取失败）"，但仍列出实体 ID（LLM 仍需构造 subject）', () => {
    const snapshot = makeSnapshot(
      [{
        displayName: '主角',
        typeLabel: '角色',
        coreEntityId: 'ent_hero',
        profileMarkdown: '',
        factIndex: [],
        error: 'get_context_slice 内部错误',
      }],
    );
    const out = assembleWritingContext(env.services, env.ctx, snapshot);
    expect(out).toContain('主角 (ent_hero, 角色)');
    expect(out).toContain('（设定读取失败）');
  });

  it('空 factIndex（已注册但暂无设定事实）：标"（暂无设定）"', () => {
    const snapshot = makeSnapshot(
      [{
        displayName: '主角',
        typeLabel: '角色',
        coreEntityId: 'ent_hero',
        profileMarkdown: '',
        factIndex: [],
      }],
    );
    const out = assembleWritingContext(env.services, env.ctx, snapshot);
    expect(out).toContain('主角 (ent_hero, 角色)');
    expect(out).toContain('（暂无设定）');
  });

  it('空事实谓词过滤：factIndex 中 predicate 为空的项不渲染（避免 "=value" 噪声）', () => {
    const snapshot = makeSnapshot(
      [{
        displayName: '主角',
        typeLabel: '角色',
        coreEntityId: 'ent_hero',
        profileMarkdown: '',
        factIndex: [
          { factId: 'fct_a', predicate: 'location', value: '废弃站台' },
          { factId: 'fct_b', predicate: '', value: '应被过滤的空谓词值' },
        ],
      }],
    );
    const out = assembleWritingContext(env.services, env.ctx, snapshot);
    expect(out).toContain('location=废弃站台');
    expect(out).not.toContain('应被过滤的空谓词值');
  });

  it('单实体事实超过 8 条：截断为前 8 条（避免撑爆上下文）', () => {
    const factIndex = Array.from({ length: 10 }, (_, i) => ({
      factId: `fct_${i}`,
      predicate: `k${i}`,
      value: `v${i}`,
    }));
    const snapshot = makeSnapshot(
      [{
        displayName: '主角',
        typeLabel: '角色',
        coreEntityId: 'ent_hero',
        profileMarkdown: '',
        factIndex,
      }],
    );
    const out = assembleWritingContext(env.services, env.ctx, snapshot);
    // 前 8 条渲染（k0..k7），第 9、10 条截断
    expect(out).toContain('k0=v0');
    expect(out).toContain('k7=v7');
    expect(out).not.toContain('k8=v8');
    expect(out).not.toContain('k9=v9');
  });

  it('快照实体超过 30 个：截断为 30 项并附截断提示', () => {
    const entities = Array.from({ length: 35 }, (_, i) => ({
      displayName: `角色${i}`,
      typeLabel: '角色',
      coreEntityId: `ent_${i}`,
      profileMarkdown: '',
      factIndex: [],
    }));
    const snapshot = makeSnapshot(entities);
    const out = assembleWritingContext(env.services, env.ctx, snapshot);
    expect(out).toContain('共 35 个已注册实体');
    expect(out).toContain('已截断仅显示前 30 个');
    const entityLineCount = (out.match(/, 角色\)/g) ?? []).length;
    expect(entityLineCount).toBe(30);
  });

  it('空快照（0 实体）：不渲染实体段；若无决策则整体返回空串', () => {
    const snapshot = makeSnapshot([]);
    const out = assembleWritingContext(env.services, env.ctx, snapshot);
    expect(out).toBe('');
  });

  it('富实体段 + 决策段共存：snapshot 与 pending decision 同时存在，两段以空行分隔', () => {
    const snapshot = makeSnapshot(
      [{
        displayName: '主角',
        typeLabel: '角色',
        coreEntityId: 'ent_hero',
        profileMarkdown: '',
        factIndex: [{ factId: 'fct_1', predicate: 'location', value: '废弃站台' }],
      }],
    );
    env.workflowService.createPendingDecision(env.ctx, {
      kind: 'confirm_proposal',
      title: '确认提交',
    });
    const out = assembleWritingContext(env.services, env.ctx, snapshot);
    expect(out).toContain('当前已注册实体与世界状态');
    expect(out).toContain('当前有待确认事项');
    // 两段顺序：富实体段在前，决策段在后
    expect(out.indexOf('当前已注册实体与世界状态')).toBeLessThan(out.indexOf('当前有待确认事项'));
  });
});
