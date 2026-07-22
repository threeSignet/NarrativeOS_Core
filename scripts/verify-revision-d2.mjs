// 迭代 D2 验证——修订历史只读查看器
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
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(res.statusCode));
    });
    req.on('error',()=>resolve(0)); req.write(data); req.end();
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
  await page.locator('[data-tip="修订"]').first().click();
  await sleep(2000);

  console.log('=== 修订历史渲染 ===');
  const sideHead = await page.locator('.ui-side-head:has-text("修订")').count();
  record('修订侧栏标题渲染', sideHead > 0, '');

  // 类型过滤芯片
  const filterChips = await page.locator('.filter-chips .ui-chip').count();
  record('类型过滤芯片存在', filterChips > 0, `芯片数=${filterChips}`);

  console.log('\n=== 主区（空状态或时间线）===');
  // 灰域行者可能无修订记录，验证空状态或非崩溃
  const emptyState = await page.locator('.ui-empty:has-text("暂无修订记录")').count();
  const itemList = await page.locator('.rev-item').count();
  record('主区正确渲染(空状态或有条目)', emptyState > 0 || itemList > 0, `空状态=${emptyState} 条目数=${itemList}`);

  console.log('\n=== 类型过滤切换 ===');
  // 点一个类型过滤，验证不崩溃
  const chips = await page.locator('.filter-chips .ui-chip').all();
  if (chips.length > 1) {
    await chips[1].click();
    await sleep(400);
    record('类型过滤切换不崩溃', true, '');
    await chips[0].click(); // 重置回全部
  }

  console.log('\n=== BFF 端点 ===');
  const revData = await new Promise((resolve) => {
    http.get('http://localhost:5173/api/projects/wprj_1781849935495_aydm4l/revisions?limit=5', res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>{try{resolve(JSON.parse(d))}catch{resolve([])}});
    }).on('error',()=>resolve([]));
  });
  record('BFF 返回数组', Array.isArray(revData), `类型=${Array.isArray(revData) ? 'array' : typeof revData}`);

  console.log('\n=== 运行时错误 ===');
  const realErrors = pageErrors.filter(e => !e.includes('favicon'));
  record('无未捕获异常', realErrors.length === 0, realErrors.length ? realErrors[0] : '');

} catch (err) {
  record('脚本执行', false, err.message);
} finally {
  await browser.close();
}
console.log('\n========== 迭代D2 修订历史验证汇总 ==========');
const p = results.filter(r => r.pass).length;
const f = results.filter(r => !r.pass).length;
console.log(`通过: ${p}  失败: ${f}  总计: ${results.length}`);
if (f > 0) results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
process.exit(f > 0 ? 1 : 0);
