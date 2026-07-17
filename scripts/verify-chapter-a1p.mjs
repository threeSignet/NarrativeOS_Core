// 迭代 A1' 验证——章节规划信息条(goals/POV 编辑)
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
  await page.locator('[data-tip="章节"]').first().click();
  await sleep(1500);

  console.log('=== 选中章节 → 信息条渲染 ===');
  // 点第一个章节
  await page.locator('.chapter-row').first().click();
  await sleep(2000);

  const infoBar = await page.locator('.chapter-info-bar').count();
  record('章节信息条渲染', infoBar > 0, '');

  const chapterLabel = await page.locator('.info-chapter-label').first().textContent();
  record('信息条显示章节序号', !!chapterLabel && chapterLabel.includes('章'), `label="${chapterLabel}"`);

  console.log('\n=== goals 标签编辑 ===');
  const goalInput = page.locator('.goal-input').first();
  record('goals 输入框存在', await goalInput.count() > 0, '');

  if (await goalInput.count() > 0) {
    const goalsBefore = await page.locator('.goal-chip').count();
    await goalInput.fill('A1p测试目标');
    await sleep(200);
    await goalInput.press('Enter');
    await sleep(2000); // 等 saveChapterMeta + 刷新

    const goalsAfter = await page.locator('.goal-chip').count();
    record('添加 goal 后标签增加', goalsAfter > goalsBefore, `${goalsBefore}→${goalsAfter}`);

    const hasNewGoal = await page.locator('.goal-chip:has-text("A1p测试目标")').count();
    record('新 goal 可见', hasNewGoal > 0, '');

    // 移除 goal
    if (hasNewGoal > 0) {
      await page.locator('.goal-chip:has-text("A1p测试目标") .goal-remove').first().click();
      await sleep(2000);
      const goalsAfterRemove = await page.locator('.goal-chip:has-text("A1p测试目标")').count();
      record('移除 goal 后消失', goalsAfterRemove === 0, '');
    }
  }

  console.log('\n=== POV 下拉 ===');
  const povSelect = page.locator('.pov-select').first();
  record('POV 下拉存在', await povSelect.count() > 0, '');

  if (await povSelect.count() > 0) {
    const options = await povSelect.locator('option').allTextContents();
    record('POV 下拉含"无"选项', options.some(o => o.includes('无') || o.includes('上帝')), `选项数=${options.length}`);
    // 灰域行者有 2+ 已注册实体，POV 应有实体选项
    record('POV 下拉含已注册实体', options.length >= 2, `选项=[${options.join(',')}]`);
  }

  console.log('\n=== 折叠/展开信息条 ===');
  await page.locator('.info-bar-head button').first().click();
  await sleep(400);
  const bodyHidden = await page.locator('.info-bar-body').count();
  record('折叠后信息条主体隐藏', bodyHidden === 0, `残留=${bodyHidden}`);
  await page.locator('.info-bar-head button').first().click();
  await sleep(400);
  const bodyShown = await page.locator('.info-bar-body').count();
  record('展开后信息条主体显示', bodyShown > 0, '');

  console.log('\n=== 运行时错误 ===');
  const realErrors = pageErrors.filter(e => !e.includes('favicon'));
  record('无未捕获异常', realErrors.length === 0, realErrors.length ? realErrors[0] : '');

} catch (err) {
  record('脚本执行', false, err.message);
} finally {
  await browser.close();
}
console.log('\n========== 迭代A1\' 章节信息条验证汇总 ==========');
const p = results.filter(r => r.pass).length;
const f = results.filter(r => !r.pass).length;
console.log(`通过: ${p}  失败: ${f}  总计: ${results.length}`);
if (f > 0) results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
process.exit(f > 0 ? 1 : 0);
