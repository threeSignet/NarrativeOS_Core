// 调试 confirmRelationCommit 深层失败原因
import http from 'http';
const PID = 'wprj_1781849935495_aydm4l';
const BASE = `http://localhost:5173/api/projects/${PID}`;
function get(path) {
  return new Promise((resolve, reject) => {
    http.get(BASE + path, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve(d); }
      });
    }).on('error', reject);
  });
}
function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d), raw: d }); }
        catch { resolve({ status: res.statusCode, body: d, raw: d }); }
      });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

// 找一个 confirm_proposal 决策,看它的 PV 详情
const decisions = await get('/decisions');
const target = decisions.find(d => d.kind === 'confirm_proposal' && d.status === 'open');
if (!target) { console.log('无 open confirm_proposal'); process.exit(0); }
console.log('目标决策:', JSON.stringify(target, null, 2));

// 尝试 resolve 并抓详细
const res = await post(`/decisions/${target.id}/resolve`, { action: 'resolve' });
console.log('\nresolve 响应 status:', res.status);
console.log('resolve 响应 body:', res.raw);

// 看候选列表找这个 PV 对应的候选
const cands = await get('/relations');
console.log('\n所有候选:');
cands.forEach(c => console.log(`  ${c.id.slice(-8)} status=${c.status} type=${c.relationTypeId} sourceRefs=${JSON.stringify(c.sourceRefs)}`));
