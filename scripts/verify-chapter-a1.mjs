// 迭代 A1 验证——章节规划 CRUD 全流程
import { chromium } from 'playwright-core';
import { existsSync } from 'fs';
const URL = 'http://localhost:5173/';
const EXECUTABLE = 'C:\\Users\\10652\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));

try {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await sleep(2000);

  console.log('=== 切到章节活动栏 ===');
  await page.locator('[data-tip="章节"]').first().click();
  await sleep(1500);

  // 章节侧栏标题
  const sideHead = await page.locator('.ui-side-head:has-text("章节")').count();
  record('章节侧栏标题渲染', sideHead > 0, '');

  // 初始章节数(可能已有测试残留，验证增量行为而非绝对空状态)
  const initialCount = await page.locator('.chapter-row').count();
  console.log(`  初始已有 ${initialCount} 章节(测试残留)`);

  console.log('\n=== 新建章节 ===');
  await page.locator('button[title="新建章节"]').first().click();
  await sleep(500);
  const formVisible = await page.locator('.ui-inline-form').count();
  record('点击+后内联表单展开', formVisible > 0, '');

  if (formVisible > 0) {
    await page.locator('.ui-inline-form input').first().fill('迭代A1测试章节');
    await sleep(200);
    await page.locator('.ui-inline-form button:has-text("创建")').first().click();
    await sleep(1500);

    const chapterRows = await page.locator('.chapter-row').count();
    record('创建后章节行增加', chapterRows > initialCount, `创建前=${initialCount} 创建后=${chapterRows}`);

    const hasNew = await page.locator('.chapter-row:has-text("迭代A1测试章节")').count();
    record('新章节在列表可见', hasNew > 0, '');

    // 新建章节应在末尾，序号 = initialCount + 1
    const lastLabel = await page.locator('.chapter-label').last().textContent();
    const expectedNum = initialCount + 1;
    record('新章节序号正确', lastLabel?.includes(`第 ${expectedNum} 章`), `末尾 label="${lastLabel}" 期望含"第 ${expectedNum} 章"`);
  }

  console.log('\n=== 再建一章(验证 order 自动递增)===');
  const countBeforeSecond = await page.locator('.chapter-row').count();
  await page.locator('button[title="新建章节"]').first().click();
  await sleep(400);
  await page.locator('.ui-inline-form input').first().fill('第二章测试');
  await sleep(200);
  await page.locator('.ui-inline-form button:has-text("创建")').first().click();
  await sleep(1500);
  const rowCount = await page.locator('.chapter-row').count();
  record('再建一章后数量增加', rowCount === countBeforeSecond + 1, `建前=${countBeforeSecond} 建后=${rowCount}`);
  if (rowCount >= 2) {
    const label2 = await page.locator('.chapter-label').last().textContent();
    const expected2 = countBeforeSecond + 1;
    record('新章节序号递增', label2?.includes(`第 ${expected2} 章`), `末尾 label="${label2}"`);
  }

  console.log('\n=== 双击重命名 ===');
  const firstRow = page.locator('.chapter-row').first();
  await firstRow.dblclick();
  await sleep(500);
  const renameInputVisible = await page.locator('.rename-input').count();
  record('双击触发重命名输入框', renameInputVisible > 0, '');
  if (renameInputVisible > 0) {
    await page.locator('.rename-input').first().fill('重命名后的章节');
    await sleep(200);
    await page.locator('.rename-input').first().press('Enter');
    await sleep(1200);
    const renamed = await page.locator('.chapter-row:has-text("重命名后的章节")').count();
    record('重命名提交后新名出现', renamed > 0, '');
  }

  console.log('\n=== 状态推进(planned → drafting)===');
  // 点第一个章节的状态推进按钮
  const advanceBtn = page.locator('.chapter-row').first().locator('button:has-text("计划中")');
  if (await advanceBtn.count() > 0) {
    const textBefore = await advanceBtn.first().textContent();
    await advanceBtn.first().click();
    await sleep(1500);
    // 验证状态变了
    const statusBtnAfter = page.locator('.chapter-row').first().locator('button, .done-mark');
    const textAfter = await statusBtnAfter.first().textContent();
    record('状态推进后标签变化', textBefore !== textAfter, `${textBefore} → ${textAfter}`);
  } else {
    // 可能第一个章节已不是 planned,找任意有推进按钮的
    const anyAdvance = page.locator('.chapter-row button:has-text("→")');
    record('状态推进按钮存在', await anyAdvance.count() > 0, '');
  }

  console.log('\n=== 点击选中章节 ===');
  await page.locator('.chapter-row').first().click();
  await sleep(300);
  const selected = await page.locator('.chapter-row.is-selected').count();
  record('点击章节后选中态生效', selected > 0, '');

  console.log('\n=== 运行时错误 ===');
  const realErrors = pageErrors.filter(e => !e.includes('favicon'));
  record('无未捕获异常', realErrors.length === 0, realErrors.length ? realErrors[0] : '');

} catch (err) {
  record('脚本执行', false, err.message);
} finally {
  await browser.close();
}
console.log('\n========== 迭代A1 章节验证汇总 ==========');
const p = results.filter(r => r.pass).length;
const f = results.filter(r => !r.pass).length;
console.log(`通过: ${p}  失败: ${f}  总计: ${results.length}`);
if (f > 0) results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
process.exit(f > 0 ? 1 : 0);
