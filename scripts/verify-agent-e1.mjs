// 迭代 E1 验证——Agent 工具调用可见性
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

  console.log('=== 打开 Agent 面板 ===');
  // 点击标题栏 AI 按钮打开面板
  const aiBtn = page.locator('.title-bar .tool-btn:has-text("AI"), .title-bar button[title*="AI"]');
  const aiBtnAlt = page.locator('button[title*="AI 助手"], button[title*="打开 AI"]');
  const btnCount = await aiBtn.count();
  const altCount = await aiBtnAlt.count();
  record('AI 按钮存在', btnCount > 0 || altCount > 0, `btn=${btnCount} alt=${altCount}`);

  if (btnCount > 0) {
    await aiBtn.first().click();
  } else if (altCount > 0) {
    await aiBtnAlt.first().click();
  }
  await sleep(1000);

  const agentHead = await page.locator('.ui-side-head:has-text("AI 助手")').count();
  record('Agent 面板标题渲染', agentHead > 0, '');

  const textarea = await page.locator('.agent-textarea').count();
  record('输入框存在', textarea > 0, '');

  const sendBtn = await page.locator('button:has-text("发送")').count();
  record('发送按钮存在', sendBtn > 0, '');

  console.log('\n=== 发送消息触发工具调用 ===');
  await page.locator('.agent-textarea').fill('查询当前世界的实体列表');
  await sleep(300);
  await page.locator('button:has-text("发送")').click();
  // 等待 Agent 处理（工具调用 + LLM 响应）
  await sleep(15000);

  const msgCount = await page.locator('.msg').count();
  record('消息列表有内容', msgCount > 0, `消息数=${msgCount}`);

  const toolCalls = await page.locator('.tool-call-row').count();
  record('工具调用指示器出现', toolCalls > 0, `工具调用数=${toolCalls}`);

  if (toolCalls > 0) {
    const toolStatuses = await page.locator('.tool-status').allInnerTexts();
    const hasCompleted = toolStatuses.some(s => s.includes('完成'));
    record('工具调用有完成状态', hasCompleted, `状态=${toolStatuses.join(',')}`);
  } else {
    record('工具调用有完成状态', false, '无工具调用可检查');
  }

  console.log('\n=== 运行时错误 ===');
  const realErrors = pageErrors.filter(e => !e.includes('favicon'));
  record('无未捕获异常', realErrors.length === 0, realErrors.length ? realErrors[0] : '');

} catch (err) {
  record('脚本执行', false, err.message);
} finally {
  await browser.close();
}
console.log('\n========== 迭代E1 Agent工具调用可见性验证汇总 ==========');
const p = results.filter(r => r.pass).length;
const f = results.filter(r => !r.pass).length;
console.log(`通过: ${p}  失败: ${f}  总计: ${results.length}`);
if (f > 0) results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
process.exit(f > 0 ? 1 : 0);
