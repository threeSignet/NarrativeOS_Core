// Agent 完整流程验证:发消息 → 收流式回复 → 清空对话
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
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await sleep(2000);

  // 打开 Agent 面板
  for (const b of await page.locator('.titlebar button, .titlebar-right button').all()) {
    const t = await b.getAttribute('title') || '';
    if (t.includes('AI') || t.includes('助手')) { await b.click(); break; }
  }
  await sleep(1000);

  console.log('=== Agent 发消息 + 流式回复 ===');
  // 初始无消息
  const msgBefore = await page.locator('.msg').count();
  record('初始无消息', msgBefore === 0, `消息数=${msgBefore}`);

  // 输入并发送
  const textarea = page.locator('.agent-textarea').first();
  await textarea.fill('你好,请用一句话介绍你自己');
  await sleep(300);

  // 监听 SSE 请求
  let sseRequest = null;
  page.on('request', req => {
    if (req.url().includes('/agent/chat')) sseRequest = req.url();
  });

  // 点发送(或 Enter)
  const sendBtn = page.locator('button:has-text("发送")').first();
  await sendBtn.click();
  await sleep(1000);

  // 发送后应出现:用户消息 + 助手消息(流式中)
  const msgAfter1s = await page.locator('.msg').count();
  record('发送后出现消息', msgAfter1s >= 2, `消息数=${msgAfter1s}(应≥2:用户+助手)`);

  // 用户消息应包含发送的文字
  const userMsgText = await page.locator('.msg--user .msg-text').first().textContent().catch(() => '');
  record('用户消息记录发送内容', userMsgText.includes('你好'), `内容="${userMsgText}"`);

  // 流式状态:发送后应有 streaming 光标或生成中提示
  const hasStreaming = await page.locator('.msg-cursor, .agent-status:has-text("生成中")').count();
  record('进入流式生成状态', hasStreaming > 0, `流式标记=${hasStreaming}`);

  // 等待流式回复完成(最多 30 秒)
  console.log('  等待流式回复(最多 30s)...');
  let replyText = '';
  let streamingDone = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const assistantMsg = await page.locator('.msg--assistant .msg-md, .msg--assistant .msg-text').last().textContent().catch(() => '');
    const stillStreaming = await page.locator('.msg-cursor').count();
    if (assistantMsg && assistantMsg.length > 5) replyText = assistantMsg;
    if (stillStreaming === 0 && replyText.length > 5) { streamingDone = true; break; }
  }

  record('收到流式回复内容', replyText.length > 5, `回复长度=${replyText.length}, 内容="${replyText.slice(0, 60)}..."`);
  record('流式生成正常结束', streamingDone, streamingDone ? '光标消失+有内容' : '超时未结束');
  record('SSE 端点被调用', sseRequest !== null, sseRequest || '未捕获请求');

  console.log('\n=== Agent 清空对话 ===');
  const msgCountBeforeClear = await page.locator('.msg').count();
  // 点垃圾桶按钮(清空对话)
  const clearBtn = page.locator('button[title="清空对话"]').first();
  if (await clearBtn.count() > 0) {
    await clearBtn.click();
    await sleep(800);
    const msgCountAfterClear = await page.locator('.msg').count();
    record('清空对话后消息清空', msgCountAfterClear === 0, `清空前=${msgCountBeforeClear} 清空后=${msgCountAfterClear}`);

    // 清空后应回到空状态
    const emptyState = await page.locator('.ui-empty:has-text("和 AI 助手对话"), .ui-empty-title:has-text("和 AI 助手")').count();
    record('清空后显示空状态', emptyState > 0, '');
  } else {
    record('清空对话按钮存在', false, '找不到垃圾桶按钮');
  }

} catch (err) {
  record('脚本执行', false, err.message);
} finally {
  await browser.close();
}

console.log('\n========== Agent 流程汇总 ==========');
const p = results.filter(r => r.pass).length;
const f = results.filter(r => !r.pass).length;
console.log(`通过: ${p}  失败: ${f}  总计: ${results.length}`);
if (f > 0) results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
process.exit(f > 0 ? 1 : 0);
