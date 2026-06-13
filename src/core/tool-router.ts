// =============================================================================
// ToolRouter — 统一 Tool 调度层
// =============================================================================
// Phase 6B 核心产出。将分散在 ProposalManager / RetconEngine / ToolService /
// SchemaExtensionManager 中的 10 个 Tool 收敛到一个统一入口。
//
// 职责：
//   - execute(toolName, params) → ToolResult<T>  路由 + 参数校验 + 统一错误包装
//   - getDefinitions() → ToolDefinition[]         生成 JSON Schema 供 LLM function calling
//
// 与架构文档的对应关系：
//   §9.2 10 个 Tool Interface — 所有 Tool 的输入/输出类型
//   §6B Tool Router         — 本文件
// =============================================================================

import { ProposalManager } from './proposal-manager.js';
import { RetconEngine } from './retcon-engine.js';
import { ToolService } from './tool-service.js';
import { SchemaExtensionManager } from './schema-extension-manager.js';
import type {
  FactStore,
  KnowledgeStore,
  EventStore,
  ThreadStore,
  ToolResult,
  ToolError,
  EntityRecord,
  FactChangeInput,
} from '../types.js';
import { ToolErrorCode } from '../types.js';

// =============================================================================
// 内部：各 Tool 的 JSON Schema 定义
// =============================================================================

