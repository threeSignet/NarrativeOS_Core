// 直接 API 层验证 confirmRelationCommitByPv 修复(绕过前端项目切换问题)
// 验证:确认 confirm_proposal 决策 → 决策被 resolve + 候选变 committed + 图谱出现 committed 边
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
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    }).on('error', reject);
  });
}
function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

// 1. 列出待确认决策,找 confirm_proposal
const decisionsRes = await get('/decisions');
const allDecisions = decisionsRes.data;
const proposalDecisions = allDecisions.filter(d => d.kind === 'confirm_proposal' && d.status === 'open');
record('存在 confirm_proposal 待确认决策', proposalDecisions.length > 0, `数=${proposalDecisions.length}`);

if (proposalDecisions.length > 0) {
  const target = proposalDecisions[0];
  console.log(`  目标决策: ${target.title} (id=${target.id.slice(-8)}, pvId=${target.linkedObjectId?.slice(-8)})`);

  // 2. 记录确认前的候选状态 + 图谱边
  const candsBefore = await get('/relations');
  const submittedBefore = candsBefore.data.filter(c => c.status === 'submitted').length;
  const committedBefore = candsBefore.data.filter(c => c.status === 'committed').length;
  console.log(`  确认前: submitted=${submittedBefore} committed=${committedBefore}`);

  // 3. 调用 resolve(触发 confirmRelationCommitByPv)
  console.log('\n--- 调用 POST /decisions/:id/resolve ---');
  const resolveRes = await post(`/decisions/${target.id}/resolve`, { action: 'resolve' });
  console.log(`  响应 status=${resolveRes.status}:`, JSON.stringify(resolveRes.data).slice(0, 200));
  record('resolve 接口返回 success=true', resolveRes.data?.success === true, `success=${resolveRes.data?.success}`);

  // 4. 验证决策被 resolve
  const decisionsAfter = await get('/decisions');
  const stillOpen = decisionsAfter.data.find(d => d.id === target.id);
  record('决策被 resolve(不再是 open)', !stillOpen || stillOpen.status !== 'open', `status=${stillOpen?.status}`);

  // 5. 验证候选变 committed
  const candsAfter = await get('/relations');
  const committedAfter = candsAfter.data.filter(c => c.status === 'committed').length;
  record('committed 候选增加', committedAfter > committedBefore, `${committedBefore}→${committedAfter}`);

  // 6. 验证图谱有 committed 边
  const graphRes = await get('/graph');
  const committedEdges = graphRes.data.edges?.filter(e => e.sourceLayer === 'committed').length;
  record('图谱出现 committed 边', committedEdges > 0, `committed 边数=${committedEdges}`);
}

console.log('\n========== 确认关系修复验证汇总 ==========');
const p = results.filter(r => r.pass).length;
const f = results.filter(r => !r.pass).length;
console.log(`通过: ${p}  失败: ${f}  总计: ${results.length}`);
if (f > 0) results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
process.exit(f > 0 ? 1 : 0);
