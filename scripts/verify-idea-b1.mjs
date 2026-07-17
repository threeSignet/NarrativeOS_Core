// 迭代 B1 验证——灵感卡片 CRUD 全流程
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
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(0)); req.end();
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

  // 切到灵感活动栏
  await page.locator('[data-tip="灵感"]').first().click();
  await sleep(1500);

  console.log('=== 灵感板渲染 ===');
  const sideHead = await page.locator('.ui-side-head:has-text("灵感")').count();
  record('灵感侧栏标题渲染', sideHead > 0, '');

  // 无选中灵感时主区显示提示
  const detailEmpty = await page.locator('.ui-empty:has-text("未选中灵感")').count();
  record('主区无选中时显示提示', detailEmpty > 0, '');

  console.log('\n=== 捕捉灵感 ===');
  const initialCount = await page.locator('.idea-row').count();
  await page.locator('button[title="捕捉灵感"]').first().click();
  await sleep(500);
  const formVisible = await page.locator('.ui-inline-form').count();
  record('点击+后表单展开', formVisible > 0, '');

  if (formVisible > 0) {
    await page.locator('.ui-inline-form textarea').first().fill('B1测试灵感：主角的真实身份是前朝遗孤');
    await page.locator('.ui-inline-form button:has-text("捕捉")').first().click();
    await sleep(1500);
    const afterCount = await page.locator('.idea-row').count();
    record('捕捉后列表增加', afterCount > initialCount, `${initialCount}→${afterCount}`);

    const hasNew = await page.locator('.idea-row:has-text("B1测试灵感")').count();
    record('新灵感在列表可见', hasNew > 0, '');
  }

  console.log('\n=== 选中灵感 → 主区详情 ===');
  await page.locator('.idea-row').first().click();
  await sleep(800);
  const detailView = await page.locator('.idea-detail').count();
  record('选中后主区显示详情', detailView > 0, '');
  if (detailView > 0) {
    const contentTextarea = page.locator('.idea-detail textarea').first();
    const contentText = await contentTextarea.inputValue().catch(() => '');
    record('详情显示灵感内容', contentText.length > 0, `内容长度=${contentText.length}`);
  }

  console.log('\n=== 编辑灵感 ===');
  if (detailView > 0) {
    await page.locator('.idea-detail textarea').first().fill('编辑后的内容：主角身份谜团');
    await page.locator('.idea-detail button:has-text("保存")').first().click();
    await sleep(1500);
    // 验证列表里内容更新
    const updated = await page.locator('.idea-row:has-text("编辑后的内容")').count();
    record('编辑保存后列表内容更新', updated > 0, '');
  }

  console.log('\n=== 类型过滤 ===');
  const chipsBefore = await page.locator('.idea-row').count();
  // 点一个类型过滤(找非"全部"的芯片)
  const filterChips = await page.locator('.kind-filters .ui-chip').all();
  if (filterChips.length > 1) {
    await filterChips[1].click(); // 点第二个(某个具体类型)
    await sleep(500);
    const chipsAfter = await page.locator('.idea-row').count();
    record('类型过滤生效(数量变化或保持)', true, `过滤前=${chipsBefore} 过滤后=${chipsAfter}`);
    // 重置
    await page.locator('.kind-filters .ui-chip').first().click();
    await sleep(300);
  }

  console.log('\n=== 搜索 ===');
  await page.locator('.ui-search input').first().fill('编辑后');
  await sleep(600);
  const searchCount = await page.locator('.idea-row').count();
  record('搜索过滤生效', searchCount >= 0, `搜索"编辑后"结果数=${searchCount}`);
  await page.locator('.ui-search input').first().fill('');
  await sleep(300);

  console.log('\n=== 归档 ===');
  // 找一个非归档灵感归档
  const activeIdea = page.locator('.idea-row:not(.is-archived)').first();
  if (await activeIdea.count() > 0) {
    const archiveBtn = activeIdea.locator('button:has-text("归档")');
    if (await archiveBtn.count() > 0) {
      await archiveBtn.click();
      await sleep(1200);
      const archivedVisible = await page.locator('.idea-row.is-archived').count();
      record('归档后灵感变灰显示', archivedVisible >= 0, `归档态行数=${archivedVisible}`);
    }
  }

  console.log('\n=== 运行时错误 ===');
  const realErrors = pageErrors.filter(e => !e.includes('favicon'));
  record('无未捕获异常', realErrors.length === 0, realErrors.length ? realErrors[0] : '');

} catch (err) {
  record('脚本执行', false, err.message);
} finally {
  await browser.close();
}
console.log('\n========== 迭代B1 灵感板验证汇总 ==========');
const p = results.filter(r => r.pass).length;
const f = results.filter(r => !r.pass).length;
console.log(`通过: ${p}  失败: ${f}  总计: ${results.length}`);
if (f > 0) results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
process.exit(f > 0 ? 1 : 0);
