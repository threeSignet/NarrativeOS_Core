// 迭代 D1 验证——场景卡 CRUD + 状态推进
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

// 先确保有章节（场景依赖章节）
const chaptersRes = await new Promise((resolve) => {
  http.get('http://localhost:5173/api/projects/wprj_1781849935495_aydm4l/chapters', res => {
    let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(JSON.parse(d)));
  }).on('error',()=>resolve([]));
});
let chapterId = chaptersRes[0]?.id;
if (!chapterId) {
  const cr = await post('/api/projects/wprj_1781849935495_aydm4l/chapters', { title: 'D1测试章节' });
  chapterId = JSON.parse(cr.body).id;
  console.log('创建了测试章节:', chapterId);
}
await sleep(500);

const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));

try {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await sleep(2500);
  await page.locator('[data-tip="场景"]').first().click();
  await sleep(2000);

  console.log('=== 场景板渲染 ===');
  const sideHead = await page.locator('.ui-side-head:has-text("场景")').count();
  record('场景侧栏标题渲染', sideHead > 0, '');

  console.log('\n=== 创建场景 ===');
  await page.locator('button[title="新建场景"]').first().click();
  await sleep(500);
  const form = await page.locator('.ui-inline-form').count();
  record('创建表单展开', form > 0, '');
  if (form > 0) {
    // 选第一个章节
    await page.locator('.ui-inline-form select').first().selectOption({ index: 1 });
    await sleep(200);
    await page.locator('.ui-inline-form input').first().fill('D1测试：雨夜对峙');
    await sleep(200);
    await page.locator('.ui-inline-form button:has-text("创建")').first().click();
    await sleep(1500);
    const hasNew = await page.locator('.scene-row:has-text("雨夜对峙")').count();
    record('新场景在列表可见', hasNew > 0, '');
    // 场景归入章节分组
    const groupTitle = await page.locator('.chapter-group-title').count();
    record('场景按章节分组', groupTitle > 0, '');
  }

  console.log('\n=== 选中场景 → 主区详情 ===');
  await page.locator('.scene-row').first().click();
  await sleep(1000);
  const detail = await page.locator('.sd-content').count();
  record('选中后主区显示详情', detail > 0, '');
  if (detail > 0) {
    const purposeChips = await page.locator('.purpose-chips .ui-chip').count();
    record('场景功能芯片存在', purposeChips > 0, `芯片数=${purposeChips}`);
    const povSelect = await page.locator('.pov-select').count();
    record('POV 下拉存在', povSelect > 0, '');
  }

  console.log('\n=== 状态推进 ===');
  const advanceBtn = page.locator('.scene-row').first().locator('button:has-text("→")');
  if (await advanceBtn.count() > 0) {
    await advanceBtn.click();
    await sleep(1200);
    record('状态推进按钮可点击', true, '');
  } else {
    record('状态推进按钮存在', false, '');
  }

  console.log('\n=== 运行时错误 ===');
  const realErrors = pageErrors.filter(e => !e.includes('favicon'));
  record('无未捕获异常', realErrors.length === 0, realErrors.length ? realErrors[0] : '');

} catch (err) {
  record('脚本执行', false, err.message);
} finally {
  await browser.close();
}
console.log('\n========== 迭代D1 场景卡验证汇总 ==========');
const p = results.filter(r => r.pass).length;
const f = results.filter(r => !r.pass).length;
console.log(`通过: ${p}  失败: ${f}  总计: ${results.length}`);
if (f > 0) results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
process.exit(f > 0 ? 1 : 0);
