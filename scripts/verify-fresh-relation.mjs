// 新建关系 + 立即确认(走完整 submitRelationCandidate,确保 coreProposalId 正确填)
import http from 'http';
const PID = 'wprj_1781849935495_aydm4l';
const BASE = `http://localhost:5173/api/projects/${PID}`;
const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
function get(path) {
  return new Promise((resolve, reject) => {
    http.get(BASE + path, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    }).on('error', reject);
  });
}
function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d), raw: d }); } catch { resolve({ status: res.statusCode, body: d, raw: d }); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

// 1. 找两个已注册实体
const entities = await get('/entities?status=registered');
record('有≥2个已注册实体', entities.length >= 2, `数=${entities.length}`);
if (entities.length < 2) process.exit(1);

const [src, tgt] = entities;
console.log(`源: ${src.name} (${src.id.slice(-8)})`);
console.log(`目标: ${tgt.name} (${tgt.id.slice(-8)})`);

// 2. 新建关系(一步创建:createCandidate + submitRelationCandidate)
console.log('\n--- 新建关系 ---');
const createRes = await post('/relations', {
  sourceEntityId: src.id, targetEntityId: tgt.id,
  relationTypeId: 'enemy', layer: 'world', direction: 'bidirectional',
});
record('新建关系接口成功', createRes.status === 200, `status=${createRes.status}`);
console.log('  响应:', createRes.raw.slice(0, 200));

// 3. 查新建的决策
await new Promise(r => setTimeout(r, 500));
const decisions = await get('/decisions');
const newDecision = decisions.find(d => d.kind === 'confirm_proposal' && d.status === 'open' && d.title.includes(src.name));
record('新建关系生成待确认决策', !!newDecision, newDecision?.title);
if (!newDecision) { console.log('所有决策:', decisions.map(d=>d.title)); process.exit(1); }

// 4. 查新 PV 的 coreProposalId 是否正确填
const pvId = newDecision.linkedObjectId;
console.log(`\n--- 新 PV(${pvId.slice(-8)}) 详情 ---`);
const fs = await import('fs');
// 直接查 DB
const { execSync } = await import('child_process');
try {
  const dbCheck = execSync(`node -e "const D=require('better-sqlite3');const db=new D('./data/projects/灰域行者/project.db',{readonly:true});const pv=db.prepare('SELECT id,source_refs_json,core_proposal_id,status FROM writing_proposal_views WHERE id=?').get('${pvId}');console.log(JSON.stringify(pv))"`, { encoding: 'utf-8' });
  console.log('  PV:', dbCheck.trim());
  record('新 PV 有 coreProposalId', dbCheck.includes('"core_proposal_id":"'), '检查 core_proposal_id 非空');
} catch (e) { console.log('  DB 查询失败:', e.message); }

// 5. 确认关系(走修复后的 confirmRelationCommitByPv)
console.log('\n--- 确认关系 ---');
const confirmRes = await post(`/decisions/${newDecision.id}/resolve`, { action: 'resolve' });
console.log('  响应:', confirmRes.raw.slice(0, 200));
record('确认关系返回 success', confirmRes.body?.success === true, `success=${confirmRes.body?.success}`);

// 6. 验证决策被 resolve
const decisionsAfter = await get('/decisions');
const stillOpen = decisionsAfter.find(d => d.id === newDecision.id);
record('决策被 resolve', !stillOpen || stillOpen.status !== 'open', `status=${stillOpen?.status}`);

// 7. 验证图谱有新 committed 边
const graph = await get('/graph');
const enemyEdges = graph.edges?.filter(e => e.sourceLayer === 'committed' && e.label === 'enemy').length;
record('图谱出现 committed enemy 边', enemyEdges > 0, `enemy committed 边=${enemyEdges}`);

console.log('\n========== 新建关系完整流程汇总 ==========');
const p = results.filter(r => r.pass).length;
const f = results.filter(r => !r.pass).length;
console.log(`通过: ${p}  失败: ${f}  总计: ${results.length}`);
if (f > 0) results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
process.exit(f > 0 ? 1 : 0);
