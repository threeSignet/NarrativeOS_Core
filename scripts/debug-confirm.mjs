import { chromium } from 'playwright-core';
const URL = 'http://localhost:5173/';
const EXECUTABLE = 'C:\\Users\\10652\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('response', async res => {
  if (res.url().includes('/decisions/') || res.url().includes('/relations/')) {
    const body = await res.text().catch(() => '');
    console.log(`[${res.request().method()} ${res.status()}] ${res.url()}`);
    console.log(`  响应: ${body.slice(0, 400)}`);
  }
});
page.on('console', msg => { if (msg.type() === 'error') console.log(`[CONSOLE] ${msg.text()}`); });

await page.goto(URL, { waitUntil: 'networkidle' });
await sleep(2000);
await page.locator('[data-tip="实体关系"]').first().click();
await sleep(2500);

// 列出所有待确认决策
const decisions = await page.locator('.ui-panel-footer .decision-row').allTextContents();
console.log('当前待确认决策:');
decisions.forEach((d, i) => console.log(`  [${i}] ${d}`));

// 点第一个确认
if (decisions.length > 0) {
  console.log('\n--- 点击第一个确认 ---');
  await page.locator('.ui-panel-footer button:has-text("确认")').first().click();
  await sleep(3000);
  const decisionsAfter = await page.locator('.ui-panel-footer .decision-row').allTextContents();
  console.log('\n确认后待确认决策:');
  decisionsAfter.forEach((d, i) => console.log(`  [${i}] ${d}`));
}
await browser.close();
