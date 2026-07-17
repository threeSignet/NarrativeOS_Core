// 迭代 C2 验证——时间线只读视图
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
  await page.locator('[data-tip="时间线"]').first().click();
  await sleep(2000);

  console.log('=== 时间线渲染 ===');
  const sideHead = await page.locator('.ui-side-head:has-text("时间线")').count();
  record('时间线侧栏标题渲染', sideHead > 0, '');

  // 模式切换存在
  const modeChips = await page.locator('.mode-switch .ui-chip').count();
  record('模式切换芯片存在(世界/叙述)', modeChips >= 2, `芯片数=${modeChips}`);

  // 来源层过滤存在
  const layerChips = await page.locator('.filter-chips .ui-chip').count();
  record('来源层过滤芯片存在', layerChips > 0, `芯片数=${layerChips}`);

  console.log('\n=== 时间轴主区渲染 ===');
  // 应有时间线条目(灰域行者有13条committed + planned章节)
  const timelineItems = await page.locator('.timeline-item').count();
  record('时间线条目渲染', timelineItems > 0, `条目数=${timelineItems}`);

  // 按章节分组
  const chapterGroups = await page.locator('.chapter-group').count();
  record('按章节分组渲染', chapterGroups > 0, `章节数=${chapterGroups}`);

  // 章节标记显示"第 N 章"
  const chapterLabel = await page.locator('.chapter-label').first().textContent();
  record('章节标记含"第 N 章"', !!chapterLabel && chapterLabel.includes('章'), `label="${chapterLabel}"`);

  // 来源层标签(committed=已提交)
  const layerTags = await page.locator('.layer-tag').allTextContents();
  const hasCommitted = layerTags.some(t => t.includes('已提交'));
  record('条目显示来源层标签(已提交)', hasCommitted, `标签样本=[${layerTags.slice(0,3).join(',')}]`);

  console.log('\n=== 模式切换(世界→叙述)===');
  await page.locator('.mode-switch .ui-chip:has-text("叙述顺序")').first().click();
  await sleep(2000);
  const itemsAfterSwitch = await page.locator('.timeline-item').count();
  record('模式切换后重新加载', itemsAfterSwitch > 0, `切换后条目=${itemsAfterSwitch}`);

  console.log('\n=== 来源层过滤 ===');
  const itemsBeforeFilter = await page.locator('.timeline-item').count();
  // 点掉"已提交"层
  await page.locator('.filter-chips .ui-chip:has-text("已提交")').first().click();
  await sleep(500);
  const itemsAfterFilter = await page.locator('.timeline-item').count();
  record('隐藏已提交层后条目减少', itemsAfterFilter < itemsBeforeFilter, `${itemsBeforeFilter}→${itemsAfterFilter}`);
  // 恢复
  await page.locator('.filter-chips .ui-chip:has-text("已提交")').first().click();
  await sleep(300);

  console.log('\n=== 运行时错误 ===');
  const realErrors = pageErrors.filter(e => !e.includes('favicon'));
  record('无未捕获异常', realErrors.length === 0, realErrors.length ? realErrors[0] : '');

} catch (err) {
  record('脚本执行', false, err.message);
} finally {
  await browser.close();
}
console.log('\n========== 迭代C2 时间线验证汇总 ==========');
const p = results.filter(r => r.pass).length;
const f = results.filter(r => !r.pass).length;
console.log(`通过: ${p}  失败: ${f}  总计: ${results.length}`);
if (f > 0) results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
process.exit(f > 0 ? 1 : 0);