function buildToolDefinitions(): Record<string, Record<string, unknown>> {
  return {
    // Tool 1: get_context_slice
    get_context_slice: {
      name: 'get_context_slice',
      description: '获取特定实体在当前章节的完整状态档案（属性、关系、关联线索），返回 Markdown 渲染的档案和用于后续操作的 fact_index。',
      parameters: {
        type: 'object',
        properties: {
          entity_id: { type: 'string', description: '实体 ID，如 ent_zhangsan' },
          current_chapter: { type: 'number', description: '当前写作章节号' },
          include_relations: { type: 'boolean', description: '是否包含关系列表（默认 true）' },
        },
        required: ['entity_id', 'current_chapter'],
      },
    },

    // Tool 2: propose_event
    propose_event: {
      name: 'propose_event',
      description: '提议一个事件（沙盒推演）。必须用 fact_changes 数组描述事实变更；返回 SAFE 后再调用 commit_event。支持知识操作、线索关闭、作用域退出和依赖声明。',
      parameters: {
        type: 'object',
        properties: {
          event_type: { type: 'string', description: '事件类型，如 breakthrough/character_intro/meeting/battle' },
          event_description: { type: 'string', description: '事件自然语言描述' },
          chapter: { type: 'number', description: '章节号' },
          subject: { type: 'string', description: '事件主体实体ID' },
          // 核心：事实变更数组
          fact_changes: {
            type: 'array',
            description: '事实变更数组。assert 需要 subject/predicate/value；update/retract 需要 target_fact_id（从 get_context_slice 返回的 fact_index 中获取）。',
            items: {
              type: 'object',
              properties: {
                change_id: { type: 'string', description: '本次变更的临时 ID，如 c1' },
                op: { type: 'string', enum: ['assert', 'retract', 'update'], description: '变更操作' },
                target_fact_id: { type: 'string', description: 'update/retract 的目标 Fact ID（必须从 fact_index 获取）' },
                subject: { type: 'string', description: 'assert 的主体实体 ID' },
                predicate: { type: 'string', description: '谓词，如 realm/status/location/weapon/technique/mentor' },
                value: { description: '事实值，可为字符串、数字、布尔值或 entity_ref 对象 {type:"entity_ref", entityId:"ent_xxx"}' },
                relation_kind: { type: 'string', description: '可选关系语义标注，如 master/student/ally/enemy' },
                certainty: { type: 'string', description: '可选确定性标记' },
              },
              required: ['change_id', 'op'],
            },
          },
          // 兼容旧接口
          changes: { type: 'string', description: '【已废弃】fact_changes 的 JSON 字符串。请使用 fact_changes 数组。' },
          context: { type: 'string', description: '作用域，默认 "global"。梦境/副本等特殊场景使用。' },
          // §10.1 作用域退出：从某作用域离开时，Core 自动处理作用域清理
          exit_from: { type: 'string', description: '退出指定作用域（如 "dream_realm"）。Core 会将被退出作用域中 subject+predicate 匹配的当前 Fact 注入 dependent_fact_ids。' },
          // §4.5 线索管理：手动关闭伏笔/铺垫
          thread_resolutions: {
            type: 'array',
            description: '需要手动关闭的线索（Thread）ID 列表。用于在事件中收束伏笔。',
            items: { type: 'string' },
          },
          // §5.3 知识细粒度推断：指定"谁通过什么方式知道了什么"
          knowledge_hints: {
            type: 'array',
            description: '知识可见性细粒度推断。指定具体实体对本次变更中某条 fact_change 的知晓情况。',
            items: {
              type: 'object',
              properties: {
                entityId: { type: 'string', description: '获得新知识的实体 ID' },
                factIndex: { type: 'number', description: '对应 fact_changes 中的索引（从0开始）。省略则应用到所有变更。' },
                source: { type: 'string', description: '知识来源：self_action/witnessed/informed/inferred/rumor/revelation' },
                confidence: { type: 'number', description: '确信度 0.0-1.0，默认 1.0' },
              },
              required: ['entityId', 'source'],
            },
          },
          // §5.3 知识粗粒度广播：批量传播知识
          knowledge_broadcast: {
            type: 'object',
            description: '知识可见性粗粒度广播。向一组实体批量传播本次事件的知识。',
            properties: {
              visibility: { type: 'string', enum: ['explicit_entities', 'faction_members', 'scene_participants'], description: '广播范围' },
              target_entity_ids: { type: 'array', items: { type: 'string' }, description: 'visibility=explicit_entities 时指定目标实体列表' },
              target_faction_id: { type: 'string', description: 'visibility=faction_members 时指定阵营 ID' },
              confidence: { type: 'number', description: '确信度 0.0-1.0，默认 1.0' },
              source: { type: 'string', description: '知识来源' },
            },
            required: ['visibility', 'source'],
          },
          // §5.4 知识显式操作：封印/恢复/衰减/搜魂/植入
          knowledge_changes: {
            type: 'array',
            description: '显式知识操作。seal=封印记忆（确信度压至0）; restore=恢复封印; decay=记忆衰退; soul_read=搜魂（目标实体知识被复制给source_entity）; implant=记忆植入',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['seal', 'restore', 'decay', 'soul_read', 'implant'], description: '知识操作类型' },
                target_entity_id: { type: 'string', description: '被操作的目标实体 ID' },
                fact_id_scope: { type: 'string', enum: ['all', 'by_predicate', 'by_time_range', 'explicit'], description: '操作范围' },
                fact_ids: { type: 'array', items: { type: 'string' }, description: 'scope=explicit 时指定具体 Fact ID 列表' },
                predicates: { type: 'array', items: { type: 'string' }, description: 'scope=by_predicate 时指定谓词列表' },
                time_range: { type: 'object', properties: { from: { type: 'number' }, to: { type: 'number' } }, description: 'scope=by_time_range 时指定时间范围' },
                source_entity_id: { type: 'string', description: 'soul_read 时：施法者（获得知识的一方）' },
                implanted_confidence: { type: 'number', description: 'implant 时：植入记忆的确信度' },
              },
              required: ['op', 'target_entity_id', 'fact_id_scope'],
            },
          },
          // §10.1 依赖声明：供 Retcon 级联追踪
          dependent_fact_ids: {
            type: 'array',
            description: '本次事件依赖的 Fact ID 列表。用于 Retcon 追溯因果链。从 get_context_slice 的 fact_index 中选取相关 Fact。',
            items: { type: 'string' },
          },
        },
        required: ['event_type', 'event_description', 'chapter', 'fact_changes'],
      },
    },

    // Tool 3: commit_event
    commit_event: {
      name: 'commit_event',
      description: '确认提交一个经过沙盒推演的事件。此操作不可逆——事件、Fact、Knowledge、Thread 将在一个原子事务中写入。',
      parameters: {
        type: 'object',
        properties: {
          proposal_id: { type: 'string', description: '必须填写 propose_event 返回的 proposal_id，不要填写 event_id' },
        },
        required: ['proposal_id'],
      },
    },

    // Tool 4: propose_retcon
    propose_retcon: {
      name: 'propose_retcon',
      description: '提议对历史事件进行回溯变更（Retcon）。系统会执行 BFS 级联遍历，找出所有受影响的下游 Fact、Knowledge、Thread，生成完整影响报告。作者确认后调用 commit_retcon 生效。',
      parameters: {
        type: 'object',
        properties: {
          target_event_id: { type: 'string', description: '需要回溯修改的原始事件 ID' },
          reason: { type: 'string', description: '回溯变更的原因' },
          chapter: { type: 'number', description: '当前写作章节号' },
        },
        required: ['target_event_id', 'reason', 'chapter'],
      },
    },

    // Tool 5: commit_retcon
    commit_retcon: {
      name: 'commit_retcon',
      description: '确认执行一个回溯变更提案。所有受影响的下游 Fact 将被标记为 contested，Knowledge 可能被重新计算，Thread 可能被恢复或废弃。',
      parameters: {
        type: 'object',
        properties: {
          retcon_proposal_id: { type: 'string', description: 'propose_retcon 返回的 proposal_id' },
        },
        required: ['retcon_proposal_id'],
      },
    },

    // Tool 6: resolve_thread
    resolve_thread: {
      name: 'resolve_thread',
      description: '手动关闭（或放弃）一条叙事线索。回溯型线索默认关闭为 FILLED，渐进型默认关闭为 RESOLVED，也可以通过 new_status 手动指定。',
      parameters: {
        type: 'object',
        properties: {
          thread_id: { type: 'string', description: '线索 ID，如 thr_test_01' },
          resolution_event_id: { type: 'string', description: '触发关闭的事件 ID' },
          chapter: { type: 'number', description: '当前章节号' },
          explanation: { type: 'string', description: '关闭原因说明' },
          new_status: { type: 'string', description: '可选：手动指定目标状态（ABANDONED 等）' },
        },
        required: ['thread_id', 'resolution_event_id', 'chapter', 'explanation'],
      },
    },

    // Tool 7: get_open_threads
    get_open_threads: {
      name: 'get_open_threads',
      description: '获取所有未关闭的叙事线索清单，包含超期预警和可暗示线索列表。返回 Markdown 渲染的线索摘要。',
      parameters: {
        type: 'object',
        properties: {
          current_chapter: { type: 'number', description: '当前写作章节号' },
          severity_filter: {
            type: 'array',
            items: { type: 'string', enum: ['minor', 'major', 'critical'] },
            description: '按严重度过滤（可选）',
          },
          direction: { type: 'string', enum: ['retroactive', 'progressive'], description: '按方向过滤（可选）' },
        },
        required: ['current_chapter'],
      },
    },

    // Tool 8: register_entity
    register_entity: {
      name: 'register_entity',
      description: '注册一个新实体（角色、地点、物品、组织等）。系统生成唯一的实体 ID 并写入 entities 表和初始事件。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '实体名称（拼音连写），如 lisi' },
          kind: { type: 'string', description: '实体分类（entity/place/item/organization 等）' },
          description: { type: 'string', description: '实体描述（可选）' },
          chapter: { type: 'number', description: '实体首次出场章节号' },
          tags: { type: 'array', items: { type: 'string' }, description: '自定义标签（可选）' },
        },
        required: ['name', 'kind', 'chapter'],
      },
    },

    // Tool 9: propose_schema_extension
    propose_schema_extension: {
      name: 'propose_schema_extension',
      description: '提议扩展 World Package 的 Schema（新增谓词、规则、实体模板、作用域预设）。系统检测命名冲突后返回提案。作者确认后调用 commit_schema_extension 生效。',
      parameters: {
        type: 'object',
        properties: {
          chapter: { type: 'number', description: '当前章节号' },
          new_predicates: { type: 'array', description: '新增谓词定义列表' },
          new_rules: { type: 'array', description: '新增规则定义列表' },
        },
        required: ['chapter'],
      },
    },

    // Tool 10: commit_schema_extension
    commit_schema_extension: {
      name: 'commit_schema_extension',
      description: '确认提交一个 Schema 扩展提案。系统将在事务中写入 wp_* 表并生成系统审计事件。',
      parameters: {
        type: 'object',
        properties: {
          proposal_id: { type: 'string', description: 'propose_schema_extension 返回的 proposal_id' },
        },
        required: ['proposal_id'],
      },
    },
  };
}

