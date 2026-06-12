// =============================================================================
// Spike 1 数据集生成器
// =============================================================================
// 程序化生成 ~5000 条中文小说设定 Fact + 200 条硬负样本
// 覆盖三套世界观：修仙（xianxia）/ 诡秘（lotm）/ 科幻（scifi）
//
// 生成策略：
//   - 每套世界观 ~1600 条基准 Fact，通过模板组合程序化生成
//   - 硬负样本：语义相似但逻辑无关的 Fact（如相同修为境界但不同角色）
//   - Fact 的 embeddingText 遵循 §3.1.2 规范格式
// =============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface TestFact {
  id: string;
  subject: string;
  predicate: string;
  value: string | number | boolean;
  validFrom: number;
  validTo: number | null;
  context: string;
  embeddingText: string;
  /** 所属世界观 */
  worldview: 'xianxia' | 'lotm' | 'scifi';
  /** 用于构造硬负样本的分类标签 */
  category: string;
}

export interface TestQuery {
  id: string;
  /** 自然语言查询文本 */
  queryText: string;
  /** 难度级别 */
  difficulty: 'easy' | 'medium' | 'hard' | 'extreme';
  /** 应召回的目标 Fact ID 集合（ground truth） */
  relevantFactIds: string[];
  /** 查询描述 */
  description: string;
}

export interface SpikeDataset {
  facts: TestFact[];
  hardNegatives: TestFact[];
  queries: TestQuery[];
  metadata: {
    totalBaseFacts: number;
    totalHardNegatives: number;
    worldviews: string[];
    generatedAt: string;
  };
}

// ---------------------------------------------------------------------------
// 中文名字库（确保实体名多样性）
// ---------------------------------------------------------------------------

const SURNAMES = ['张', '李', '王', '赵', '陈', '刘', '黄', '周', '吴', '郑', '冯', '沈', '韩', '杨', '朱', '马', '胡', '林', '何', '高', '罗', '梁', '宋', '唐', '许', '邓', '萧', '苏', '叶', '白'];
const GIVEN_NAMES = ['三', '风', '云', '雷', '玄', '青', '寒', '炎', '冥', '天', '无极', '婉', '月', '星', '夜', '霜', '飞', '龙', '虎', '鹤', '尘', '逍遥', '道', '一', '明', '远', '长青', '无忌'];

// ---------------------------------------------------------------------------
// 世界观一：修仙 (xianxia)
// ---------------------------------------------------------------------------

const REALMS = ['炼气期', '筑基期', '结丹期', '金丹期', '元婴期', '化神期', '合体期', '渡劫期', '大乘期'];
const REALM_ORDER: Record<string, number> = Object.fromEntries(REALMS.map((r, i) => [r, i]));
const MERIDIANS = ['正常', '碎裂(绝脉)', '天灵根', '异灵根', '五行灵根', '伪灵根'];
const BLOODLINES = ['凡人血脉', '远古龙族血脉', '凤凰血脉', '麒麟血脉', '玄武血脉', '白虎血脉', '混沌血脉', '荒古圣体'];
const SECTS = ['青云宗', '天剑宗', '万妖岭', '天魔殿', '紫霄宫', '碧落宗', '山河盟', '玄冥教', '太虚观', '散修'];
const LOCATIONS_XIANXIA = ['青云山', '万妖岭', '天魔深渊', '紫霄天', '碧落海', '昆仑墟', '东海龙宫', '蓬莱仙岛', '幽冥界', '蛮荒古域', '天剑崖', '流云城', '灵脉秘境', '朱雀城', '寒冰渊'];
const WEAPONS = ['青竹蜂云剑', '诛仙剑', '戮仙剑', '绝仙剑', '陷仙剑', '玄铁重剑', '飞羽扇', '震天锤', '阴阳镜', '捆仙索', '万魂幡', '斩仙飞刀', '紫电锤', '血魔刃', '金蛟剪'];
const ITEMS = ['储物袋', '筑基丹', '结丹丹', '元婴丹', '万年灵芝', '九转金丹', '造化玉碟', '息壤', '玄黄珠', '长生药', '千年朱果', '灵脉之心'];
const EVENTS_XIANXIA = ['渡劫', '突破境界', '遭遇追杀', '获得奇遇', '门派比试', '探索秘境', '炼丹失败', '收服灵兽'];

// ---------------------------------------------------------------------------
// 世界观二：诡秘 (lotm — Lord of the Mysteries style)
// ---------------------------------------------------------------------------

