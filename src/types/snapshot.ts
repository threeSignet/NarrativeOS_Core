// =============================================================================
// 快照系统类型
// =============================================================================
// §14: WorldSnapshot / SnapshotData / SnapshotTriggerType

import type { FactValue } from './base.js';
import type { EntityKind } from './entity.js';
import type { KnowledgeSource } from './knowledge.js';

/** 快照类型 */
export type SnapshotTriggerType = 'auto' | 'chapter' | 'pre_retcon' | 'major_event' | 'manual';

/** 世界状态快照元数据 */
export interface WorldSnapshot {
  id: string;              // 'snap_chapter_100'
  projectId: string;
  atChapter: number;
  triggerType: SnapshotTriggerType;
  createdAt: string;       // ISO 8601
  entityCount: number;
  factCount: number;
  storagePath: string;     // 'snapshots/{project_id}/snap_chapter_100.json'
}

/** 快照数据内容 */
export interface SnapshotData {
  atChapter: number;
  activeFacts: Array<{
    id: string;
    subject: string;
    predicate: string;
    value: FactValue;
    context: string;
    validFrom: number;
    causeEvent: string;
  }>;
  entities: Array<{
    id: string;
    name: string;
    kind: EntityKind;
  }>;
  openThreads: Array<{
    id: string;
    type: string;
    status: string;
  }>;
  activeKnowledge: Array<{
    id: string;
    entityId: string;
    factId: string;
    confidence: number;
    source: KnowledgeSource;
  }>;
}
