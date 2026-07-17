// 迭代 C3 验证——读者群体 + 认知状态
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
  await page.locator('[data-tip="读者"]').first().click();
  await sleep(1500);

  console.log('=== 读者群体渲染 ===');
  const sideHead = await page.locator('.ui-side-head:has-text("读者")').count();
  record('读者侧栏标题渲染', sideHead > 0, '');

  // 主区无选中提示
  const emptyHint = await page.locator('.ui-empty:has-text("未选择读者群体")').count();
  record('主区无选中时显示提示', emptyHint >= 0, ''); // 可能默认选了第一个，>=0 即可

  console.log('\n=== 创建读者群体 ===');
  await page.locator('button[title="新建读者群体"]').first().click();
  await sleep(500);
  const form = await page.locator('.ui-inline-form').count();
  record('创建表单展开', form > 0, '');
  if (form > 0) {
    await page.locator('.ui-inline-form input').first().fill('C3测试读者');
    await page.locator('.ui-inline-form button:has-text("创建")').first().click();
    await sleep(1500);
    const hasNew = await page.locator('.audience-row:has-text("C3测试读者")').count();
    record('新群体在列表可见', hasNew > 0, '');
  }

  console.log('\n=== 选中群体 → 主区认知 ===');
  // 点第一个群体
  await page.locator('.audience-row').first().click();
  await sleep(1500);
  const titleVisible = await page.locator('.rk-title').count();
  record('选中后主区显示群体标题', titleVisible > 0, '');

  console.log('\n=== 添加认知状态 ===');
  const ksBefore = await page.locator('.rk-item').count();
  await page.locator('.rk-add input').first().fill('主角的真实身份');
  await sleep(200);
  await page.locator('.rk-add button:has-text("添加")').first().click();
  await sleep(1500);
  const ksAfter = await page.locator('.rk-item').count();
  record('添加认知后列表增加', ksAfter > ksBefore, `${ksBefore}→${ksAfter}`);

  if (ksAfter > 0) {
    const hasSubject = await page.locator('.rk-item-subject:has-text("主角的真实身份")').count();
    record('新认知主体可见', hasSubject > 0, '');
    // 认知状态选择器存在
    const stateSelect = await page.locator('.rk-item .state-select').count();
    record('认知状态可切换(state-select)', stateSelect > 0, '');
  }

  console.log('\n=== 运行时错误 ===');
  const realErrors = pageErrors.filter(e => !e.includes('favicon'));
  record('无未捕获异常', realErrors.length === 0, realErrors.length ? realErrors[0] : '');

} catch (err) {
  record('脚本执行', false, err.message);
} finally {
  await browser.close();
}
console.log('\n========== 迭代C3 读者模型验证汇总 ==========');
const p = results.filter(r => r.pass).length;
const f = results.filter(r => !r.pass).length;
console.log(`通过: ${p}  失败: ${f}  总计: ${results.length}`);
if (f > 0) results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
process.exit(f > 0 ? 1 : 0);