// =============================================================================
// ToolRouter
// =============================================================================

export class ToolRouter {
  private proposalManager: ProposalManager;
  private retconEngine: RetconEngine;
  private toolService: ToolService;
  private schemaExtensionManager: SchemaExtensionManager;
  private factStore: FactStore;
  private knowledgeStore: KnowledgeStore;
  private eventStore: EventStore;
  private threadStore: ThreadStore;
  // P1-1 修复：entityIdSeq 已移除——实体 ID 改用 entities 表存在性探测（见 handleRegisterEntity），持久化且重启安全

  constructor(deps: {
    proposalManager: ProposalManager;
    retconEngine: RetconEngine;
    toolService: ToolService;
    schemaExtensionManager: SchemaExtensionManager;
    factStore: FactStore;
    knowledgeStore: KnowledgeStore;
    eventStore: EventStore;
    threadStore: ThreadStore;
  }) {
    this.proposalManager = deps.proposalManager;
    this.retconEngine = deps.retconEngine;
    this.toolService = deps.toolService;
    this.schemaExtensionManager = deps.schemaExtensionManager;
    this.factStore = deps.factStore;
    this.knowledgeStore = deps.knowledgeStore;
    this.eventStore = deps.eventStore;
    this.threadStore = deps.threadStore;
  }

