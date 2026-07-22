// 迭代 D3 验证——风格指南
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
  await page.locator('[data-tip="风格"]').first().click();
  await sleep(2000);

  console.log('=== 风格指南渲染 ===');
  const sideHead = await page.locator('.ui-side-head:has-text("风格指南")').count();
  record('风格指南侧栏标题渲染', sideHead > 0, '');

  // 偏好芯片
  const chips = await page.locator('.chip-row .ui-chip').count();
  record('偏好设置芯片存在', chips > 0, `芯片数=${chips}`);

  console.log('\n=== 主区（示例+禁用）===');
  const sections = await page.locator('.sd-section').count();
  record('主区两个区块(示例+禁用)', sections >= 2, `区块数=${sections}`);

  // 空状态
  const emptyExamples = await page.locator('.ui-empty:has-text("暂无示例")').count();
  const emptyBanned = await page.locator('.ui-empty:has-text("暂无禁用表达")').count();
  record('空状态正确', emptyExamples > 0 || emptyBanned > 0, `示例空=${emptyExamples} 禁用空=${emptyBanned}`);

  console.log('\n=== BFF 端点 ===');
  const guideData = await new Promise((resolve) => {
    http.get('http://localhost:5173/api/projects/wprj_1781849935495_aydm4l/styles', res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>{try{resolve(JSON.parse(d))}catch{resolve(null)}});
    }).on('error',()=>resolve(null));
  });
  record('BFF 返回指南对象', guideData && guideData.id, `hasId=${!!guideData?.id}`);

  const examplesData = await new Promise((resolve) => {
    http.get('http://localhost:5173/api/projects/wprj_1781849935495_aydm4l/styles/examples', res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>{try{resolve(JSON.parse(d))}catch{resolve([])}});
    }).on('error',()=>resolve([]));
  });
  record('BFF 返回示例数组', Array.isArray(examplesData), `type=${typeof examplesData}`);

  console.log('\n=== 运行时错误 ===');
  const realErrors = pageErrors.filter(e => !e.includes('favicon'));
  record('无未捕获异常', realErrors.length === 0, realErrors.length ? realErrors[0] : '');

} catch (err) {
  record('脚本执行', false, err.message);
} finally {
  await browser.close();
}
console.log('\n========== 迭代D3 风格指南验证汇总 ==========');
const p = results.filter(r => r.pass).length;
const f = results.filter(r => !r.pass).length;
console.log(`通过: ${p}  失败: ${f}  总计: ${results.length}`);
if (f > 0) results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
process.exit(f > 0 ? 1 : 0);
