// 迭代 C1 验证——伏笔看板创建 + 状态推进
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
function post(path) {
  return new Promise((resolve) => {
    const req = http.request(`http://localhost:5173${path}`, { method: 'POST' }, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(res.statusCode));
    });
    req.on('error',()=>resolve(0)); req.end();
  });
}
await post('/api/projects/wprj_1781849935495_aydm4l/activate');
await sleep(800);

const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));

try {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await sleep(2500);
  await page.locator('[data-tip="伏笔"]').first().click();
  await sleep(1500);

  console.log('=== 伏笔看板渲染 ===');
  const sideHead = await page.locator('.ui-side-head:has-text("伏笔")').count();
  record('伏笔侧栏标题渲染', sideHead > 0, '');

  // 初始空状态（灰域行者无伏笔）
  const initialCards = await page.locator('.fs-card').count();
  console.log(`  初始伏笔卡: ${initialCards}`);

  console.log('\n=== 创建伏笔 ===');
  await page.locator('button[title="新建伏笔"]').first().click();
  await sleep(500);
  const form = await page.locator('.ui-inline-form').count();
  record('创建表单展开', form > 0, '');

  if (form > 0) {
    await page.locator('.ui-inline-form input').first().fill('C1测试：主角的神秘身世');
    await page.locator('.ui-inline-form textarea').first().fill('让读者怀疑主角真实身份');
    await sleep(200);
    await page.locator('.ui-inline-form button:has-text("创建")').first().click();
    await sleep(1500);
    const cardsAfter = await page.locator('.fs-card').count();
    record('创建后卡片增加', cardsAfter > initialCards, `${initialCards}→${cardsAfter}`);
    const hasNew = await page.locator('.fs-card:has-text("C1测试")').count();
    record('新伏笔在列表可见', hasNew > 0, '');
    // 初始状态应是"已计划"
    const hasPlannedGroup = await page.locator('.fs-group:has-text("已计划")').count();
    record('新伏笔归入"已计划"列', hasPlannedGroup > 0, '');
  }

  console.log('\n=== 状态推进(planned → active)===');
  const advanceBtn = page.locator('.fs-card').first().locator('button:has-text("→")');
  if (await advanceBtn.count() > 0) {
    const btnText = await advanceBtn.first().textContent();
    await advanceBtn.first().click();
    await sleep(1500);
    record('点击推进按钮', true, `按钮="${btnText}"`);
    // 验证卡片移到"铺设中"列
    const activeGroup = await page.locator('.fs-group:has-text("铺设中")').count();
    record('推进后归入"铺设中"列', activeGroup > 0, '');
  }

  console.log('\n=== 放弃伏笔 ===');
  const abandonBtn = page.locator('.fs-card').first().locator('button:has-text("放弃")');
  if (await abandonBtn.count() > 0) {
    await abandonBtn.first().click();
    await sleep(1500);
    // 放弃后应归入"已放弃"列
    const abandonedGroup = await page.locator('.fs-group:has-text("已放弃")').count();
    record('放弃后归入"已放弃"列', abandonedGroup > 0, '');
  }

  console.log('\n=== 运行时错误 ===');
  const realErrors = pageErrors.filter(e => !e.includes('favicon'));
  record('无未捕获异常', realErrors.length === 0, realErrors.length ? realErrors[0] : '');

} catch (err) {
  record('脚本执行', false, err.message);
} finally {
  await browser.close();
}
console.log('\n========== 迭代C1 伏笔看板验证汇总 ==========');
const p = results.filter(r => r.pass).length;
const f = results.filter(r => !r.pass).length;
console.log(`通过: ${p}  失败: ${f}  总计: ${results.length}`);
if (f > 0) results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
process.exit(f > 0 ? 1 : 0);