const SEQUENCES = ['序列9', '序列8', '序列7', '序列6', '序列5', '序列4', '序列3', '序列2', '序列1', '序列0'];
const PATHWAYS = ['占卜家', '偷盗者', '学徒', '水手', '观众', '战士', '收尸人', '黑夜', '风暴', '太阳', '工匠', '死神'];
const LOTM_FACTIONS = ['值夜者', '密修会', '黑夜教会', '风暴教会', '蒸汽教会', '命运隐修会', '黄昏隐士会', '血红之手', '玫瑰学派', '塔罗会'];
const LOTM_LOCATIONS = ['廷根市', '白银之城', '灰雾之上', '神弃之地', '梦境之海', '圣塞缪尔教堂', '查尼斯门', '黑荆棘安保公司', '凛冬郡', '贝克兰德', '间海', '狂暴海'];
const LOTM_ITEMS = ['封印物1-42', '非凡特性', '占卜水晶', '黑夜徽章', '愚者卡牌', '封印物0-08', '命运之轮', '灵摆', '灵性护符', '血月之书'];
const LOTM_ABILITIES = ['灵视', '占卜', '梦境行走', '纸人替身', '火焰跳跃', '空气炮', '操控灵体', '历史投影', '奇迹'];
const EVENTS_LOTM = ['对抗失控', '晋升序列', '调查神秘事件', '发现密修会线索', '参加塔罗会', '净化污染', '获取封印物', '窥见隐秘存在'];

// ---------------------------------------------------------------------------
// 世界观三：科幻 (scifi)
// ---------------------------------------------------------------------------

const TECH_LEVELS = ['原始文明', '工业文明', '信息文明', '行星文明', '恒星文明', '星河文明', '维度文明', '神级文明'];
const FACTIONS_SCIFI = ['星盟', '联邦', '帝国', '自由舰队', '虚空商盟', '机械教派', '基因议会', '暗影网络', '开拓者联盟'];
const PLANETS = ['泰拉', '新地球', '火星殖民地', '比邻星b', '氪星', '安德罗梅达', '半人马α空间站', '虫洞枢纽7号', '银河边际哨站'];
const SHIPS = ['星际巡洋舰', '歼星舰', '探索者号', '虚空跃迁舰', '殖民母舰', '隐形侦察舰', '量子攻击舰', '亚光速货船'];
const SCIFI_TECHS = ['曲率引擎', '量子通讯', '人造重力', '冷核聚变', '空间折叠', '时间膨胀', '暗能量捕获', '纳米修复', '意识上传'];
const EVENTS_SCIFI = ['首次接触', '量子风暴', '跃迁事故', '基因改造', '人工智能觉醒', '暗物质勘探', '殖民战争', '超新星预警'];

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

let idCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}_${String(++idCounter).padStart(4, '0')}`;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

function genName(): string {
  return pick(SURNAMES) + pick(GIVEN_NAMES);
}

/** 生成标准格式的 embeddingText */
function makeEmbedding(subject: string, predZh: string, value: string, chapter: number): string {
  return `${subject} 的${predZh}是 ${value}（第${chapter}章）`;
}

// ---------------------------------------------------------------------------
// 修仙世界观 Fact 生成
// ---------------------------------------------------------------------------

function generateXianxiaFacts(): TestFact[] {
  const facts: TestFact[] = [];
  // 生成 50 个角色
  const characters: Array<{ id: string; name: string; realm: string }> = [];
  for (let i = 0; i < 50; i++) {
    const name = genName();
    const id = `ent_${name.toLowerCase()}`;
    const realm = pick(REALMS);
    characters.push({ id, name, realm });
  }

  // 生成 5 个势力
  const factions: Array<{ id: string; name: string }> = [];
  for (const sect of SECTS) {
    factions.push({ id: `ent_${sect.toLowerCase().replace(/\s/g, '')}`, name: sect });
  }

  // 生成 10 个地点
  const locations = LOCATIONS_XIANXIA.map(loc => ({
    id: `ent_${loc.toLowerCase().replace(/\s/g, '')}`,
    name: loc,
  }));

  // 1. 角色属性 Fact（境界 / 经脉 / 血脉 / 寿元）
  for (const char of characters) {
    facts.push({
      id: nextId('fct'),
      subject: char.id, predicate: 'realm', value: char.realm,
      validFrom: Math.floor(Math.random() * 300) + 1, validTo: null, context: 'global',
      embeddingText: makeEmbedding(char.name, '修炼境界', char.realm, Math.floor(Math.random() * 300) + 1),
      worldview: 'xianxia', category: 'character_realm',
    });
    facts.push({
      id: nextId('fct'),
      subject: char.id, predicate: 'meridian', value: pick(MERIDIANS),
      validFrom: 1, validTo: null, context: 'global',
      embeddingText: makeEmbedding(char.name, '经脉状态', pick(MERIDIANS), 1),
      worldview: 'xianxia', category: 'character_meridian',
    });
    facts.push({
      id: nextId('fct'),
      subject: char.id, predicate: 'bloodline', value: pick(BLOODLINES),
      validFrom: 1, validTo: null, context: 'global',
      embeddingText: makeEmbedding(char.name, '血脉', pick(BLOODLINES), 1),
      worldview: 'xianxia', category: 'character_bloodline',
    });
    facts.push({
      id: nextId('fct'),
      subject: char.id, predicate: 'lifespan_remaining', value: Math.floor(Math.random() * 5000) + 100,
      validFrom: Math.floor(Math.random() * 300) + 1, validTo: null, context: 'global',
      embeddingText: makeEmbedding(char.name, '剩余寿元', String(Math.floor(Math.random() * 5000) + 100), Math.floor(Math.random() * 300) + 1),
      worldview: 'xianxia', category: 'character_lifespan',
    });
  }

  // 2. 关系 Fact（师承、敌对、持有物品）
  for (let i = 0; i < 300; i++) {
    const subj = pick(characters);
    const obj = pick(characters);
    if (subj.id === obj.id) continue;
    const relType = pick(['disciple_of', 'enemy_of', 'ally_of', 'owes_life_to', 'betrayed_by', 'rival_of']);
    const relZh: Record<string, string> = {
      disciple_of: '师承于', enemy_of: '敌对', ally_of: '盟友于', owes_life_to: '欠恩情于',
      betrayed_by: '被背叛于', rival_of: '竞争对手为',
    };
    const chapter = Math.floor(Math.random() * 300) + 1;
    facts.push({
      id: nextId('fct'),
      subject: subj.id, predicate: relType, value: obj.id,
      validFrom: chapter, validTo: null, context: 'global',
      embeddingText: `${subj.name} ${relZh[relType]!} ${obj.name}（第${chapter}章）`,
      worldview: 'xianxia', category: `relation_${relType}`,
    });
  }

  // 3. 持有物品关系
  for (let i = 0; i < 100; i++) {
    const char = pick(characters);
    const weapon = pick(WEAPONS);
    const weaponId = `ent_${weapon.toLowerCase().replace(/\s/g, '')}`;
    const chapter = Math.floor(Math.random() * 300) + 1;
    facts.push({
      id: nextId('fct'),
      subject: char.id, predicate: 'holds_item', value: weaponId,
      validFrom: chapter, validTo: null, context: 'global',
      embeddingText: `${char.name} 持有 ${weapon}（第${chapter}章）`,
      worldview: 'xianxia', category: 'holds_item',
    });
  }

  // 4. 地点归属
  for (let i = 0; i < 50; i++) {
    const char = pick(characters);
    const loc = pick(locations);
    const chapter = Math.floor(Math.random() * 300) + 1;
    facts.push({
      id: nextId('fct'),
      subject: char.id, predicate: 'location', value: loc.id,
      validFrom: chapter, validTo: null, context: 'global',
      embeddingText: `${char.name} 位于 ${loc.name}（第${chapter}章）`,
      worldview: 'xianxia', category: 'character_location',
    });
  }

  // 5. 势力归属
  for (let i = 0; i < 80; i++) {
    const char = pick(characters);
    const faction = pick(factions);
    const chapter = Math.floor(Math.random() * 300) + 1;
    facts.push({
      id: nextId('fct'),
      subject: char.id, predicate: 'member_of', value: faction.id,
      validFrom: chapter, validTo: null, context: 'global',
      embeddingText: `${char.name} 隶属于 ${faction.name}（第${chapter}章）`,
      worldview: 'xianxia', category: 'faction_membership',
    });
  }

  // 6. 物品属性 Fact
  for (const weapon of WEAPONS.slice(0, 10)) {
    const weaponId = `ent_${weapon.toLowerCase().replace(/\s/g, '')}`;
    facts.push({
      id: nextId('fct'),
      subject: weaponId, predicate: 'item_rank', value: pick(['凡器', '法器', '灵器', '仙器', '神器']),
      validFrom: 1, validTo: null, context: 'global',
      embeddingText: makeEmbedding(weapon, '品级', pick(['凡器', '法器', '灵器', '仙器', '神器']), 1),
      worldview: 'xianxia', category: 'item_attribute',
    });
  }

  // 7. 秘境设定
  for (let i = 0; i < 20; i++) {
    const locId = `ent_mijing_${String(i + 1).padStart(2, '0')}`;
    const locName = `秘境${i + 1}号`;
    facts.push({
      id: nextId('fct'),
      subject: locId, predicate: 'danger_level', value: pick(['低', '中', '高', '极高', '必死']),
      validFrom: 1, validTo: null, context: 'global',
      embeddingText: makeEmbedding(locName, '危险等级', pick(['低', '中', '高', '极高', '必死']), 1),
      worldview: 'xianxia', category: 'location_attribute',
    });
    facts.push({
      id: nextId('fct'),
      subject: locId, predicate: 'entry_requirement', value: pick(['筑基期以上', '金丹期以上', '元婴期以上', '化神期以上', '无限制']),
      validFrom: 1, validTo: null, context: 'global',
      embeddingText: makeEmbedding(locName, '进入条件', pick(['筑基期以上', '金丹期以上', '元婴期以上', '化神期以上', '无限制']), 1),
      worldview: 'xianxia', category: 'location_attribute',
    });
  }

  console.log(`  [xianxia] 生成 ${facts.length} 条 Fact`);
  return facts;
}

// ---------------------------------------------------------------------------
// 诡秘世界观 Fact 生成
// ---------------------------------------------------------------------------

function generateLotmFacts(): TestFact[] {
  const facts: TestFact[] = [];
  // 生成 40 个角色
  const characters: Array<{ id: string; name: string; sequence: string; pathway: string }> = [];
  for (let i = 0; i < 40; i++) {
    const name = genName();
    characters.push({
      id: `ent_${name.toLowerCase()}`,
      name,
      sequence: pick(SEQUENCES),
      pathway: pick(PATHWAYS),
    });
  }

  // 1. 角色序列/途径
  for (const char of characters) {
    facts.push({
      id: nextId('fct'),
      subject: char.id, predicate: 'sequence', value: char.sequence,
      validFrom: Math.floor(Math.random() * 200) + 1, validTo: null, context: 'global',
      embeddingText: makeEmbedding(char.name, '序列等级', char.sequence, Math.floor(Math.random() * 200) + 1),
      worldview: 'lotm', category: 'character_sequence',
    });
    facts.push({
      id: nextId('fct'),
      subject: char.id, predicate: 'pathway', value: char.pathway,
      validFrom: 1, validTo: null, context: 'global',
      embeddingText: makeEmbedding(char.name, '途径', char.pathway, 1),
      worldview: 'lotm', category: 'character_pathway',
    });
    // 能力
    for (let j = 0; j < 2; j++) {
      const ability = pick(LOTM_ABILITIES);
      facts.push({
        id: nextId('fct'),
        subject: char.id, predicate: 'ability', value: ability,
        validFrom: Math.floor(Math.random() * 200) + 1, validTo: null, context: 'global',
        embeddingText: makeEmbedding(char.name, '能力', ability, Math.floor(Math.random() * 200) + 1),
        worldview: 'lotm', category: 'character_ability',
      });
    }
  }

  // 2. 物品持有与封印物
  for (let i = 0; i < 60; i++) {
    const char = pick(characters);
    const item = pick(LOTM_ITEMS);
    const itemId = `ent_${item.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const chapter = Math.floor(Math.random() * 200) + 1;
    facts.push({
      id: nextId('fct'),
      subject: char.id, predicate: 'holds_sealed_artifact', value: itemId,
      validFrom: chapter, validTo: null, context: 'global',
      embeddingText: `${char.name} 持有 ${item}（第${chapter}章）`,
      worldview: 'lotm', category: 'holds_artifact',
    });
  }

  // 3. 地点归属
  for (let i = 0; i < 40; i++) {
    const char = pick(characters);
    const loc = pick(LOTM_LOCATIONS);
    const locId = `ent_${loc.toLowerCase().replace(/\s/g, '')}`;
    const chapter = Math.floor(Math.random() * 200) + 1;
    facts.push({
      id: nextId('fct'),
      subject: char.id, predicate: 'location', value: locId,
      validFrom: chapter, validTo: null, context: 'global',
      embeddingText: `${char.name} 位于 ${loc}（第${chapter}章）`,
      worldview: 'lotm', category: 'character_location',
    });
  }

  // 4. 组织归属
  for (let i = 0; i < 60; i++) {
    const char = pick(characters);
    const faction = pick(LOTM_FACTIONS);
    const factionId = `ent_${faction.toLowerCase().replace(/\s/g, '')}`;
    const chapter = Math.floor(Math.random() * 200) + 1;
    facts.push({
      id: nextId('fct'),
      subject: char.id, predicate: 'member_of', value: factionId,
      validFrom: chapter, validTo: null, context: 'global',
      embeddingText: `${char.name} 隶属于 ${faction}（第${chapter}章）`,
      worldview: 'lotm', category: 'faction_membership',
    });
  }

  // 5. 封印物属性
  for (const item of LOTM_ITEMS) {
    const itemId = `ent_${item.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    facts.push({
      id: nextId('fct'),
      subject: itemId, predicate: 'danger_level', value: pick(['安全', '危险', '极危', '封印', '不可接触']),
      validFrom: 1, validTo: null, context: 'global',
      embeddingText: makeEmbedding(item, '危险等级', pick(['安全', '危险', '极危', '封印', '不可接触']), 1),
      worldview: 'lotm', category: 'item_attribute',
    });
  }

  // 6. 隐秘信息——角色之间的秘密知识
  for (let i = 0; i < 100; i++) {
    const knower = pick(characters);
    const target = pick(characters);
    if (knower.id === target.id) continue;
    const secret = pick(['real_identity', 'hidden_ability', 'dark_secret', 'betrayal_plan', 'sealed_memory']);
    const chapter = Math.floor(Math.random() * 200) + 1;
    facts.push({
      id: nextId('fct'),
      subject: knower.id, predicate: `knows_${secret}`, value: target.id,
      validFrom: chapter, validTo: null, context: 'global',
      embeddingText: `${knower.name} 知晓 ${target.name} 的${secret === 'real_identity' ? '真实身份' : secret === 'hidden_ability' ? '隐藏能力' : secret === 'dark_secret' ? '黑暗秘密' : secret === 'betrayal_plan' ? '背叛计划' : '封印记忆'}（第${chapter}章）`,
      worldview: 'lotm', category: 'secret_knowledge',
    });
  }

  console.log(`  [lotm] 生成 ${facts.length} 条 Fact`);
  return facts;
}

// ---------------------------------------------------------------------------
// 科幻世界观 Fact 生成
// ---------------------------------------------------------------------------

function generateScifiFacts(): TestFact[] {
  const facts: TestFact[] = [];
  // 生成 30 个角色
  const characters: Array<{ id: string; name: string; faction: string; planet: string }> = [];
  for (let i = 0; i < 30; i++) {
    const name = genName();
    characters.push({
      id: `ent_${name.toLowerCase()}`,
      name,
      faction: pick(FACTIONS_SCIFI),
      planet: pick(PLANETS),
    });
  }

  // 1. 角色属性（阵营、母星、军衔）
  for (const char of characters) {
    facts.push({
      id: nextId('fct'),
      subject: char.id, predicate: 'faction', value: char.faction,
      validFrom: 1, validTo: null, context: 'global',
      embeddingText: makeEmbedding(char.name, '所属阵营', char.faction, 1),
      worldview: 'scifi', category: 'character_faction',
    });
    facts.push({
      id: nextId('fct'),
      subject: char.id, predicate: 'homeworld', value: char.planet,
      validFrom: 1, validTo: null, context: 'global',
      embeddingText: makeEmbedding(char.name, '母星', char.planet, 1),
      worldview: 'scifi', category: 'character_homeworld',
    });
    facts.push({
      id: nextId('fct'),
      subject: char.id, predicate: 'rank', value: pick(['士兵', '中尉', '上尉', '少校', '上校', '将军', '元帅']),
      validFrom: Math.floor(Math.random() * 150) + 1, validTo: null, context: 'global',
      embeddingText: makeEmbedding(char.name, '军衔', pick(['士兵', '中尉', '上尉', '少校', '上校', '将军', '元帅']), Math.floor(Math.random() * 150) + 1),
      worldview: 'scifi', category: 'character_rank',
    });
  }

  // 2. 星球属性
  for (const planet of PLANETS.slice(0, 8)) {
    const planetId = `ent_${planet.toLowerCase().replace(/\s/g, '')}`;
    facts.push({
      id: nextId('fct'),
      subject: planetId, predicate: 'tech_level', value: pick(TECH_LEVELS),
      validFrom: 1, validTo: null, context: 'global',
      embeddingText: makeEmbedding(planet, '科技水平', pick(TECH_LEVELS), 1),
      worldview: 'scifi', category: 'planet_attribute',
    });
    facts.push({
      id: nextId('fct'),
      subject: planetId, predicate: 'population', value: Math.floor(Math.random() * 100000000000),
      validFrom: 1, validTo: null, context: 'global',
      embeddingText: makeEmbedding(planet, '人口', `${Math.floor(Math.random() * 100000000000)}`, 1),
      worldview: 'scifi', category: 'planet_attribute',
    });
    facts.push({
      id: nextId('fct'),
      subject: planetId, predicate: 'controlled_by', value: pick(FACTIONS_SCIFI),
      validFrom: Math.floor(Math.random() * 150) + 1, validTo: null, context: 'global',
      embeddingText: `${planet} 受 ${pick(FACTIONS_SCIFI)} 控制（第${Math.floor(Math.random() * 150) + 1}章）`,
      worldview: 'scifi', category: 'planet_control',
    });
  }

  // 3. 飞船
  for (let i = 0; i < 30; i++) {
    const ship = pick(SHIPS);
    const shipId = `ent_${ship.toLowerCase().replace(/\s/g, '')}_${String(i + 1).padStart(2, '0')}`;
    facts.push({
      id: nextId('fct'),
      subject: shipId, predicate: 'ship_class', value: pick(['探索级', '军用级', '民用级', '旗舰级', '特种级']),
      validFrom: 1, validTo: null, context: 'global',
      embeddingText: makeEmbedding(`${ship}${i + 1}号`, '舰船级别', pick(['探索级', '军用级', '民用级', '旗舰级', '特种级']), 1),
      worldview: 'scifi', category: 'ship_attribute',
    });
  }

  // 4. 科技
  for (let i = 0; i < 50; i++) {
    const tech = pick(SCIFI_TECHS);
    const faction = pick(FACTIONS_SCIFI);
    const factionId = `ent_${faction.toLowerCase().replace(/\s/g, '')}`;
    const chapter = Math.floor(Math.random() * 150) + 1;
    facts.push({
      id: nextId('fct'),
      subject: factionId, predicate: 'possesses_tech', value: tech,
      validFrom: chapter, validTo: null, context: 'global',
      embeddingText: `${faction} 拥有 ${tech} 技术（第${chapter}章）`,
      worldview: 'scifi', category: 'tech_possession',
    });
  }

  // 5. 角色间关系
  for (let i = 0; i < 100; i++) {
    const subj = pick(characters);
    const obj = pick(characters);
    if (subj.id === obj.id) continue;
    const chapter = Math.floor(Math.random() * 150) + 1;
    facts.push({
      id: nextId('fct'),
      subject: subj.id, predicate: 'allied_with', value: obj.id,
      validFrom: chapter, validTo: null, context: 'global',
      embeddingText: `${subj.name} 与 ${obj.name} 结为同盟（第${chapter}章）`,
      worldview: 'scifi', category: 'relation_alliance',
    });
  }

  // 6. 星际事件
  for (let i = 0; i < 40; i++) {
    const event = pick(EVENTS_SCIFI);
    const planet = pick(PLANETS);
    const chapter = Math.floor(Math.random() * 150) + 1;
    facts.push({
      id: nextId('fct'),
      subject: `ent_${planet.toLowerCase().replace(/\s/g, '')}`, predicate: 'event',
      value: event, validFrom: chapter, validTo: null, context: 'global',
      embeddingText: `${planet} 发生 ${event} 事件（第${chapter}章）`,
      worldview: 'scifi', category: 'planet_event',
    });
  }

  console.log(`  [scifi] 生成 ${facts.length} 条 Fact`);
  return facts;
}

// ---------------------------------------------------------------------------
// 硬负样本生成
// ---------------------------------------------------------------------------
// 硬负样本策略（§11.8.1）：
//   1. 谓词误导型：同组 Fact 中替换 subject，语义向量相近但主题无关
//   2. 人物混淆型：两个不同人物的相似属性
//   3. 时序误导型：同一事物的历史状态与新状态邻近

function generateHardNegatives(baseFacts: TestFact[]): TestFact[] {
  const negatives: TestFact[] = [];

  // 策略 1：谓词误导——取同 category 的 Fact，交换 subject
  const byWorldview = new Map<string, TestFact[]>();
  for (const f of baseFacts) {
    const arr = byWorldview.get(f.worldview) ?? [];
    arr.push(f);
    byWorldview.set(f.worldview, arr);
  }

  // 策略 2：生成"同一境界但不同角色"的相似 Fact
  for (const [worldview, facts] of byWorldview) {
    const realmFacts = facts.filter(f => f.category === 'character_realm' || f.category === 'character_sequence');
    const chars = [...new Set(facts.map(f => f.subject))];

    for (let i = 0; i < 30; i++) {
      const template = pick(realmFacts);
      if (!template) continue;
      const newSubject = pick(chars);
      if (newSubject === template.subject) continue;
      const newName = newSubject.replace('ent_', '');
      const negId = nextId('fct_neg');
      // 构造与正样本高度仿真的 embeddingText
      const negEmbedding = template.embeddingText.replace(
        /^[^的]+/, newName
      );
      negatives.push({
        id: negId,
        subject: newSubject,
        predicate: 'realm',
        value: `假${template.value}`,
        validFrom: Math.floor(Math.random() * 300) + 1, validTo: null, context: 'global',
        embeddingText: negEmbedding + '（干扰项）',
        worldview: worldview as TestFact['worldview'],
        category: 'hard_negative_realm',
      });
    }
  }

  // 策略 3：生成"同时期同地点不同事件"的易混淆 Fact
  for (let i = 0; i < 70; i++) {
    const worldview = pick(['xianxia', 'lotm', 'scifi'] as const);
    const worldviewFacts = byWorldview.get(worldview) ?? [];
    const template = pick(worldviewFacts);
    if (!template) continue;
    const negId = nextId('fct_neg');
    // 修改时间相近但内容无关
    const nearChapter = template.validFrom + Math.floor(Math.random() * 10) - 5;
    negatives.push({
      id: negId,
      subject: template.subject,
      predicate: 'note',
      value: `干扰项_${i}`,
      validFrom: Math.max(1, nearChapter),
      validTo: null,
      context: 'global',
      embeddingText: template.embeddingText.replace(
        /的.*是.*（/,
        `的无关信息是 干扰项${i}（`
      ),
      worldview,
      category: 'hard_negative_temporal',
    });
  }

  console.log(`  [hard-negatives] 生成 ${negatives.length} 条硬负样本`);
  return negatives;
}

// ---------------------------------------------------------------------------
// 查询场景生成
// ---------------------------------------------------------------------------

function generateQueries(facts: TestFact[]): TestQuery[] {
  const queries: TestQuery[] = [];
  // 按 worldview 分组
  const byWorldview = new Map<string, TestFact[]>();
  for (const f of facts) {
    const arr = byWorldview.get(f.worldview) ?? [];
    arr.push(f);
    byWorldview.set(f.worldview, arr);
  }

  // ----- 简单查询（5 个）：精确属性查询 -----
  const xianxiaFacts = byWorldview.get('xianxia') ?? [];
  const realmFacts = xianxiaFacts.filter(f => f.category === 'character_realm');
  for (let i = 0; i < 3 && i < realmFacts.length; i++) {
    const f = realmFacts[i]!;
    const name = f.subject.replace('ent_', '');
    queries.push({
      id: `q_easy_${String(i + 1).padStart(2, '0')}`,
      queryText: `${name}的修炼境界是什么`,
      difficulty: 'easy',
      relevantFactIds: [f.id],
      description: `查询角色 ${name} 的境界`,
    });
  }
  // 从 lotm 和 scifi 各加一个简单查询
  const lotmFacts = byWorldview.get('lotm') ?? [];
  const seqFacts = lotmFacts.filter(f => f.category === 'character_sequence');
  if (seqFacts.length > 0) {
    const f = seqFacts[0]!;
    const name = f.subject.replace('ent_', '');
    queries.push({
      id: 'q_easy_04',
      queryText: `${name}的序列是多少`,
      difficulty: 'easy',
      relevantFactIds: [f.id],
      description: `查询角色 ${name} 的序列等级`,
    });
  }
  const scifiFacts = byWorldview.get('scifi') ?? [];
  const factionFacts = scifiFacts.filter(f => f.category === 'character_faction');
  if (factionFacts.length > 0) {
    const f = factionFacts[0]!;
    const name = f.subject.replace('ent_', '');
    queries.push({
      id: 'q_easy_05',
      queryText: `${name}属于哪个阵营`,
      difficulty: 'easy',
      relevantFactIds: [f.id],
      description: `查询角色 ${name} 的阵营归属`,
    });
  }

  // ----- 中等查询（5 个）：关系 + 上下文 -----
  const enemyFacts = xianxiaFacts.filter(f => f.category === 'relation_enemy_of');
  for (let i = 0; i < 2 && i < enemyFacts.length; i++) {
    const f = enemyFacts[i]!;
    const subjName = f.subject.replace('ent_', '');
    queries.push({
      id: `q_medium_${String(i + 1).padStart(2, '0')}`,
      queryText: `${subjName}的敌人是谁`,
      difficulty: 'medium',
      relevantFactIds: [f.id],
      description: `查询角色 ${subjName} 的敌对关系`,
    });
  }
  // 物品持有
  const holdFacts = xianxiaFacts.filter(f => f.category === 'holds_item');
  for (let i = 0; i < 2 && i < holdFacts.length; i++) {
    const f = holdFacts[i]!;
    const name = f.subject.replace('ent_', '');
    queries.push({
      id: `q_medium_${String(i + 3).padStart(2, '0')}`,
      queryText: `${name}有什么武器`,
      difficulty: 'medium',
      relevantFactIds: [f.id],
      description: `查询角色 ${name} 持有的武器`,
    });
  }
  // 封印物持有
  const artifactFacts = lotmFacts.filter(f => f.category === 'holds_artifact');
  if (artifactFacts.length > 0) {
    const f = artifactFacts[0]!;
    const name = f.subject.replace('ent_', '');
    queries.push({
      id: 'q_medium_05',
      queryText: `${name}持有什么封印物`,
      difficulty: 'medium',
      relevantFactIds: [f.id],
      description: `查询角色 ${name} 持有的封印物`,
    });
  }

  // ----- 困难查询（6 个）：语义组合 + 跨关系 -----
  // 困难查询需要语义理解——查询文本和 Fact 的 embeddingText 措辞不完全一样
  const secretFacts = lotmFacts.filter(f => f.category === 'secret_knowledge');
  for (let i = 0; i < 3 && i < secretFacts.length; i++) {
    const f = secretFacts[i]!;
    const knowerName = f.subject.replace('ent_', '');
    const targetName = (f.value as string).replace('ent_', '');
    queries.push({
      id: `q_hard_${String(i + 1).padStart(2, '0')}`,
      queryText: `${knowerName}发现了${targetName}的什么秘密`,
      difficulty: 'hard',
      relevantFactIds: [f.id],
      description: `查询 ${knowerName} 知晓 ${targetName} 的秘密`,
    });
  }

  // 势力内部信息
  const membershipFacts = [...xianxiaFacts, ...lotmFacts].filter(f => f.category === 'faction_membership');
  if (membershipFacts.length >= 10) {
    // 挑三个同属一个势力的角色，查询"这个势力有哪些人"
    const byFaction = new Map<string, TestFact[]>();
    for (const f of membershipFacts) {
      const arr = byFaction.get(f.value as string) ?? [];
      arr.push(f);
      byFaction.set(f.value as string, arr);
    }
    let hardIdx = 4;
    for (const [, members] of byFaction) {
      if (members.length >= 3 && hardIdx <= 6) {
        const factionName = (members[0]!.value as string).replace('ent_', '');
        queries.push({
          id: `q_hard_${String(hardIdx).padStart(2, '0')}`,
          queryText: `${factionName}有哪些成员`,
          difficulty: 'hard',
          relevantFactIds: members.slice(0, 3).map(m => m.id),
          description: `查询 ${factionName} 的成员列表`,
        });
        hardIdx++;
      }
      if (hardIdx > 6) break;
    }
  }

  // ----- 极难查询（4 个）：多维度推理 + 跨角色 -----
  // 极难查询需要同时匹配多个维度的信息
  const discipleFacts = xianxiaFacts.filter(f => f.category === 'relation_disciple_of');
  if (discipleFacts.length >= 3) {
    const f = discipleFacts[0]!;
    const targetF = xianxiaFacts.filter(f2 => f2.subject === f.value && f2.category === 'character_realm')[0];
    const subjName = f.subject.replace('ent_', '');
    const masterName = (f.value as string).replace('ent_', '');
    queries.push({
      id: 'q_extreme_01',
      queryText: `${subjName}的师父的修为如何`,
      difficulty: 'extreme',
      relevantFactIds: [f.id, ...(targetF ? [targetF.id] : [])],
      description: `查询 ${subjName} 的师父 ${masterName} 的境界`,
    });
    // 第二个极难查询
    const f2 = discipleFacts[1]!;
    const targetF2 = xianxiaFacts.filter(fx => fx.subject === f2.value && fx.category === 'character_meridian')[0];
    const subjName2 = f2.subject.replace('ent_', '');
    const masterName2 = (f2.value as string).replace('ent_', '');
    queries.push({
      id: 'q_extreme_02',
      queryText: `${subjName2}的师父的经脉如何`,
      difficulty: 'extreme',
      relevantFactIds: [f2.id, ...(targetF2 ? [targetF2.id] : [])],
      description: `查询 ${subjName2} 的师父 ${masterName2} 的经脉状态`,
    });
  }

  // 跨关系极难：某角色持有的武器品级
  if (holdFacts.length >= 2) {
    const holdF = holdFacts[2] ?? holdFacts[1]!;
    const weaponId = holdF.value as string;
    const weaponFacts = xianxiaFacts.filter(f => f.subject === weaponId && f.category === 'item_attribute');
    const charName = holdF.subject.replace('ent_', '');
    const weaponName = weaponId.replace('ent_', '');
    queries.push({
      id: 'q_extreme_03',
      queryText: `${charName}的武器的品级是什么`,
      difficulty: 'extreme',
      relevantFactIds: [holdF.id, ...weaponFacts.slice(0, 1).map(f => f.id)],
      description: `查询 ${charName} 持有的 ${weaponName} 的品级`,
    });
  }

  // 极难：同一地点发生的事件
  const locFacts = xianxiaFacts.filter(f => f.category === 'character_location');
  if (locFacts.length >= 3) {
    const loc = locFacts[0]!;
    const locName = (loc.value as string).replace('ent_', '');
    const otherCharsAtLoc = locFacts.filter(f => f.value === loc.value).slice(0, 2);
    queries.push({
      id: 'q_extreme_04',
      queryText: `谁在${locName}`,
      difficulty: 'extreme',
      relevantFactIds: [loc.id, ...otherCharsAtLoc.map(f => f.id)],
      description: `查询位于 ${locName} 的所有角色`,
    });
  }

  console.log(`  [queries] 生成 ${queries.length} 个查询场景`);
  return queries;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

const OUTPUT_DIR = path.resolve('tests/spike-01');

function main(): void {
  console.log('=== Spike 1: 数据集生成 ===\n');

  // 设置随机种子以获得可复现结果
  // （注意：Math.random 不可复现，生产环境应用 seedrandom 库）
  console.log('生成基准 Fact...');
  const xianxiaFacts = generateXianxiaFacts();
  const lotmFacts = generateLotmFacts();
  const scifiFacts = generateScifiFacts();

  const allBaseFacts = [...xianxiaFacts, ...lotmFacts, ...scifiFacts];
  console.log(`\n基准 Fact 总计: ${allBaseFacts.length} 条`);

  console.log('\n生成硬负样本...');
  const hardNegatives = generateHardNegatives(allBaseFacts);
  console.log(`硬负样本: ${hardNegatives.length} 条`);

  console.log('\n生成查询场景...');
  const queries = generateQueries(allBaseFacts);

  const dataset: SpikeDataset = {
    facts: allBaseFacts,
    hardNegatives,
    queries,
    metadata: {
      totalBaseFacts: allBaseFacts.length,
      totalHardNegatives: hardNegatives.length,
      worldviews: ['xianxia', 'lotm', 'scifi'],
      generatedAt: new Date().toISOString(),
    },
  };

  // 持久化数据集
  const outputPath = path.join(OUTPUT_DIR, 'dataset.json');
  fs.writeFileSync(outputPath, JSON.stringify(dataset, null, 2), 'utf-8');
  console.log(`\n✅ 数据集已保存到 ${outputPath}`);
  console.log(`   总 Fact 数: ${allBaseFacts.length + hardNegatives.length}`);
  console.log(`   查询场景: ${queries.length}`);
  console.log(`     简单: ${queries.filter(q => q.difficulty === 'easy').length}`);
  console.log(`     中等: ${queries.filter(q => q.difficulty === 'medium').length}`);
  console.log(`     困难: ${queries.filter(q => q.difficulty === 'hard').length}`);
  console.log(`     极难: ${queries.filter(q => q.difficulty === 'extreme').length}`);
}

main();
