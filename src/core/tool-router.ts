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
import { SchemaExtensionManager, type PredicateExtension, type RuleExtension } from './schema-extension-manager.js';
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

    // Tool 1b: detect_entity_hints（写作层实体检测——从正文/设定提取实体线索，建 hint 草图）
    detect_entity_hints: {
      name: 'detect_entity_hints',
      description: '从正文/设定中提取实体线索，创建候选实体草图（hint 状态）。每个 hint 需提供显示名和类型（如"角色"/"地点"/"物品"/"概念"）。这是注册实体的第一步——提取后系统会生成 hint 供作者审批，不要在回复中直接声称实体"已注册"。',
      parameters: {
        type: 'object',
        properties: {
          hints: {
            type: 'array',
            description: '提取到的实体线索列表（至少 1 个）',
            items: {
              type: 'object',
              properties: {
                display_name: { type: 'string', description: '实体显示名（如"沈墨"）' },
                type_label: { type: 'string', description: '类型标签：角色/地点/物品/概念/组织 等' },
                excerpt: { type: 'string', description: '正文中提及该实体的摘录（可选，用于追溯）' },
              },
              required: ['display_name', 'type_label'],
            },
            minItems: 1,
          },
        },
        required: ['hints'],
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

    // Tool 12: detect_relation_hints（Phase 8：关系检测）
    detect_relation_hints: {
      name: 'detect_relation_hints',
      description: '从对话中检测实体间关系，创建关系提示供作者审核。每个提示需提供源实体ID、目标实体ID、关系类型和摘要描述。这是发现隐含关系的第一步——检测后系统生成提示，作者确认后才成为正式关系候选。',
      parameters: {
        type: 'object',
        properties: {
          hints: {
            type: 'array',
            description: '检测到的关系提示列表（至少 1 个）',
            items: {
              type: 'object',
              properties: {
                source_entity_id: { type: 'string', description: '源实体 ID（如 ent_zhangsan）' },
                target_entity_id: { type: 'string', description: '目标实体 ID（如 ent_lisi）' },
                relation_type_id: { type: 'string', description: '关系类型（如 enemy_of、disciple_of）' },
                summary: { type: 'string', description: '关系描述（如"张三与李四是敌人"）' },
              },
              required: ['source_entity_id', 'target_entity_id', 'summary'],
            },
            minItems: 1,
          },
        },
        required: ['hints'],
      },
    },

    // Tool 13: get_graph_view（Phase 8：图谱查询）
    get_graph_view: {
      name: 'get_graph_view',
      description: '查询当前项目实体关系图谱。返回节点（实体）和边（关系）的完整网络视图，用于了解"谁和谁有关系、关系类型是什么"。',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['world', 'relationship'],
            description: '视图模式：world=全部实体+关系，relationship=仅角色+关系（默认 world）',
          },
          entity_filter: {
            type: 'array',
            items: { type: 'string' },
            description: '按实体类型过滤（如 ["角色"]），不传则返回全部',
          },
        },
      },
    },

    // Tool 14: detect_spatial_nodes（Phase 9：空间节点识别）
    detect_spatial_nodes: {
      name: 'detect_spatial_nodes',
      description: '从对话中识别空间节点（地点/空间层/区域等），创建空间节点写入系统供作者审核。',
      parameters: {
        type: 'object',
        properties: {
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: '空间节点名称' },
                type_id: { type: 'string', description: '空间类型 ID（引用蓝图 spatialNodeTypes）' },
                aliases: { type: 'array', items: { type: 'string' }, description: '别名列表' },
                description: { type: 'string', description: '描述' },
              },
              required: ['label', 'type_id'],
            },
            description: '识别到的空间节点列表',
          },
        },
        required: ['nodes'],
      },
    },

    // Tool 15: get_spatial_view（Phase 9：空间视图查询）
    get_spatial_view: {
      name: 'get_spatial_view',
      description: '查询当前项目空间视图。返回空间节点和空间边的完整网络，用于了解"地点在哪里、地点之间有什么关系"。',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['graph', 'tree'],
            description: '视图模式：graph=网络图，tree=层级树（默认 graph）',
          },
        },
      },
    },

    // Tool 16: create_chapter_plan（Phase 10：章节规划）
    create_chapter_plan: {
      name: 'create_chapter_plan',
      description: '创建章节规划。设置章节标题、目标、POV，用于组织叙事结构。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '章节标题' },
          order: { type: 'number', description: '章节顺序（数字越小越靠前）' },
          goals: { type: 'array', items: { type: 'string' }, description: '章节目标列表' },
          pov_entity_id: { type: 'string', description: 'POV 实体 ID（可选）' },
        },
        required: ['title', 'order'],
      },
    },

    // Tool 17: create_scene_plan（Phase 10：场景规划）
    create_scene_plan: {
      name: 'create_scene_plan',
      description: '创建场景规划。设置场景标题、所属章节、功能标签、参与者，用于组织场景结构。',
      parameters: {
        type: 'object',
        properties: {
          chapter_id: { type: 'string', description: '所属章节 ID' },
          title: { type: 'string', description: '场景标题' },
          order: { type: 'number', description: '场景在章节内的顺序' },
          purpose: { type: 'array', items: { type: 'string' }, description: '功能标签（setup/conflict/reveal/transition/payoff/reversal/character/worldbuilding）' },
          participants: { type: 'array', items: { type: 'string' }, description: '参与者实体 ID 列表' },
          spatial_node_id: { type: 'string', description: '关联的空间节点 ID（可选）' },
        },
        required: ['chapter_id', 'title', 'order'],
      },
    },

    // Tool 18: get_timeline_view（Phase 10：时间线查询）
    get_timeline_view: {
      name: 'get_timeline_view',
      description: '查询当前项目时间线。合并 Core 已提交事件 + 写作层计划/草案，用于了解"故事发生了什么、计划发生什么"。',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['world', 'narrative'],
            description: '时间线模式：world=世界时间顺序，narrative=叙述顺序（默认 world）',
          },
        },
      },
    },
    // Tool 19: create_foreshadowing_plan（Phase 11：伏笔计划）
    create_foreshadowing_plan: {
      name: 'create_foreshadowing_plan',
      description: '创建伏笔计划。设定伏笔类型、目标读者反应、关联实体。',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: '伏笔标签' },
          kind: { type: 'string', enum: ['clue', 'suspense', 'misdirection', 'red_herring', 'theme_echo', 'world_rule_hint'], description: '伏笔类型' },
          target_reader_effect: { type: 'string', description: '目标读者反应描述' },
          linked_entity_refs: { type: 'array', items: { type: 'string' }, description: '关联实体 ID 列表' },
        },
        required: ['label', 'kind', 'target_reader_effect'],
      },
    },

    // Tool 20: get_foreshadowing_plans（Phase 11：伏笔查询）
    get_foreshadowing_plans: {
      name: 'get_foreshadowing_plans',
      description: '查询当前项目所有伏笔计划。',
      parameters: { type: 'object', properties: {} },
    },

    // Tool 21: create_reader_knowledge_state（Phase 11：读者认知）
    create_reader_knowledge_state: {
      name: 'create_reader_knowledge_state',
      description: '记录读者在某个叙述位置的认知状态（已知/怀疑/误解/揭示等）。',
      parameters: {
        type: 'object',
        properties: {
          subject_ref: { type: 'string', description: '信息主体（实体ID或描述）' },
          state: { type: 'string', enum: ['unknown', 'hinted', 'suspected', 'known', 'misled', 'revealed', 'forgotten_risk'], description: '读者认知状态' },
          confidence: { type: 'number', description: '置信度 0-1' },
          narrative_position_type: { type: 'string', description: '叙述位置类型（chapter/scene）' },
          narrative_position_id: { type: 'string', description: '叙述位置 ID' },
        },
        required: ['subject_ref', 'state', 'narrative_position_type', 'narrative_position_id'],
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
  /**
   * 写作层实体检测服务（可选注入）。
   * detect_entity_hints 工具需要它。Core 层不硬依赖写作层（避免循环），
   * 用宽结构化类型（返回值不约束——EntityService 返回更具体的 WritingEntitySketch[] 兼容）。
   * 未注入时 detect_entity_hints 工具返回 INTERNAL_ERROR。
   *
   * 用 setter 延迟注入（chat.ts 里 ToolRouter 先于 entityService 创建，
   * 因 coreBridge→toolRouter 与 entityService→workflowService 存在依赖顺序）。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private entityService: { detectEntityHints: (ctx: any, hints: Array<{ displayName: string; typeLabel: string; excerpt?: string }>) => any } | undefined;
  private writingProjectId: string | undefined;
  // Phase 8：关系服务与图谱服务（可选注入，未注入时工具返回 INTERNAL_ERROR）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private relationService: any | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private graphService: any | undefined;
  // Phase 9：空间服务（可选注入）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private spatialService: any | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private spatialViewService: any | undefined;
  // Phase 10：章节/场景/时间线服务（可选注入）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private chapterService: any | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sceneService: any | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private timelineService: any | undefined;
  // Phase 11：读者/伏笔服务
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readerService: any | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private foreshadowingService: any | undefined;

  /** 延迟注入写作层实体检测服务（chat.ts 在 entityService 创建后调用） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setEntityService(svc: { detectEntityHints: (ctx: any, hints: Array<{ displayName: string; typeLabel: string; excerpt?: string }>) => any }, writingProjectId: string): void {
    this.entityService = svc;
    this.writingProjectId = writingProjectId;
  }

  /** 延迟注入写作层关系/图谱服务（chat.ts 在 relationService/graphService 创建后调用） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setGraphServices(relationService: any, graphService: any, writingProjectId: string): void {
    this.relationService = relationService;
    this.graphService = graphService;
    this.writingProjectId = writingProjectId;
  }

  /** 延迟注入写作层空间服务（chat.ts 在 spatialService 创建后调用） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setSpatialServices(spatialService: any, spatialViewService: any, writingProjectId: string): void {
    this.spatialService = spatialService;
    this.spatialViewService = spatialViewService;
    this.writingProjectId = writingProjectId;
  }

  /** 延迟注入写作层章节/场景/时间线服务（chat.ts 在服务创建后调用） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setChapterSceneServices(chapterService: any, sceneService: any, timelineService: any, writingProjectId: string): void {
    this.chapterService = chapterService;
    this.sceneService = sceneService;
    this.timelineService = timelineService;
    this.writingProjectId = writingProjectId;
  }

  /** 延迟注入写作层读者/伏笔服务 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setReaderForeshadowingServices(readerService: any, foreshadowingService: any, writingProjectId: string): void {
    this.readerService = readerService;
    this.foreshadowingService = foreshadowingService;
    this.writingProjectId = writingProjectId;
  }
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
    // 写作层可选注入（实体检测工具需要；Core 层不硬依赖写作层）
    entityService?: { detectEntityHints: (ctx: unknown, hints: Array<{ displayName: string; typeLabel: string; excerpt?: string }>) => unknown[] };
    writingProjectId?: string;
  }) {
    this.proposalManager = deps.proposalManager;
    this.retconEngine = deps.retconEngine;
    this.toolService = deps.toolService;
    this.schemaExtensionManager = deps.schemaExtensionManager;
    this.factStore = deps.factStore;
    this.knowledgeStore = deps.knowledgeStore;
    this.eventStore = deps.eventStore;
    this.threadStore = deps.threadStore;
    this.entityService = deps.entityService;
    this.writingProjectId = deps.writingProjectId;
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
        case 'detect_entity_hints':     return await this.handleDetectEntityHints(params);
        case 'propose_event':           return await this.handleProposeEvent(params);
        case 'commit_event':            return await this.handleCommitEvent(params);
        case 'propose_retcon':          return await this.handleProposeRetcon(params);
        case 'commit_retcon':           return await this.handleCommitRetcon(params);
        case 'resolve_thread':          return await this.handleResolveThread(params);
        case 'get_open_threads':        return await this.handleGetOpenThreads(params);
        case 'register_entity':         return await this.handleRegisterEntity(params);
        case 'propose_schema_extension': return await this.handleProposeSchemaExtension(params);
        case 'commit_schema_extension': return await this.handleCommitSchemaExtension(params);
        case 'detect_relation_hints':  return await this.handleDetectRelationHints(params);
        case 'get_graph_view':         return await this.handleGetGraphView(params);
        case 'detect_spatial_nodes':   return await this.handleDetectSpatialNodes(params);
        case 'get_spatial_view':       return await this.handleGetSpatialView(params);
        case 'create_chapter_plan':     return await this.handleCreateChapterPlan(params);
        case 'create_scene_plan':       return await this.handleCreateScenePlan(params);
        case 'get_timeline_view':       return await this.handleGetTimelineView(params);
        case 'create_foreshadowing_plan': return await this.handleCreateForeshadowingPlan(params);
        case 'get_foreshadowing_plans':  return await this.handleGetForeshadowingPlans(params);
        case 'create_reader_knowledge_state': return await this.handleCreateReaderKnowledgeState(params);
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

  /**
   * 返回 Tool 的 JSON Schema 定义（供 LLM function calling）。
   *
   * @param options.excludeForbidden 若 true，过滤掉 AGENT_FORBIDDEN_TOOLS 中的工具
   *   （commit_event/register_entity）——LLM 看不到禁用工具，减少幻觉尝试。
   *   禁止列表由调用方传入（Core 层不硬依赖写作层的 AGENT_FORBIDDEN_TOOLS）。
   */
  getDefinitions(options?: { excludeForbidden?: string[] }) {
    const schemas = buildToolDefinitions();
    const forbidden = options?.excludeForbidden;
    return Object.values(schemas)
      .filter(s => !forbidden || !forbidden.includes(s.name as string))
      .map(s => ({
        name: s.name as string,
        description: s.description as string,
        parameters: s.parameters as Record<string, unknown>,
      }));
  }

  /** 返回所有 Tool 名称列表 */
  toolNames(): string[] {
    return [
      'get_context_slice', 'detect_entity_hints', 'propose_event', 'commit_event',
      'propose_retcon', 'commit_retcon', 'resolve_thread',
      'get_open_threads', 'register_entity',
      'propose_schema_extension', 'commit_schema_extension',
      'detect_relation_hints', 'get_graph_view',
      'detect_spatial_nodes', 'get_spatial_view',
      'create_chapter_plan', 'create_scene_plan', 'get_timeline_view',
      'create_foreshadowing_plan', 'get_foreshadowing_plans', 'create_reader_knowledge_state',
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
  // Tool 1b: detect_entity_hints（写作层实体检测）
  // =========================================================================

  private async handleDetectEntityHints(params: Record<string, unknown>) {
    // 守卫：entityService 必须注入（CLI 装配时传入；无写作层的纯 Core 测试不注入）
    if (!this.entityService || !this.writingProjectId) {
      return this.error(
        ToolErrorCode.INTERNAL_ERROR,
        '实体检测服务未配置（写作层未注入）',
        false,
        '此工具仅在写作层 CLI 环境可用。',
      );
    }

    const rawHints = params['hints'];
    if (!Array.isArray(rawHints) || rawHints.length === 0) {
      return this.error(ToolErrorCode.SCHEMA_VALIDATION_FAILED, 'hints 必须是非空数组', false, '请提供至少一个实体线索。');
    }

    // snake_case → camelCase 映射 + 校验
    const hints: Array<{ displayName: string; typeLabel: string; excerpt?: string }> = [];
    for (let i = 0; i < rawHints.length; i++) {
      const h = rawHints[i] as Record<string, unknown>;
      const displayName = h['display_name'];
      const typeLabel = h['type_label'];
      if (typeof displayName !== 'string' || displayName.trim().length === 0) {
        return this.error(ToolErrorCode.SCHEMA_VALIDATION_FAILED, `hints[${i}].display_name 必须是非空字符串`, false);
      }
      if (typeof typeLabel !== 'string' || typeLabel.trim().length === 0) {
        return this.error(ToolErrorCode.SCHEMA_VALIDATION_FAILED, `hints[${i}].type_label 必须是非空字符串`, false);
      }
      hints.push({
        displayName: displayName.trim(),
        typeLabel: typeLabel.trim(),
        excerpt: typeof h['excerpt'] === 'string' ? h['excerpt'] : undefined,
      });
    }

    // Core 层不依赖写作层 makeRequestContext，内联构造等价对象。
    const ctx = this.makeToolContext('detect');

    const sketches = this.entityService.detectEntityHints(ctx, hints);

    return this.ok({
      detected: sketches.length,
      hints: (sketches as Array<{ id: string; displayName: string; typeLabel: string; status: string; duplicateSuspected?: boolean }>).map(s => ({
        id: s.id,
        displayName: s.displayName,
        typeLabel: s.typeLabel,
        status: s.status,
        duplicateSuspected: s.duplicateSuspected,
      })),
      message: `已创建 ${sketches.length} 个实体线索（hint 状态）。用 /entities 查看，/entity approve <id> 批准后注册到 Core。`,
    });
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
      // 校验谓词必需字段
      if (typeof pred.name !== 'string' || !pred.name) {
        return this.error(ToolErrorCode.SCHEMA_VALIDATION_FAILED, 'new_predicates[].name 必须是非空字符串', false);
      }
      if (typeof pred.displayName !== 'string' || !pred.displayName) {
        return this.error(ToolErrorCode.SCHEMA_VALIDATION_FAILED, 'new_predicates[].displayName 必须是非空字符串', false);
      }
      if (typeof pred.valueType !== 'string' || !['scalar', 'entity_ref', 'enum'].includes(pred.valueType as string)) {
        return this.error(ToolErrorCode.SCHEMA_VALIDATION_FAILED, 'new_predicates[].valueType 必须是 scalar/entity_ref/enum 之一', false);
      }
      const predicateExt: PredicateExtension = {
        name: pred.name as string,
        displayName: pred.displayName as string,
        valueType: pred.valueType as PredicateExtension['valueType'],
        enumValues: Array.isArray(pred.enumValues) ? pred.enumValues as string[] : undefined,
        sequenceOrder: Array.isArray(pred.sequenceOrder) ? pred.sequenceOrder as string[] : undefined,
        description: typeof pred.description === 'string' ? pred.description : undefined,
        relationKind: typeof pred.relationKind === 'string' ? pred.relationKind : undefined,
      };
      const p = this.schemaExtensionManager.proposePredicate(predicateExt);
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
      // 校验规则必需字段
      if (typeof rule.id !== 'string' || !rule.id) {
        return this.error(ToolErrorCode.SCHEMA_VALIDATION_FAILED, 'new_rules[].id 必须是非空字符串', false);
      }
      if (typeof rule.type !== 'string' || !rule.type) {
        return this.error(ToolErrorCode.SCHEMA_VALIDATION_FAILED, 'new_rules[].type 必须是非空字符串', false);
      }
      if (typeof rule.name !== 'string' || !rule.name) {
        return this.error(ToolErrorCode.SCHEMA_VALIDATION_FAILED, 'new_rules[].name 必须是非空字符串', false);
      }
      const def = rule.definition as Record<string, unknown> | undefined;
      if (!def || typeof def !== 'object') {
        return this.error(ToolErrorCode.SCHEMA_VALIDATION_FAILED, 'new_rules[].definition 必须是对象', false);
      }
      if (typeof def.type !== 'string' || !def.type) {
        return this.error(ToolErrorCode.SCHEMA_VALIDATION_FAILED, 'new_rules[].definition.type 必须是非空字符串', false);
      }
      if (!Array.isArray(def.conditions)) {
        return this.error(ToolErrorCode.SCHEMA_VALIDATION_FAILED, 'new_rules[].definition.conditions 必须是数组', false);
      }
      const ruleExt: RuleExtension = {
        id: rule.id as string,
        type: rule.type as string,
        name: rule.name as string,
        description: typeof rule.description === 'string' ? rule.description : undefined,
        priority: typeof rule.priority === 'number' ? rule.priority : undefined,
        definition: {
          id: (def['id'] as string) ?? (rule.id as string),
          type: def.type as string,
          name: (def['name'] as string) ?? (rule.name as string),
          description: typeof def['description'] === 'string' ? def['description'] as string : undefined,
          priority: typeof def['priority'] === 'number' ? def['priority'] as number : undefined,
          conditions: def.conditions as unknown[],
          consequences: Array.isArray(def['consequences']) ? def['consequences'] as unknown[] : undefined,
        },
      };
      const r = this.schemaExtensionManager.proposeRule(ruleExt);
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
  // Tool 12: detect_relation_hints（Phase 8：关系检测）
  // =========================================================================

  private async handleDetectRelationHints(params: Record<string, unknown>) {
    if (!this.relationService || !this.writingProjectId) {
      return this.error(
        ToolErrorCode.INTERNAL_ERROR,
        '关系检测服务未配置（写作层未注入）',
        false,
        '此工具仅在写作层 CLI 环境可用。',
      );
    }

    const rawHints = params['hints'];
    if (!Array.isArray(rawHints) || rawHints.length === 0) {
      return this.error(ToolErrorCode.SCHEMA_VALIDATION_FAILED, 'hints 必须是非空数组', false, '请提供至少一个关系提示。');
    }

    // 校验并映射参数
    const hints: Array<{
      sourceEntityId: string;
      targetEntityId: string;
      relationTypeId?: string;
      summary: string;
    }> = [];

    for (let i = 0; i < rawHints.length; i++) {
      const h = rawHints[i] as Record<string, unknown>;
      const sourceEntityId = h['source_entity_id'];
      const targetEntityId = h['target_entity_id'];
      const summary = h['summary'];

      if (typeof sourceEntityId !== 'string' || sourceEntityId.trim().length === 0) {
        return this.error(ToolErrorCode.SCHEMA_VALIDATION_FAILED, `hints[${i}].source_entity_id 必须是非空字符串`, false);
      }
      if (typeof targetEntityId !== 'string' || targetEntityId.trim().length === 0) {
        return this.error(ToolErrorCode.SCHEMA_VALIDATION_FAILED, `hints[${i}].target_entity_id 必须是非空字符串`, false);
      }
      if (typeof summary !== 'string' || summary.trim().length === 0) {
        return this.error(ToolErrorCode.SCHEMA_VALIDATION_FAILED, `hints[${i}].summary 必须是非空字符串`, false);
      }

      hints.push({
        sourceEntityId: sourceEntityId.trim(),
        targetEntityId: targetEntityId.trim(),
        relationTypeId: typeof h['relation_type_id'] === 'string' ? h['relation_type_id'] : undefined,
        summary: summary.trim(),
      });
    }

    // 构造 ctx
    const ctx = this.makeToolContext('relation');

    const created = this.relationService.createRelationHints(ctx, hints);

    return this.ok({
      detected: created.length,
      hints: (created as Array<{ id: string; sourceEntityId: string; targetEntityId: string; summary: string }>).map(h => ({
        id: h.id,
        source: h.sourceEntityId,
        target: h.targetEntityId,
        summary: h.summary,
      })),
      message: `已创建 ${created.length} 个关系提示。用 /relation 查看，确认后成为正式关系候选。`,
    });
  }

  // =========================================================================
  // Tool 13: get_graph_view（Phase 8：图谱查询）
  // =========================================================================

  private async handleGetGraphView(params: Record<string, unknown>) {
    if (!this.graphService || !this.writingProjectId) {
      return this.error(
        ToolErrorCode.INTERNAL_ERROR,
        '图谱服务未配置（写作层未注入）',
        false,
        '此工具仅在写作层 CLI 环境可用。',
      );
    }

    const mode = typeof params['mode'] === 'string' && params['mode'] === 'relationship'
      ? 'relationship' as const
      : 'world' as const;

    const entityFilter = Array.isArray(params['entity_filter'])
      ? (params['entity_filter'] as string[])
      : undefined;

    const ctx = {
      projectId: this.writingProjectId,
      requestId: `tool_graph_${Date.now()}`,
      authorId: this.writingProjectId,
      sessionId: `tool_session`,
      trigger: 'agent_query',
      sourceRefs: [],
      visibilityMode: 'normal' as const,
    };

    const graph = await this.graphService.buildGraphView(ctx, mode, entityFilter ? { entityTypes: entityFilter } : undefined);

    // 渲染为 Agent 可读的文本摘要
    const nodes = graph.nodes as Array<{ id: string; label: string; projectTypeLabel: string; statusLabel: string; attributes?: Array<{ predicate: string; value: string }> }>;
    const edges = graph.edges as Array<{ sourceNodeId: string; targetNodeId: string; label: string }>;
    const nodeCount = nodes.length;
    const edgeCount = edges.length;
    const lines: string[] = [`## 实体关系图谱（${mode}模式）`];
    lines.push(`共 ${nodeCount} 个实体，${edgeCount} 条关系\n`);

    if (nodeCount === 0) {
      lines.push('暂无实体数据。');
    } else {
      // 按类型分组显示节点
      const byType = new Map<string, typeof nodes>();
      for (const n of nodes) {
        const key = n.projectTypeLabel;
        const arr = byType.get(key) ?? [];
        arr.push(n);
        byType.set(key, arr);
      }
      for (const [type, typeNodes] of byType) {
        lines.push(`### ${type}（${typeNodes.length}）`);
        for (const n of typeNodes) {
          const attrs = n.attributes?.length
            ? ' — ' + n.attributes.map((a: { predicate: string; value: string }) => `${a.predicate}=${a.value}`).join(', ')
            : '';
          lines.push(`- ${n.label} [${n.statusLabel}]${attrs}`);
        }
        lines.push('');
      }

      if (edgeCount > 0) {
        lines.push('### 关系');
        for (const e of edges) {
          const src = nodes.find((n: { id: string }) => n.id === e.sourceNodeId)?.label ?? e.sourceNodeId;
          const tgt = nodes.find((n: { id: string }) => n.id === e.targetNodeId)?.label ?? e.targetNodeId;
          lines.push(`- ${src} →[${e.label}]→ ${tgt}`);
        }
      }
    }

    return this.ok({
      nodeCount,
      edgeCount,
      mode,
      markdown: lines.join('\n'),
    });
  }

  // =========================================================================
  // Tool 14: detect_spatial_nodes（Phase 9：空间节点识别）
  // =========================================================================

  private async handleDetectSpatialNodes(params: Record<string, unknown>) {
    if (!this.spatialService || !this.writingProjectId) {
      return this.error(
        ToolErrorCode.INTERNAL_ERROR,
        '空间服务未配置（写作层未注入）',
        false,
        '此工具仅在写作层 CLI 环境可用。',
      );
    }

    const rawNodes = params['nodes'];
    if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
      return this.error(ToolErrorCode.SCHEMA_VALIDATION_FAILED, 'nodes 必须是非空数组', false, '请提供至少一个空间节点。');
    }

    const ctx = this.makeToolContext('spatial_detect');
    const created: Array<{ id: string; label: string; typeId: string }> = [];

    for (const n of rawNodes) {
      const node = n as Record<string, unknown>;
      if (typeof node['label'] !== 'string' || !node['label']) continue;
      if (typeof node['type_id'] !== 'string' || !node['type_id']) continue;

      const result = this.spatialService.createSpatialNode(ctx, {
        label: node['label'] as string,
        typeId: node['type_id'] as string,
        aliases: Array.isArray(node['aliases']) ? node['aliases'] as string[] : undefined,
        description: typeof node['description'] === 'string' ? node['description'] as string : undefined,
      });
      created.push({ id: result.id, label: result.label, typeId: result.typeId });
    }

    return this.ok({
      detected: created.length,
      nodes: created,
      message: `已创建 ${created.length} 个空间节点（hint 状态）。用 /spatial list 查看，成熟度逐步推进后可注册 Core。`,
    });
  }

  // =========================================================================
  // Tool 15: get_spatial_view（Phase 9：空间视图查询）
  // =========================================================================

  private async handleGetSpatialView(params: Record<string, unknown>) {
    if (!this.spatialViewService || !this.writingProjectId) {
      return this.error(
        ToolErrorCode.INTERNAL_ERROR,
        '空间视图服务未配置（写作层未注入）',
        false,
        '此工具仅在写作层 CLI 环境可用。',
      );
    }

    const mode = typeof params['mode'] === 'string' ? params['mode'] : 'graph';

    const ctx = this.makeToolContext('spatial_view');
    const data = this.spatialViewService.exportSpatialData(ctx);

    // 渲染为 Agent 可读的文本摘要
    const lines: string[] = [];
    lines.push(`## 空间视图（${mode}）\n`);

    if (data.nodes.length === 0) {
      lines.push('当前项目无空间节点。用 detect_spatial_nodes 创建空间节点。');
    } else {
      lines.push(`**${data.nodes.length} 个空间节点，${data.edges.length} 条空间边**\n`);

      // 按类型分组
      const byType = new Map<string, typeof data.nodes>();
      for (const n of data.nodes) {
        const list = byType.get(n.typeId) ?? [];
        list.push(n);
        byType.set(n.typeId, list);
      }
      for (const [typeId, typeNodes] of byType) {
        lines.push(`### ${typeId}`);
        for (const n of typeNodes) {
          const maturity = n.maturity === 'registered' ? '✓' : n.maturity === 'confirmed' ? '●' : '○';
          lines.push(`- ${maturity} ${n.label}${n.description ? ` — ${n.description}` : ''}`);
        }
        lines.push('');
      }

      if (data.edges.length > 0) {
        lines.push('### 空间关系');
        for (const e of data.edges) {
          const src = data.nodes.find((n: { id: string; label: string }) => n.id === e.sourceNodeId)?.label ?? e.sourceNodeId;
          const tgt = data.nodes.find((n: { id: string; label: string }) => n.id === e.targetNodeId)?.label ?? e.targetNodeId;
          lines.push(`- ${src} →[${e.typeId}]→ ${tgt} (${e.layer})`);
        }
      }
    }

    return this.ok({
      nodeCount: data.nodes.length,
      edgeCount: data.edges.length,
      mode,
      markdown: lines.join('\n'),
    });
  }

  // =========================================================================
  // Tool 16: create_chapter_plan（Phase 10：章节规划）
  // =========================================================================

  private async handleCreateChapterPlan(params: Record<string, unknown>) {
    if (!this.chapterService || !this.writingProjectId) {
      return this.error(ToolErrorCode.INTERNAL_ERROR, '章节服务未配置（写作层未注入）', false, '此工具仅在写作层 CLI 环境可用。');
    }

    const title = typeof params['title'] === 'string' ? params['title'] : '';
    const order = typeof params['order'] === 'number' ? params['order'] : 0;
    if (!title) return this.error(ToolErrorCode.SCHEMA_VALIDATION_FAILED, 'title 必须是非空字符串', false);

    const ctx = this.makeToolContext('chapter');
    const chapter = this.chapterService.createChapter(ctx, {
      title, order,
      goals: Array.isArray(params['goals']) ? params['goals'] as string[] : undefined,
      povEntityId: typeof params['pov_entity_id'] === 'string' ? params['pov_entity_id'] : undefined,
    });

    return this.ok({
      id: chapter.id,
      title: chapter.title,
      order: chapter.order,
      status: chapter.status,
      message: `章节「${chapter.title}」已创建（顺序 ${chapter.order}）。用 /chapter list 查看。`,
    });
  }

  // =========================================================================
  // Tool 17: create_scene_plan（Phase 10：场景规划）
  // =========================================================================

  private async handleCreateScenePlan(params: Record<string, unknown>) {
    if (!this.sceneService || !this.writingProjectId) {
      return this.error(ToolErrorCode.INTERNAL_ERROR, '场景服务未配置（写作层未注入）', false, '此工具仅在写作层 CLI 环境可用。');
    }

    const chapterId = typeof params['chapter_id'] === 'string' ? params['chapter_id'] : '';
    const title = typeof params['title'] === 'string' ? params['title'] : '';
    const order = typeof params['order'] === 'number' ? params['order'] : 0;
    if (!chapterId || !title) return this.error(ToolErrorCode.SCHEMA_VALIDATION_FAILED, 'chapter_id 和 title 必须是非空字符串', false);

    const ctx = this.makeToolContext('scene');
    const scene = this.sceneService.createScene(ctx, {
      chapterId, title, order,
      purpose: Array.isArray(params['purpose']) ? params['purpose'] as string[] as any : undefined,
      participants: Array.isArray(params['participants']) ? params['participants'] as string[] : undefined,
      spatialNodeId: typeof params['spatial_node_id'] === 'string' ? params['spatial_node_id'] : undefined,
    });

    return this.ok({
      id: scene.id,
      title: scene.title,
      chapterId: scene.chapterId,
      order: scene.order,
      status: scene.status,
      message: `场景「${scene.title}」已创建（章节 ${scene.chapterId}，顺序 ${scene.order}）。`,
    });
  }

  // =========================================================================
  // Tool 18: get_timeline_view（Phase 10：时间线查询）
  // =========================================================================

  private async handleGetTimelineView(params: Record<string, unknown>) {
    if (!this.timelineService || !this.writingProjectId) {
      return this.error(ToolErrorCode.INTERNAL_ERROR, '时间线服务未配置（写作层未注入）', false, '此工具仅在写作层 CLI 环境可用。');
    }

    const mode = typeof params['mode'] === 'string' && params['mode'] === 'narrative'
      ? 'narrative' as const
      : 'world' as const;

    const ctx = this.makeToolContext('timeline');
    const timeline = this.timelineService.buildTimelineView(ctx, mode);

    // 渲染为 Agent 可读的文本摘要
    const lines: string[] = [];
    lines.push(`## 时间线（${mode}）\n`);
    lines.push(`**${timeline.items.length} 个条目**\n`);

    if (timeline.items.length === 0) {
      lines.push('暂无时间线条目。用 create_chapter_plan / create_scene_plan 创建规划。');
    } else {
      const byLayer = new Map<string, typeof timeline.items>();
      for (const item of timeline.items) {
        const list = byLayer.get(item.sourceLayer) ?? [];
        list.push(item);
        byLayer.set(item.sourceLayer, list);
      }

      for (const [layer, items] of byLayer) {
        const layerLabel = layer === 'committed' ? '已提交' : layer === 'planned' ? '计划' : layer;
        lines.push(`### ${layerLabel}（${items.length}）`);
        for (const item of items) {
          const ch = item.worldTime?.chapter ? ` Ch.${item.worldTime.chapter}` : '';
          lines.push(`- ${item.label}${ch} [${item.statusLabel}]`);
        }
        lines.push('');
      }
    }

    return this.ok({
      itemCount: timeline.items.length,
      mode,
      markdown: lines.join('\n'),
    });
  }

  // =========================================================================
  // Tool 19-21: Phase 11 伏笔/读者工具
  // =========================================================================

  private async handleCreateForeshadowingPlan(params: Record<string, unknown>) {
    if (!this.foreshadowingService || !this.writingProjectId) {
      return this.error(ToolErrorCode.INTERNAL_ERROR, '伏笔服务未配置', false);
    }
    const label = typeof params['label'] === 'string' ? params['label'] : '';
    const kind = typeof params['kind'] === 'string' ? params['kind'] : '';
    const targetReaderEffect = typeof params['target_reader_effect'] === 'string' ? params['target_reader_effect'] : '';
    if (!label || !kind || !targetReaderEffect) return this.error(ToolErrorCode.SCHEMA_VALIDATION_FAILED, 'label/kind/target_reader_effect 必填', false);

    const ctx = this.makeToolContext('foreshadowing');
    const plan = this.foreshadowingService.createForeshadowingPlan(ctx, {
      label, kind: kind as any, targetReaderEffect,
      linkedEntityRefs: Array.isArray(params['linked_entity_refs']) ? params['linked_entity_refs'] as string[] : undefined,
    });
    return this.ok({ id: plan.id, label: plan.label, kind: plan.kind, status: plan.status });
  }

  private async handleGetForeshadowingPlans(_params: Record<string, unknown>) {
    if (!this.foreshadowingService || !this.writingProjectId) {
      return this.error(ToolErrorCode.INTERNAL_ERROR, '伏笔服务未配置', false);
    }
    const store = (this as any).store as { listForeshadowingPlans: (pid: string) => any[] };
    const plans = store?.listForeshadowingPlans(this.writingProjectId) ?? [];
    const lines = [`## 伏笔计划（${plans.length} 个）\n`];
    for (const p of plans) {
      lines.push(`- [${p.status}] ${p.label} (${p.kind})`);
    }
    return this.ok({ count: plans.length, markdown: lines.join('\n') });
  }

  private async handleCreateReaderKnowledgeState(params: Record<string, unknown>) {
    if (!this.readerService || !this.writingProjectId) {
      return this.error(ToolErrorCode.INTERNAL_ERROR, '读者服务未配置', false);
    }
    const subjectRef = typeof params['subject_ref'] === 'string' ? params['subject_ref'] : '';
    const state = typeof params['state'] === 'string' ? params['state'] : '';
    const posType = typeof params['narrative_position_type'] === 'string' ? params['narrative_position_type'] : '';
    const posId = typeof params['narrative_position_id'] === 'string' ? params['narrative_position_id'] : '';
    if (!subjectRef || !state || !posType || !posId) return this.error(ToolErrorCode.SCHEMA_VALIDATION_FAILED, 'subject_ref/state/narrative_position_type/narrative_position_id 必填', false);

    const ctx = this.makeToolContext('reader');
    const audience = this.readerService.getOrCreateDefaultAudience(ctx);
    const ks = this.readerService.createKnowledgeState(ctx, {
      audienceId: audience.id, subjectRef, state: state as any,
      confidence: typeof params['confidence'] === 'number' ? params['confidence'] : undefined,
      narrativePositionType: posType, narrativePositionId: posId,
    });
    return this.ok({ id: ks.id, subjectRef: ks.subjectRef, state: ks.state });
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

  /** 构造 Core 层 WritingRequestContext（detectEntityHints / detectRelationHints 共用） */
  private makeToolContext(requestPrefix: string) {
    return {
      projectId: this.writingProjectId,
      requestId: `tool_${requestPrefix}_${Date.now()}`,
      authorId: this.writingProjectId ?? 'default',
      sessionId: `tool_session`,
      trigger: 'agent_suggestion' as const,
      sourceRefs: [],
      visibilityMode: 'normal' as const,
    };
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
    } catch (parseErr) {
      const reason = parseErr instanceof Error ? parseErr.message : String(parseErr);
      throw new Error(`SCHEMA_VALIDATION_FAILED: changes 解析失败（${reason}），请优先传入 fact_changes 数组。收到: ${legacy.slice(0, 100)}`);
    }
  }

  throw new Error(
    `SCHEMA_VALIDATION_FAILED: 参数 'fact_changes' 必须是数组，实际: ${JSON.stringify(structured)}`
  );
}
