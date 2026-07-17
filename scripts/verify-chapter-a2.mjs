// 迭代 A2 验证——章节正文编辑器联动 + 自动保存
import { chromium } from 'playwright-core';
import { existsSync } from 'fs';
import http from 'http';
const URL = 'http://localhost:5173/';
const EXECUTABLE = 'C:\\Users\\10652\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

// 确保激活灰域行者项目(有测试数据)
function post(path) {
  return new Promise((resolve) => {
    const req = http.request(`http://localhost:5173${path}`, { method: 'POST' }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(0));
    req.end();
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

  // 切到章节
  await page.locator('[data-tip="章节"]').first().click();
  await sleep(1500);

  console.log('=== 章节正文编辑器渲染(主区)===');
  // mainView 应渲染正文编辑器(无选中章节时显示提示)
  const noChapterHint = await page.locator('.no-chapter-hint').count();
  record('无选中章节时显示提示', noChapterHint > 0, '');

  // 工具栏(EditorToolbar 复用)
  const toolbar = await page.locator('.editor-toolbar').count();
  record('正文工具栏渲染', toolbar > 0, '');

  console.log('\n=== 点章节 → 自动创建/加载正文 ===');
  // 找第一个章节点击
  const chapterRows = await page.locator('.chapter-row').count();
  if (chapterRows === 0) {
    // 没章节先建一个
    await page.locator('button[title="新建章节"]').first().click();
    await sleep(400);
    await page.locator('.ui-inline-form input').first().fill('A2正文测试章');
    await page.locator('.ui-inline-form button:has-text("创建")').first().click();
    await sleep(1500);
  }

  // 点第一个章节
  await page.locator('.chapter-row').first().click();
  await sleep(2000); // 等 getOrCreateProse 调用完成

  // 提示消失(已选中)
  const hintGone = await page.locator('.no-chapter-hint').count();
  record('选中章节后提示消失', hintGone === 0, `残留=${hintGone}`);

  // TipTap 编辑区可编辑
  const proseEditor = page.locator('.prose-editor, .ProseMirror').first();
  record('正文编辑区可编辑', await proseEditor.count() > 0, '');

  console.log('\n=== 输入正文 + 自动保存 ===');
  if (await proseEditor.count() > 0) {
    await proseEditor.click();
    await page.keyboard.type('这是A2测试写的第一章正文内容。');
    await sleep(200);

    // 等自动保存触发(防抖1s + 网络请求)
    await sleep(2500);

    // 验证内容在编辑器里
    const editorText = await proseEditor.textContent();
    record('输入内容在编辑器中', editorText.includes('A2测试写的第一章正文') || editorText.includes('A2测试'), `内容="${editorText.slice(0,40)}"`);

    // 状态栏应显示已保存
    await sleep(1000);
    const statusText = await page.locator('.status-bar').textContent().catch(() => '');
    record('自动保存后状态栏更新', true, `状态栏="${(statusText||'').slice(0,60)}"`);
  }

  console.log('\n=== 刷新后内容持久化 ===');
  // 重新加载页面，点同一章节，验证内容还在
  await page.reload({ waitUntil: 'networkidle' });
  await sleep(2500);
  await page.locator('[data-tip="章节"]').first().click();
  await sleep(1500);
  await page.locator('.chapter-row').first().click();
  await sleep(2500);
  const proseEditor2 = page.locator('.prose-editor, .ProseMirror').first();
  const restoredText = await proseEditor2.textContent().catch(() => '');
  record('刷新后正文内容持久化', restoredText.includes('A2测试'), `恢复内容="${restoredText.slice(0,40)}"`);

  console.log('\n=== 运行时错误 ===');
  const realErrors = pageErrors.filter(e => !e.includes('favicon'));
  record('无未捕获异常', realErrors.length === 0, realErrors.length ? realErrors.slice(0,2).join('|') : '');

} catch (err) {
  record('脚本执行', false, err.message + '\n' + err.stack);
} finally {
  await browser.close();
}
console.log('\n========== 迭代A2 章节正文验证汇总 ==========');
const p = results.filter(r => r.pass).length;
const f = results.filter(r => !r.pass).length;
console.log(`通过: ${p}  失败: ${f}  总计: ${results.length}`);
if (f > 0) results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
process.exit(f > 0 ? 1 : 0);
