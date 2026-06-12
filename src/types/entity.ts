// =============================================================================
// 实体类型 — EntityKind / RelationKind / EntityRecord
// =============================================================================
// §3: 实体分类 + 关系语义 + 实体注册记录

/**
 * 实体分类（14 种），覆盖诡秘之主级别的设定复杂度
 *
 * 定位：EntityKind 是检索优化标签，不是世界本体论。
 * - 唯一用途：辅助 FactEmbedder 生成更精准的 embeddingText，辅助 RelevantFactRetriever 按类型过滤
 * - 不决定实体的行为、能力、关系——这些全部由 Fact 表达
 * - 新增 EntityKind 的门槛：必须有至少 3 部作品需要此类型来提升检索质量
 */
export type EntityKind =
  | 'entity'           // 实体：角色、物品等可独立存在的对象（通用兜底）
  | 'place'            // 地点：具体的地理位置或场所
  | 'spatial_domain'   // 空间域：抽象的空间范围或领域（如秘境、位面、灰雾之上）
  | 'state'            // 状态：封印状态、污染状态等可变化的状态实体
  | 'goal'             // 目标：角色、组织或世界阶段正在追求的结果
  | 'resource'         // 资源：货币、材料、线索、权柄等可消耗或争夺的对象
  | 'ability'          // 能力：技能、权限、仪式资格、序列能力等行动条件
  | 'identity'         // 身份：公开身份、隐藏身份、阵营身份、社会标签
  | 'theme'            // 主题：命运、代价、背叛等抽象叙事母题
  | 'rule'             // 规则：世界运行的法则、约束或机制
  | 'information'      // 信息：知识、情报、秘密等认知内容
  | 'foreshadowing'    // 伏笔：预先埋下的线索或暗示
  | 'event'            // 事件：已发生或正在发生的事情
  | 'time';            // 时间：时间点、时间段等时间相关概念

/**
 * 关系语义分类（15 种），作为 Fact 的可选元数据字段
 *
 * RelationKind 的推断优先级：
 *   1. 谓词映射表（确定性规则，如 enemy_of → social）
 *   2. LLM 标注（propose_event 时附加 relation_kind）
 *   3. 作者指定（对话中说明）
 */
export type RelationKind =
  | 'structural'      // 结构关系：组成、包含、分类等结构性连接
  | 'social'          // 社会关系：人际、组织、阵营等社会性连接
  | 'possession'      // 拥有关系：所有权、控制权、归属等
  | 'causal'          // 因果关系：导致、引发、影响等因果连接
  | 'informational'   // 信息关系：知晓、传播、隐藏等信息流动
  | 'spatial'         // 空间关系：位置、方向、距离等空间连接
  | 'temporal'        // 时间关系：先后、期限、周期、倒计时等时间连接
  | 'state'           // 状态关系：处于、感染、封印、激活等状态连接
  | 'goal'            // 目标关系：追求、阻碍、牺牲、完成等目标连接
  | 'dependency'      // 依赖关系：行动、知识、资源、条件之间的依赖连接
  | 'permission'      // 权限关系：允许、禁止、需要资格、可进入等许可连接
  | 'identity'         // 身份关系：伪装、真实身份、公开身份、隶属标签等连接
  | 'thematic'        // 主题关系：象征、映射、呼应、反讽等主题连接
  | 'rule'            // 规则关系：约束、限制、遵循等规则性连接
  | 'narrative';      // 叙事关系：伏笔照应、情节关联等叙事性连接

/**
 * 实体注册记录 —— 实体 ID 与元数据的映射
 */
export interface EntityRecord {
  id: string;              // 'ent_{name}[_{seq}]'
  name: string;            // 实体名称（拼音连写）
  kind: EntityKind;        // 实体分类
  description?: string;    // 自然语言描述
  registeredAtChapter: number;
  registeredAtEvent: string;
  tags?: string[];         // 作者自定义标签
}
