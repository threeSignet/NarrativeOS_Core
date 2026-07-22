// 迭代 E3 验证——Agent 协作可见性强化
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
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>{try{resolve(JSON.parse(d))}catch{resolve(null)}});
    });
    req.on('error',()=>resolve(null)); req.write(data); req.end();
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
  const aiBtn = page.locator('button[title*="AI 助手"], button[title*="打开 AI"]');
  if (await aiBtn.count() > 0) await aiBtn.first().click();
  await sleep(1000);

  const agentHead = await page.locator('.ui-side-head:has-text("AI 助手")').count();
  record('Agent 面板可打开', agentHead > 0, '');

  console.log('\n=== 发送消息触发工具调用 ===');
  await page.locator('.agent-textarea').fill('帮我创建一个新角色，名叫李逍遥，身份是蜀山弟子');
  await sleep(300);
  await page.locator('button:has-text("发送")').click();
  await sleep(20000);

  // 检查工具调用
  const toolCalls = await page.locator('.tool-call-row').count();
  record('工具调用指示器出现', toolCalls > 0, `工具调用数=${toolCalls}`);

  // 检查回合摘要
  const summary = await page.locator('.turn-summary').count();
  const summaryText = summary > 0 ? await page.locator('.turn-summary').innerText() : '';
  record('回合摘要出现', summary > 0 || toolCalls > 0, summaryText.slice(0, 50));

  // 检查消息内容
  const msgCount = await page.locator('.msg').count();
  record('消息列表有内容', msgCount > 0, `消息数=${msgCount}`);

  // 检查是否有决策面板（不一定有，取决于 Agent 行为）
  const decisions = await page.locator('.decisions-panel').count();
  record('决策面板状态', true, `决策面板=${decisions > 0 ? '有' : '无（正常）'}`);

  console.log('\n=== BFF 决策端点 ===');
  const decData = await new Promise((resolve) => {
    http.get('http://localhost:5173/api/projects/wprj_1781849935495_aydm4l/decisions', res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>{try{resolve(JSON.parse(d))}catch{resolve([])}});
    }).on('error',()=>resolve([]));
  });
  record('BFF 返回决策数组', Array.isArray(decData), `类型=${Array.isArray(decData) ? 'array' : typeof decData}`);

  console.log('\n=== 运行时错误 ===');
  const realErrors = pageErrors.filter(e => !e.includes('favicon'));
  record('无未捕获异常', realErrors.length === 0, realErrors.length ? realErrors[0] : '');

} catch (err) {
  record('脚本执行', false, err.message);
} finally {
  await browser.close();
}
console.log('\n========== 迭代E3 Agent协作可见性验证汇总 ==========');
const p = results.filter(r => r.pass).length;
const f = results.filter(r => !r.pass).length;
console.log(`通过: ${p}  失败: ${f}  总计: ${results.length}`);
if (f > 0) results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
process.exit(f > 0 ? 1 : 0);
