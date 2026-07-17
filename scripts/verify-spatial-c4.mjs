// 迭代 C4 验证——空间地图只读视图（空状态 + 插件加载健康）
import { chromium } from 'playwright-core';
import http from 'http';
const URL = 'http://localhost:5173/';
const EXECUTABLE = 'C:\\Users\\10652\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
function post(path, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body || {});
    const req = http.request(`http://localhost:5173${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({status:res.statusCode,body:d}));
    });
    req.on('error',()=>resolve({status:0,body:''})); req.write(data); req.end();
  });
}
await post('/api/projects/wprj_1781849935495_aydm4l/activate', {});
await sleep(800);

const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));

try {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await sleep(2500);
  await page.locator('[data-tip="空间"]').first().click();
  await sleep(2000);

  console.log('=== 空间地图渲染 ===');
  const sideHead = await page.locator('.ui-side-head:has-text("空间")').count();
  record('空间侧栏标题渲染', sideHead > 0, '');

  // 统计卡片（节点/关系）
  const statCards = await page.locator('.stat-card').count();
  record('统计卡片渲染', statCards >= 2, `卡片数=${statCards}`);

  console.log('\n=== 空状态 ===');
  // 灰域行者无空间数据，应显示空状态或 0 节点
  const emptyHint = await page.locator('.ui-empty:has-text("空间结构为空")').count();
  const zeroNode = await page.locator('.stat-num').first().textContent();
  record('空状态正确显示', emptyHint > 0 || zeroNode === '0', `节点数="${zeroNode}" 空提示=${emptyHint}`);

  console.log('\n=== 主区树视图（无数据时不崩溃）===');
  // 主区不应报错
  const realErrors = pageErrors.filter(e => !e.includes('favicon'));
  record('插件加载无未捕获异常', realErrors.length === 0, realErrors.length ? realErrors[0] : '');

  // 验证 BFF 端点返回结构正确
  console.log('\n=== BFF 端点数据结构 ===');
  const treeRes = await new Promise((resolve) => {
    http.get(`http://localhost:5173/api/projects/wprj_1781849935495_aydm4l/spatial/tree`, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(JSON.parse(d)));
    }).on('error',()=>resolve(null));
  });
  record('BFF 返回 tree 结构', treeRes && typeof treeRes.nodeCount === 'number', `nodeCount=${treeRes?.nodeCount} edgeCount=${treeRes?.edgeCount}`);

} catch (err) {
  record('脚本执行', false, err.message);
} finally {
  await browser.close();
}
console.log('\n========== 迭代C4 空间地图验证汇总 ==========');
const p = results.filter(r => r.pass).length;
const f = results.filter(r => !r.pass).length;
console.log(`通过: ${p}  失败: ${f}  总计: ${results.length}`);
if (f > 0) results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
process.exit(f > 0 ? 1 : 0);
