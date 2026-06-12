// =============================================================================
// InMemoryProposalStore —— 内存实现的 ProposalStore 接口
// =============================================================================
// Proposal 是 propose_event 和 commit_event 之间的临时数据。
// 使用内存 Map 实现，进程重启后 Proposal 丢失（需重新 propose）。
//
// 存储额外元数据：
//   - originalFactChanges：commit_event 时重建完整 FactGroup 需要
// =============================================================================

import type { ProposalStore, ProposalResult, FactChange } from '../types.js';

interface ProposalEntry {
  proposal: ProposalResult;
  originalFactChanges: FactChange[];
  createdAt: number;
}

export class InMemoryProposalStore implements ProposalStore {
  private store = new Map<string, ProposalEntry>();

  save(proposal: ProposalResult, originalFactChanges?: FactChange[]): void {
    this.store.set(proposal.proposalId, {
      proposal,
      originalFactChanges: originalFactChanges ?? [],
      createdAt: Date.now(),
    });
  }

  get(proposalId: string): ProposalResult | undefined {
    return this.store.get(proposalId)?.proposal;
  }

  /** 获取 Proposal 携帯的原始 FactChange 列表 */
  getOriginalChanges(proposalId: string): FactChange[] {
    return this.store.get(proposalId)?.originalFactChanges ?? [];
  }

  remove(proposalId: string): void {
    this.store.delete(proposalId);
  }

  expireStale(currentChapter: number, maxAge: number = 100): void {
    const now = Date.now();
    const maxAgeMs = maxAge * 60 * 1000;
    for (const [id, entry] of this.store) {
      const chapter = parseInt(entry.proposal.proposalId.match(/_(\d+)/)?.[1] ?? '0', 10);
      if (chapter < currentChapter - 50 || (now - entry.createdAt) > maxAgeMs) {
        this.store.delete(id);
      }
    }
  }
}
