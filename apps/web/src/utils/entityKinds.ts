// EntityKind 14 种中文映射（镜像 src/types/entity.ts 注释）
// 实体卡 typeLabel 是作者自定义文本（如"主角势力"），不一定等于 EntityKind。
// 此映射用于：当 typeLabel 为空或需要归类时，提供标准分类；图谱节点类型标签。

/** Core EntityKind → 中文标签 */
export const ENTITY_KIND_LABELS: Record<string, string> = {
  entity: '实体',
  place: '地点',
  spatial_domain: '空间域',
  state: '状态',
  goal: '目标',
  resource: '资源',
  ability: '能力',
  identity: '身份',
  theme: '主题',
  rule: '规则',
  information: '信息',
  foreshadowing: '伏笔',
  event: '事件',
  time: '时间',
};

/** 图谱来源层 → 中文标签 + 颜色（供图例/节点着色用） */
export const GRAPH_LAYER_META: Array<{ key: string; label: string; color: string }> = [
  { key: 'committed', label: '已确认', color: '#4ade80' },
  { key: 'candidate', label: '候选', color: '#fbbf24' },
  { key: 'draft', label: '草案', color: '#a78bfa' },
  { key: 'hint', label: '提示', color: '#94a3b8' },
  { key: 'association', label: '关联', color: '#60a5fa' },
  { key: 'spatial', label: '空间', color: '#fb7185' },
  { key: 'view', label: '视图', color: '#64748b' },
];

const LAYER_COLOR_MAP = new Map(GRAPH_LAYER_META.map((l) => [l.key, l.color]));

/** 取来源层颜色（未知层用灰） */
export function layerColor(layer: string): string {
  return LAYER_COLOR_MAP.get(layer) ?? '#94a3b8';
}

/** 来源层 → SVG stroke-dasharray（线型区分，§8.8/§10.1 验收要求视觉区分） */
const LAYER_DASH: Record<string, string> = {
  committed: '',            // 实线：正式关系（已进 Core）
  candidate: '6,4',         // 虚线：候选关系
  draft: '2,3',             // 点线：草案
  hint: '1,3',              // 密点：推测（默认隐藏）
  association: '10,4,2,4',  // 点划线：创作关联
  spatial: '8,3',           // 长划：空间
  view: '3,3',              // 细点：视图布局
};
export function layerDash(layer: string): string {
  return LAYER_DASH[layer] ?? '';
}

/** 取来源层中文标签 */
export function layerLabel(layer: string): string {
  return GRAPH_LAYER_META.find((l) => l.key === layer)?.label ?? layer;
}

/** Core 谓词 → 中文标签（图谱节点属性展示用）。
 * 未命中的谓词降级显示为"属性"，遵循 §9.1 不裸露技术谓词。 */
const PREDICATE_LABELS: Record<string, string> = {
  location: '位置',
  status: '状态',
  realm: '境界',
  level: '等级',
  age: '年龄',
  gender: '性别',
  appearance: '外貌',
  personality: '性格',
  background: '背景',
  affiliation: '隶属',
  role: '身份',
  ability: '能力',
  equipment: '装备',
};
export function predicateLabel(predicate: string): string {
  return PREDICATE_LABELS[predicate] ?? '属性';
}

/** 常见 relationTypeId → 中文（兜底，Blueprint 无定义时用）。
 * 未命中则原样返回（作者自定义的 relationTypeId 可能本身就是中文）。 */
const RELATION_TYPE_LABELS: Record<string, string> = {
  siblings: '姐妹',
  parent_child: '父子',
  spouse: '配偶',
  enemy: '敌对',
  ally: '盟友',
  master_disciple: '师徒',
  belongs_to: '隶属',
  owns: '拥有',
  protects: '守护',
  located_in: '位于',
  knows: '知晓',
};
export function relationTypeLabel(typeId: string): string {
  return RELATION_TYPE_LABELS[typeId] ?? typeId;
}
