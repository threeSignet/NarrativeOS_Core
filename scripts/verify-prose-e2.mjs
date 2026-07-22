// 迭代 E2 验证——Agent 写正文通道
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
function get(path) {
  return new Promise((resolve) => {
    http.get(`http://localhost:5173${path}`, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>{try{resolve(JSON.parse(d))}catch{resolve(null)}});
    }).on('error',()=>resolve(null));
  });
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

  console.log('=== BFF 端点验证 ===');
  // 列出正文文档
  const docs = await get('/api/projects/wprj_1781849935495_aydm4l/prose');
  record('BFF 列出正文文档', Array.isArray(docs), `类型=${Array.isArray(docs) ? 'array' : typeof docs}`);

  // 追加块（模拟 Agent 写入）
  if (docs && docs.length > 0) {
    const docId = docs[0].id;
    const blockResult = await post(`/api/projects/wprj_1781849935495_aydm4l/prose/${docId}/blocks`, {
      kind: 'paragraph', text: '【E2 验证】这是一段由 Agent 追加的测试段落。',
    });
    record('BFF 追加块成功', blockResult && blockResult.id, `blockId=${blockResult?.id?.slice(0, 20)}`);

    // 验证块已写入
    const docDetail = await get(`/api/projects/wprj_1781849935495_aydm4l/prose/${docId}`);
    const hasBlock = docDetail?.blocks?.some(b => b.text.includes('E2 验证'));
    record('块已持久化到文档', hasBlock, `blocks=${docDetail?.blocks?.length ?? 0}`);
  } else {
    record('BFF 追加块成功', false, '无正文文档可写入');
    record('块已持久化到文档', false, '无正文文档');
  }

  console.log('\n=== Agent 面板工具标签 ===');
  // 打开 Agent 面板
  const aiBtn = page.locator('button[title*="AI 助手"], button[title*="打开 AI"]');
  if (await aiBtn.count() > 0) {
    await aiBtn.first().click();
    await sleep(1000);
  }
  const agentHead = await page.locator('.ui-side-head:has-text("AI 助手")').count();
  record('Agent 面板可打开', agentHead > 0, '');

  console.log('\n=== 运行时错误 ===');
  const realErrors = pageErrors.filter(e => !e.includes('favicon'));
  record('无未捕获异常', realErrors.length === 0, realErrors.length ? realErrors[0] : '');

} catch (err) {
  record('脚本执行', false, err.message);
} finally {
  await browser.close();
}
console.log('\n========== 迭代E2 Agent写正文通道验证汇总 ==========');
const p = results.filter(r => r.pass).length;
const f = results.filter(r => !r.pass).length;
console.log(`通过: ${p}  失败: ${f}  总计: ${results.length}`);
if (f > 0) results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
process.exit(f > 0 ? 1 : 0);
