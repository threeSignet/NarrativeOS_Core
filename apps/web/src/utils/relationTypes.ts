// 关系类型常量（供前端下拉选择用，镜像 entityKinds.ts 的 RELATION_TYPE_LABELS）

export const RELATION_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'siblings', label: '姐妹/兄弟' },
  { value: 'parent_child', label: '父子' },
  { value: 'spouse', label: '配偶' },
  { value: 'ally', label: '盟友' },
  { value: 'enemy', label: '敌对' },
  { value: 'master_disciple', label: '师徒' },
  { value: 'belongs_to', label: '隶属' },
  { value: 'owns', label: '拥有' },
  { value: 'protects', label: '守护' },
  { value: 'located_in', label: '位于' },
  { value: 'knows', label: '知晓' },
];
