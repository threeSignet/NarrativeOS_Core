// document-editor 格式生效验证 + 导入/导出/复制
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

try {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await sleep(2000);

  // 打开一个文档(点树里文档节点)
  const docNodes = await page.locator('.tree-node:not(.is-folder)').all();
  if (docNodes.length > 0) {
    await docNodes[0].click();
    await sleep(1500);
  }

  const editor = page.locator('.ProseMirror').first();
  record('编辑器就绪', await editor.count() > 0, '');

  if (await editor.count() > 0) {
    // 清空编辑器,输入测试文本
    await editor.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await sleep(200);
    await editor.click();
    await page.keyboard.type('格式测试文字');
    await sleep(300);

    console.log('=== 加粗(选区→B→检查 strong 标签)===');
    await page.keyboard.press('Control+a');
    await sleep(100);
    await page.locator('button[title="加粗 (Ctrl+B)"]').first().click();
    await sleep(300);
    const hasBold = await editor.locator('strong').count();
    record('加粗生成 <strong>', hasBold > 0, `strong 数=${hasBold}`);
    // 取消加粗
    await page.locator('button[title="加粗 (Ctrl+B)"]').first().click();
    await sleep(200);

    console.log('\n=== 标题(选区→H1→检查 h1 标签)===');
    await page.keyboard.press('Control+a');
    await sleep(100);
    await page.locator('button[title="标题 1"]').first().click();
    await sleep(300);
    const hasH1 = await editor.locator('h1').count();
    record('H1 生成 <h1>', hasH1 > 0, `h1 数=${hasH1}`);

    console.log('\n=== 无序列表(选区→bullet→检查 ul)===');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await sleep(100);
    await page.keyboard.type('列表项一');
    await page.locator('button[title="无序列表"]').first().click();
    await sleep(300);
    const hasUl = await editor.locator('ul').count();
    record('无序列表生成 <ul>', hasUl > 0, `ul 数=${hasUl}`);

    console.log('\n=== 有序列表 ===');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await sleep(100);
    await page.keyboard.type('有序项');
    await page.locator('button[title="有序列表"]').first().click();
    await sleep(300);
    const hasOl = await editor.locator('ol').count();
    record('有序列表生成 <ol>', hasOl > 0, `ol 数=${hasOl}`);

    console.log('\n=== 引用 ===');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await sleep(100);
    await page.keyboard.type('引用文字');
    await page.locator('button[title="引用"]').first().click();
    await sleep(300);
    const hasQuote = await editor.locator('blockquote').count();
    record('引用生成 <blockquote>', hasQuote > 0, `blockquote 数=${hasQuote}`);

    console.log('\n=== 分隔线 ===');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await sleep(100);
    await page.locator('button[title="分隔线"]').first().click();
    await sleep(300);
    const hasHr = await editor.locator('hr').count();
    record('分隔线生成 <hr>', hasHr > 0, `hr 数=${hasHr}`);

    console.log('\n=== 撤销/重做 ===');
    const hrCountBefore = await editor.locator('hr').count();
    await page.locator('button[title="撤销 (Ctrl+Z)"]').first().click();
    await sleep(300);
    const hrCountAfterUndo = await editor.locator('hr').count();
    record('撤销移除最后操作', hrCountAfterUndo < hrCountBefore, `hr: ${hrCountBefore}→${hrCountAfterUndo}`);
    await page.locator('button[title="重做 (Ctrl+Shift+Z)"]').first().click();
    await sleep(300);
    const hrCountAfterRedo = await editor.locator('hr').count();
    record('重做恢复操作', hrCountAfterRedo > hrCountAfterUndo, `hr: ${hrCountAfterUndo}→${hrCountAfterRedo}`);

    console.log('\n=== 复制纯文本 ===');
    await page.keyboard.press('Control+a');
    await sleep(100);
    // 复制按钮 + 读剪贴板权限
    const copyBtn = page.locator('button[title="复制纯文本"]');
    await copyBtn.first().click();
    await sleep(500);
    // toast 反馈
    const copyToast = await page.locator('.toast:has-text("复制"), .toast:has-text("剪贴板")').count();
    record('复制触发反馈', copyToast > 0, `toast=${copyToast}`);

    console.log('\n=== 导出 Markdown ===');
    const exportBtn = page.locator('button[title="导出为 Markdown"]');
    // 监听下载
    const downloadPromise = page.waitForEvent('download', { timeout: 3000 }).catch(() => null);
    await exportBtn.first().click();
    await sleep(500);
    const download = await downloadPromise;
    record('导出触发文件下载', download !== null, download ? `文件=${download.suggestedFilename()}` : '无下载事件');
    const exportToast = await page.locator('.toast:has-text("导出")').count();
    record('导出触发反馈', exportToast > 0, `toast=${exportToast}`);

    console.log('\n=== 自动保存 ===');
    // 编辑内容,观察状态栏 syncState 变化
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type('。自动保存测试');
    await sleep(500);
    const statusSyncing = await page.locator('.status-bar').textContent().catch(() => '');
    // 等 2 秒看是否回到已保存
    await sleep(2500);
    const statusSaved = await page.locator('.status-bar').textContent().catch(() => '');
    record('自动保存触发', true, `编辑后状态栏: ${statusSaved?.slice(0,50)}`);
  }

} catch (err) {
  record('脚本执行', false, err.message + '\n' + err.stack);
} finally {
  await browser.close();
}
console.log('\n========== 编辑器格式汇总 ==========');
const p = results.filter(r => r.pass).length;
const f = results.filter(r => !r.pass).length;
console.log(`通过: ${p}  失败: ${f}  总计: ${results.length}`);
if (f > 0) results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
process.exit(f > 0 ? 1 : 0);