  // =========================================================================
  // execute — 统一 Tool 执行入口
  // =========================================================================

  /**
   * 执行一个 Tool 调用
   *
   * @param toolName Tool 名称（如 'get_context_slice'）
   * @param params   调用参数（snake_case 键名）
   * @returns ToolResult<T> 成功/失败结果
   */
  async execute(toolName: string, params: Record<string, unknown>): Promise<ToolResult<unknown>> {
    try {
      switch (toolName) {
        case 'get_context_slice':       return await this.handleGetContextSlice(params);
        case 'propose_event':           return await this.handleProposeEvent(params);
        case 'commit_event':            return await this.handleCommitEvent(params);
        case 'propose_retcon':          return await this.handleProposeRetcon(params);
        case 'commit_retcon':           return await this.handleCommitRetcon(params);
        case 'resolve_thread':          return await this.handleResolveThread(params);
        case 'get_open_threads':        return await this.handleGetOpenThreads(params);
        case 'register_entity':         return await this.handleRegisterEntity(params);
        case 'propose_schema_extension': return await this.handleProposeSchemaExtension(params);
        case 'commit_schema_extension': return await this.handleCommitSchemaExtension(params);
        default:
          return this.error(ToolErrorCode.UNKNOWN_TOOL, `未知工具: ${toolName}`, false, `可用工具: ${this.toolNames().join(', ')}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 检查是否是已知的 ToolErrorCode
      for (const code of Object.values(ToolErrorCode)) {
        if (msg.includes(code)) {
          return this.error(code as ToolErrorCode, msg, this.isRetryable(code as ToolErrorCode));
        }
      }
      return this.error(ToolErrorCode.TRANSACTION_FAILED, msg, false);
    }
  }

  // =========================================================================
  // getDefinitions — 生成 LLM function calling 可用的工具定义
  // =========================================================================

  /** 返回所有 10 个 Tool 的 JSON Schema 定义 */
  getDefinitions() {
    const schemas = buildToolDefinitions();
    return Object.values(schemas).map(s => ({
      name: s.name as string,
      description: s.description as string,
      parameters: s.parameters as Record<string, unknown>,
    }));
  }

  /** 返回所有 Tool 名称列表 */
  toolNames(): string[] {
    return [
      'get_context_slice', 'propose_event', 'commit_event',
      'propose_retcon', 'commit_retcon', 'resolve_thread',
      'get_open_threads', 'register_entity',
      'propose_schema_extension', 'commit_schema_extension',
    ];
  }

  // =========================================================================
  // Tool 1: get_context_slice
  // =========================================================================

  private async handleGetContextSlice(params: Record<string, unknown>) {
    const entityId = requireString(params, 'entity_id');
    const currentChapter = requireNumber(params, 'current_chapter');
    const includeRelations = typeof params['include_relations'] === 'boolean'
      ? params['include_relations'] : true;

    const result = await this.toolService.getContextSlice({
      entityId,
      currentChapter,
      includeRelations,
      entityNames: params['entity_names'] as Record<string, string> | undefined,
    });

    return this.ok(result);
  }

  // =========================================================================
  // Tool 2: propose_event
  // =========================================================================

  private async handleProposeEvent(params: Record<string, unknown>) {
    const eventType = requireString(params, 'event_type');
    const eventDescription = requireStringAlias(params, 'event_description', ['event_summary', 'description']);
    const chapter = requireNumber(params, 'chapter');
    const factChanges = parseFactChanges(params);

    // snake_case → camelCase 映射（LLM 使用 snake_case，Core 使用 camelCase）
    const proposalParams = {
      eventType,
      eventDescription,
      chapter,
      subject: typeof params['subject'] === 'string' ? params['subject'] : undefined,
      factChanges,
      context: typeof params['context'] === 'string' ? params['context'] : undefined,
      exitFrom: typeof params['exit_from'] === 'string' ? params['exit_from'] : undefined,
      threadResolutions: Array.isArray(params['thread_resolutions']) ? params['thread_resolutions'] as string[] : undefined,
      knowledgeHints: Array.isArray(params['knowledge_hints']) ? params['knowledge_hints'] : undefined,
      knowledgeBroadcast: typeof params['knowledge_broadcast'] === 'object' && params['knowledge_broadcast'] !== null
        ? params['knowledge_broadcast'] : undefined,
      knowledgeChanges: Array.isArray(params['knowledge_changes']) ? params['knowledge_changes'] : undefined,
      dependentFactIds: Array.isArray(params['dependent_fact_ids']) ? params['dependent_fact_ids'] as string[] : undefined,
    };

    const result = this.proposalManager.proposeEvent(
      proposalParams as any,
      this.factStore,
    );

    return this.ok(result);
  }

  // =========================================================================
  // Tool 3: commit_event
  // =========================================================================

  private async handleCommitEvent(params: Record<string, unknown>) {
    const proposalId = requireString(params, 'proposal_id');

    const result = this.proposalManager.commitEvent(
      proposalId,
      this.factStore as FactStore & { getDatabase?: () => any },
      this.knowledgeStore,
      this.eventStore,
    );

    // camelCase → snake_case 返回给 LLM
    return this.ok({
      event_id: result.eventId,
      committed_fact_count: result.committedFactCount,
      committed_knowledge_count: result.committedKnowledgeCount,
      affected_threads: result.affectedThreads,
    });
  }

  // =========================================================================
  // Tool 4: propose_retcon
  // =========================================================================

  private async handleProposeRetcon(params: Record<string, unknown>) {
    const targetEventId = requireString(params, 'target_event_id');
    const reason = requireString(params, 'reason');
    const chapter = requireNumber(params, 'chapter');

    const result = this.retconEngine.proposeRetcon(
      {
        targetEventId,
        reason,
        newDescription: reason, // newDescription 复用 reason
        chapter,
        factChanges: [],
      },
      this.factStore,
      this.eventStore,
      this.threadStore,
      this.knowledgeStore,
    );

    return this.ok(result);
  }

  // =========================================================================
  // Tool 5: commit_retcon
  // =========================================================================

  private async handleCommitRetcon(params: Record<string, unknown>) {
    const proposalId = requireString(params, 'retcon_proposal_id');

    const result = this.retconEngine.commitRetcon(
      { retconProposalId: proposalId },
      this.factStore as FactStore & { getDatabase?: () => any },
      this.eventStore,
      this.threadStore,
      this.knowledgeStore,
    );

    return this.ok(result);
  }

  // =========================================================================
  // Tool 6: resolve_thread
  // =========================================================================

  private async handleResolveThread(params: Record<string, unknown>) {
    const threadId = requireString(params, 'thread_id');
    const resolutionEventId = requireString(params, 'resolution_event_id');
    const chapter = requireNumber(params, 'chapter');
    const explanation = requireString(params, 'explanation');

    const result = this.proposalManager.resolveThread({
      threadId,
      resolutionEventId,
      chapter,
      explanation,
      newStatus: params['new_status'] as any,
    });

    return this.ok(result);
  }

  // =========================================================================
  // Tool 7: get_open_threads
  // =========================================================================

  private async handleGetOpenThreads(params: Record<string, unknown>) {
    const currentChapter = requireNumber(params, 'current_chapter');

    const result = await this.toolService.getOpenThreads({
      currentChapter,
      severityFilter: params['severity_filter'] as any,
      direction: params['direction'] as any,
      type: params['type'] as any,
    });

    return this.ok(result);
  }

  // =========================================================================
  // Tool 8: register_entity
  // =========================================================================

  private async handleRegisterEntity(params: Record<string, unknown>) {
    const name = requireString(params, 'name');
    const kind = requireString(params, 'kind') as any;
    const description = typeof params['description'] === 'string' ? params['description'] : undefined;
    const chapter = requireNumber(params, 'chapter');
    const tags = Array.isArray(params['tags']) ? params['tags'] as string[] : undefined;

    // P1-11 修复：register_entity 的 events 写入与 entities 写入必须原子。
    // 原实现 eventStore.create 与 entities INSERT 分属两步独立执行，若其一失败会留下
    // "有注册事件但无实体"或反之的不一致状态，破坏实体注册表与事件溯源的对齐。
    // EventStore 与 FactStore 在 chat.ts 装配中共享同一 Database 实例，故可用单事务包裹。
    const db = (this.factStore as any).getDatabase?.();
    // 无 db（如测试 mock）时退化为非事务执行，保证代码路径统一、向后兼容
    const execAtomic = <T>(body: () => T): T => (db ? db.transaction(body)() : body());

    const { event, entityId } = execAtomic(() => {
      // P1-1 修复：实体 ID 生成消除内存 entityIdSeq，改用 entities 表存在性探测
      // 原内存计数器进程重启后清空，配合 existing 判断会生成已占用的 ent_{name}_01，
      // 而 entities 表 INSERT OR IGNORE 会静默丢失，导致新实体关联到旧 ID（语义错误）。
      // 探测置于事务内，保证"选定 ID"与"写入 ID"之间无并发窗口。
      const baseId = `ent_${name}`;
      let eid = baseId;
      let seq = 0;
      if (db) {
        // 循环探测直至找到 entities 表中不存在的 ID（持久化，重启后仍唯一）
        while (db.prepare('SELECT 1 FROM entities WHERE id = ?').get(eid)) {
          seq++;
          eid = `${baseId}_${String(seq).padStart(2, '0')}`;
        }
      }

      // 创建系统事件记录这次注册
      // 注：factGroupId 会被 EventStore.create 内部用生成的 event.id 覆盖（1:1 关系），此处仅占位
      const eventId = `evt_register_${name}_${chapter}_${String(seq).padStart(2, '0')}`;
      const evt = this.eventStore.create({
        kind: 'system',
        type: 'register_entity',
        chapter,
        description: description ?? `注册实体: ${name}`,
        params: { name, kind, entityId: eid, tags },
        context: 'global',
        timestamp: new Date().toISOString(),
        factGroupId: eventId,
        resolvedThreads: [],
        dependentFactIds: [],
      });

      // 写入 entities 表（直接 SQL — SQLite 适配器没有 registerEntity 方法）
      // P1-7 修复：tags 持久化到 entities.tags_json（原仅存 event.params，重启后查询丢失）
      if (db) {
        db.prepare(
          'INSERT OR IGNORE INTO entities (id, name, kind, first_appearance, tags_json) VALUES (?, ?, ?, ?, ?)'
        ).run(eid, name, kind, chapter, tags ? JSON.stringify(tags) : null);
      }

      return { event: evt, entityId: eid };
    });

    const record: EntityRecord = {
      id: entityId,
      name,
      kind,
      description,
      registeredAtChapter: chapter,
      registeredAtEvent: event.id,
      tags,
    };

    return this.ok({ entity_id: entityId, entity: record });
  }

  // =========================================================================
  // Tool 9: propose_schema_extension
  // =========================================================================

  private async handleProposeSchemaExtension(params: Record<string, unknown>) {
    const chapter = requireNumber(params, 'chapter');

    const proposals = [];

    // 处理新谓词
    const newPredicates = Array.isArray(params['new_predicates'])
      ? params['new_predicates'] as Array<Record<string, unknown>>
      : [];
    for (const pred of newPredicates) {
      const p = this.schemaExtensionManager.proposePredicate(pred as any);
      proposals.push({
        proposal_id: p.proposalId,
        extension_type: p.extensionType,
        summary: p.summary,
        conflicts: p.conflicts,
      });
    }

    // 处理新规则
    const newRules = Array.isArray(params['new_rules'])
      ? params['new_rules'] as Array<Record<string, unknown>>
      : [];
    for (const rule of newRules) {
      const r = this.schemaExtensionManager.proposeRule(rule as any);
      proposals.push({
        proposal_id: r.proposalId,
        extension_type: r.extensionType,
        summary: r.summary,
        conflicts: r.conflicts,
      });
    }

    return this.ok({ chapter, proposals, total_proposed: proposals.length });
  }

  // =========================================================================
  // Tool 10: commit_schema_extension
  // =========================================================================

  private async handleCommitSchemaExtension(params: Record<string, unknown>) {
    const proposalId = requireString(params, 'proposal_id');
    const result = this.schemaExtensionManager.commitExtension(proposalId);
    // commitExtension 返回 { status: 'success'/'failed' }，需区分处理
    if (result.status === 'success') {
      return this.ok(result);
    }
    // 映射已知错误消息到 ToolErrorCode
    if (result.errorMessage?.includes('NOT_FOUND')) {
      return this.error(ToolErrorCode.PROPOSAL_NOT_FOUND, result.errorMessage, false);
    }
    if (result.errorMessage?.includes('ALREADY_COMMITTED')) {
      return this.error(ToolErrorCode.STALE_PROPOSAL, result.errorMessage, false);
    }
    if (result.errorMessage?.includes('CONFLICT')) {
      return this.error(ToolErrorCode.PREDICATE_CONFLICT, result.errorMessage, false);
    }
    return this.error(ToolErrorCode.TRANSACTION_FAILED, result.errorMessage ?? '提交失败', false);
  }

  // =========================================================================
  // 辅助方法
  // =========================================================================

  /** 构造成功结果 */
  private ok<T>(data: T): ToolResult<T> {
    return { success: true, data };
  }

  /** 构造失败结果 */
  private error(code: ToolErrorCode, message: string, retryable: boolean, detail?: string): ToolResult<never> {
    const err: ToolError = { code, message, retryable };
    if (detail) err.detail = detail;
    return { success: false, error: err };
  }

  /** 判断错误码是否可重试 */
  private isRetryable(code: ToolErrorCode): boolean {
    switch (code) {
      case ToolErrorCode.TRANSACTION_FAILED:
      case ToolErrorCode.STATE_VERSION_CONFLICT:
        // STALE_PROPOSAL：commit_event 时乐观锁版本不匹配（世界状态在 propose→commit 间被其他提交改变），
        // 与 STATE_VERSION_CONFLICT 同属乐观锁冲突——重新 propose 即可恢复，故标记为可恢复。
      case ToolErrorCode.STALE_PROPOSAL:
        return true;
      default:
        return false;
    }
  }
}

// =============================================================================
// 参数校验辅助函数
// =============================================================================

function requireString(params: Record<string, unknown>, key: string): string {
  const val = params[key];
  if (typeof val !== 'string' || val.trim() === '') {
    throw new Error(`SCHEMA_VALIDATION_FAILED: 参数 '${key}' 必须是非空字符串，实际: ${JSON.stringify(val)}`);
  }
  return val;
}

function requireStringAlias(params: Record<string, unknown>, key: string, aliases: string[]): string {
  if (typeof params[key] === 'string' && params[key].trim() !== '') {
    return params[key];
  }
  for (const alias of aliases) {
    if (typeof params[alias] === 'string' && params[alias].trim() !== '') {
      return params[alias];
    }
  }
  throw new Error(`SCHEMA_VALIDATION_FAILED: 参数 '${key}' 必须是非空字符串，实际: ${JSON.stringify(params[key])}`);
}

function requireNumber(params: Record<string, unknown>, key: string): number {
  const val = params[key];
  if (typeof val !== 'number' || isNaN(val)) {
    throw new Error(`SCHEMA_VALIDATION_FAILED: 参数 '${key}' 必须是数字，实际: ${JSON.stringify(val)}`);
  }
  return val;
}

function parseFactChanges(params: Record<string, unknown>): FactChangeInput[] {
  const structured = params['fact_changes'];
  if (Array.isArray(structured)) {
    return structured as FactChangeInput[];
  }

  const legacy = params['changes'];
  if (typeof legacy === 'string' && legacy.trim() !== '') {
    try {
      const parsed = JSON.parse(legacy);
      if (!Array.isArray(parsed)) throw new Error('changes 必须解析为数组');
      return parsed as FactChangeInput[];
    } catch {
      throw new Error(`SCHEMA_VALIDATION_FAILED: changes 解析失败，请优先传入 fact_changes 数组。收到: ${legacy.slice(0, 100)}`);
    }
  }

  throw new Error(
    `SCHEMA_VALIDATION_FAILED: 参数 'fact_changes' 必须是数组，实际: ${JSON.stringify(structured)}`
  );
}
