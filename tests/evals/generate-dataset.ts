// =============================================================================
// Evals 数据集生成器——矛盾场景库
// =============================================================================
// 程序化生成三类矛盾场景，用于评估 Agent 的世界状态一致性检测能力：
//   1. 时序悖论：角色第 3 章死亡，第 5 章再出现
//   2. 知识可见性违规：角色 B 不该知道 C 的秘密
//   3. 设定冲突：境界/武力前后矛盾
//
// 每场景含 priorFacts（种子世界状态）+ userInput（触发矛盾的输入）+ expected（期望结果）。
// generate 产物 dataset.json commit 进库作为基线。
// =============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface PriorFact {
  subject: string;
  predicate: string;
  value: string;
  /** 该 fact 有效的起始章节 */
  chapter: number;
}

export interface EvalScenario {
  id: string;
  /** 场景标题 */
  title: string;
  /** 矛盾类型 */
  contradictionType: 'timeline_paradox' | 'knowledge_violation' | 'setting_conflict' | 'none';
  /** 世界观背景描述（注入 system prompt 的 worldSeed） */
  worldSeed: string;
  /** 种子世界状态（直接 assert 到 Core，不走审核通道） */
  priorFacts: PriorFact[];
  /** 用户输入（触发矛盾或正常推进） */
  userInput: string;
  /** 当前章节号 */
  currentChapter: number;
  /** 期望结果 */
  expected: {
    /** 是否应检测到矛盾 */
    shouldDetectContradiction: boolean;
    /** 矛盾类型（shouldDetectContradiction=true 时填充） */
    contradictionTypes: string[];
    /** 是否应拒绝提交（shouldDetectContradiction=true 时通常 true） */
    shouldRejectCommit: boolean;
  };
}

export interface EvalDataset {
  version: string;
  generatedAt: string;
  scenarios: EvalScenario[];
}

// ---------------------------------------------------------------------------
// 场景生成
// ---------------------------------------------------------------------------

function makeScenario(
  id: string,
  title: string,
  type: EvalScenario['contradictionType'],
  worldSeed: string,
  priorFacts: PriorFact[],
  userInput: string,
  currentChapter: number,
  shouldDetect: boolean,
  shouldReject: boolean,
): EvalScenario {
  return {
    id, title, contradictionType: type, worldSeed, priorFacts, userInput, currentChapter,
    expected: {
      shouldDetectContradiction: shouldDetect,
      contradictionTypes: shouldDetect ? [type] : [],
      shouldRejectCommit: shouldReject,
    },
  };
}

function generateScenarios(): EvalScenario[] {
  const scenarios: EvalScenario[] = [];

  // =========================================================================
  // 时序悖论（timeline_paradox）
  // =========================================================================

  scenarios.push(makeScenario(
    'tp_01', '已死角色再出现', 'timeline_paradox',
    '修仙世界，主角韩立在长庚宗修炼。',
    [
      { subject: 'ent_hanli', predicate: 'status', value: '已陨落', chapter: 3 },
      { subject: 'ent_hanli', predicate: 'realm', value: '金丹期', chapter: 3 },
    ],
    '第5章：韩立出现在天南坊市，与王林重逢，他的修为已突破元婴期。',
    5, true, true,
  ));

  scenarios.push(makeScenario(
    'tp_02', '已销毁物品再使用', 'timeline_paradox',
    '奇幻世界，主角的佩剑已在战斗中碎裂。',
    [
      { subject: 'ent_star_sword', predicate: 'status', value: '已碎裂销毁', chapter: 2 },
    ],
    '第4章：主角拔出星辰剑，剑身绽放银光，斩杀了暗影巨兽。',
    4, true, true,
  ));

  // 正常场景（无矛盾）——控制组
  scenarios.push(makeScenario(
    'tp_ctrl_01', '正常时间推进', 'none',
    '修仙世界。',
    [
      { subject: 'ent_hanli', predicate: 'realm', value: '筑基期', chapter: 1 },
    ],
    '第2章：韩立闭关突破，成功踏入金丹期。',
    2, false, false,
  ));

  // =========================================================================
  // 知识可见性违规（knowledge_violation）
  // =========================================================================

  scenarios.push(makeScenario(
    'kv_01', '角色知道不该知道的秘密', 'knowledge_violation',
    '两个互不相识的角色，A 有一个从未泄露的秘密。',
    [
      { subject: 'ent_zhangsan', predicate: 'secret', value: '拥有上古传承', chapter: 1 },
      { subject: 'ent_lisi', predicate: 'relation', value: '与张三素不相识', chapter: 1 },
    ],
    '第2章：李四对张三说："我知道你拥有上古传承，交出来否则我揭发你。"',
    2, true, true,
  ));

  // 正常场景——角色确实知晓（目击者）
  scenarios.push(makeScenario(
    'kv_ctrl_01', '目击者合理知晓', 'none',
    '两个角色在同一场景。',
    [
      { subject: 'ent_zhangsan', predicate: 'location', value: '长庚站废墟', chapter: 1 },
      { subject: 'ent_lisi', predicate: 'location', value: '长庚站废墟', chapter: 1 },
    ],
    '第2章：李四回忆起在长庚站废墟看到张三捡起黑晶碎片的一幕。',
    2, false, false,
  ));

  // =========================================================================
  // 设定冲突（setting_conflict）
  // =========================================================================

  scenarios.push(makeScenario(
    'sc_01', '境界前后矛盾', 'setting_conflict',
    '修仙世界，角色境界已明确设定。',
    [
      { subject: 'ent_wanglin', predicate: 'realm', value: '金丹期', chapter: 1 },
    ],
    '第2章：王林一直是筑基期修士，从未突破过金丹。',
    2, true, true,
  ));

  scenarios.push(makeScenario(
    'sc_02', '位置冲突', 'setting_conflict',
    '科幻世界，角色位置已明确。',
    [
      { subject: 'ent_shenmo', predicate: 'location', value: '长庚站废弃站台', chapter: 1 },
    ],
    '第2章：沈墨此时正在千里之外的灰域深处探索，根本不在长庚站。',
    2, true, true,
  ));

  // 正常场景——属性更新（合法变更）
  scenarios.push(makeScenario(
    'sc_ctrl_01', '合法属性更新', 'none',
    '修仙世界。',
    [
      { subject: 'ent_hanli', predicate: 'location', value: '长庚宗', chapter: 1 },
    ],
    '第2章：韩立离开长庚宗，前往天南坊市历练。',
    2, false, false,
  ));

  return scenarios;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

function main(): void {
  const scenarios = generateScenarios();
  const dataset: EvalDataset = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    scenarios,
  };

  const outPath = path.resolve(__dirname, 'dataset.json');
  fs.writeFileSync(outPath, JSON.stringify(dataset, null, 2), 'utf-8');
  console.log(`✅ 生成 ${scenarios.length} 个场景 → ${outPath}`);

  // 汇总统计
  const byType = scenarios.reduce((acc, s) => {
    const t = s.contradictionType;
    acc[t] = (acc[t] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  console.log('   类型分布:', byType);
  const shouldDetect = scenarios.filter(s => s.expected.shouldDetectContradiction).length;
  console.log(`   应检出矛盾: ${shouldDetect} | 控制组（无矛盾）: ${scenarios.length - shouldDetect}`);
}

main();
