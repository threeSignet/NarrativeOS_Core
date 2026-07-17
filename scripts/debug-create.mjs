// 调试:抓取新建实体请求与响应
import { chromium } from 'playwright-core';
import { existsSync } from 'fs';
const URL = 'http://localhost:5173/';
const EXECUTABLE = 'C:\\Users\\10652\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// 抓 network
const apiCalls = [];
page.on('request', req => {
  if (req.url().includes('/api/') && req.method() === 'POST') {
    apiCalls.push({ method: req.method(), url: req.url(), body: req.postData() });
  }
});
page.on('response', async res => {
  if (res.url().includes('/api/') && res.request().method() === 'POST') {
    try {
      const body = await res.text();
      console.log(`[POST ${res.status()}] ${res.url()}`);
      console.log(`  响应: ${body.slice(0, 300)}`);
    } catch {}
  }
});
page.on('console', msg => {
  if (msg.type() === 'error' || msg.type() === 'warning') {
    console.log(`[CONSOLE ${msg.type()}] ${msg.text()}`);
  }
});
page.on('pageerror', err => console.log(`[PAGEERROR] ${err.message}`));

await page.goto(URL, { waitUntil: 'networkidle' });
await sleep(2000);
await page.locator('[data-tip="实体关系"]').first().click();
await sleep(2000);

// 打开表单
await page.locator('button[title="新建实体"]').first().click();
await sleep(500);

// 填名
await page.locator('.ui-inline-form input').first().fill('调试测试角色');
await sleep(300);

// 打印表单里所有按钮
const formBtns = await page.locator('.ui-inline-form button').allTextContents();
console.log('表单按钮:', formBtns);

// 点创建
console.log('\n--- 点击创建按钮 ---');
await page.locator('.ui-inline-form button:has-text("创建")').first().click();
await sleep(2000);

console.log('\n--- API 调用记录 ---');
apiCalls.forEach(c => console.log(`${c.method} ${c.url}\n  body: ${c.body}`));

const finalCount = await page.locator('.entity-row').count();
console.log(`\n最终实体数: ${finalCount}`);

// 检查表单是否还在(没关闭=可能报错了)
const formStillOpen = await page.locator('.ui-inline-form').count();
console.log(`表单是否还开着: ${formStillOpen > 0}`);

await browser.close();
