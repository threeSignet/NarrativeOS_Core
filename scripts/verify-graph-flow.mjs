// entity-graph 剩余验证:新建关系流程 + 搜索高亮 + 空白平移 + 拖拽节点
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
  await page.locator('[data-tip="实体关系"]').first().click();
  await sleep(2500);

  console.log('=== 搜索高亮 ===');
  // 输入搜索词,图谱节点应出现 matched 高亮
  const searchInput = page.locator('.ui-search input, input[placeholder*="搜索"]').first();
  const nodeBefore = await page.locator('.node').first().getAttribute('class');
  await searchInput.fill('沈笙');
  await sleep(800);
  const nodeAfter = await page.locator('.node').first().getAttribute('class');
  // matched 状态:搜索后匹配节点应有 is-matched class
  const hasMatched = await page.locator('.node.is-matched').count();
  record('搜索触发节点高亮', hasMatched > 0, `is-matched 节点数=${hasMatched}`);
  await searchInput.fill('');
  await sleep(500);

  console.log('\n=== 空白处拖拽平移 ===');
  const canvas = page.locator('.graph-canvas').first();
  if (await canvas.count() > 0) {
    const box = await canvas.boundingBox();
    // 记录节点拖拽前的 transform
    const transformBefore = await canvas.evaluate(el => el.style.transform || getComputedStyle(el).transform);
    // 在空白处(canvas 但非 node)按下拖拽
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5);
    await page.mouse.down();
    await sleep(150);
    await page.mouse.move(box.x + box.width * 0.7 - 80, box.y + box.height * 0.5, { steps: 5 });
    await sleep(200);
    await page.mouse.up();
    await sleep(500);
    const transformAfter = await canvas.evaluate(el => el.style.transform || getComputedStyle(el).transform);
    record('空白拖拽触发平移(translate 变化)', transformBefore !== transformAfter,
      `before=${transformBefore.slice(0,40)} after=${transformAfter.slice(0,40)}`);
  }

  console.log('\n=== 拖拽节点(节点跟随,松手不动)===');
  const firstNode = page.locator('.node').first();
  if (await firstNode.count() > 0) {
    const nodeBox = await firstNode.boundingBox();
    // 记录节点拖拽前位置(node 自己的 left/top,不是 canvas transform)
    const posBefore = await firstNode.evaluate(el => ({ left: el.style.left, top: el.style.top }));
    await firstNode.hover();
    await page.mouse.down();
    await sleep(150);
    await page.mouse.move(nodeBox.x + 100, nodeBox.y + 80, { steps: 5 });
    await sleep(300);
    await page.mouse.up();
    await sleep(500);
    const posAfter = await firstNode.evaluate(el => ({ left: el.style.left, top: el.style.top }));
    record('拖拽节点位置改变', posBefore.left !== posAfter.left || posBefore.top !== posAfter.top,
      `before=${posBefore.left},${posBefore.top} after=${posAfter.left},${posAfter.top}`);

    // 拖拽后等 500ms 再采样,验证不回弹(位置稳定)
    await sleep(600);
    const posFinal = await firstNode.evaluate(el => ({ left: el.style.left, top: el.style.top }));
    record('节点松手后不回弹(位置稳定)', posAfter.left === posFinal.left && posAfter.top === posFinal.top,
      `松手=${posAfter.left},${posAfter.top} 最终=${posFinal.left},${posFinal.top}`);
  }

  console.log('\n=== 新建关系流程 ===');
  // 已注册实体数(关系两端必须 registered)
  const registeredCount = await page.locator('.entity-row').evaluateAll(els => {
    // 通过 status-dot 颜色或行内文字判断。registered 的实体行
    return els.length;
  });
  // 点新建关系按钮
  const newRelBtn = page.locator('button[title="新建关系"]');
  if (await newRelBtn.count() > 0) {
    const isDisabled = await newRelBtn.first().isDisabled();
    record('新建关系按钮可用', !isDisabled, isDisabled ? '禁用(注册实体<2)' : '可用');

    if (!isDisabled) {
      await newRelBtn.first().click();
      await sleep(600);
      const relForm = await page.locator('.ui-inline-form').count();
      record('新建关系表单展开', relForm > 0, `表单数=${relForm}`);

      if (relForm > 0) {
        // 选源实体和目标实体(两个 select)
        const selects = await page.locator('.ui-inline-form select').all();
        record('关系表单有源/目标 select', selects.length >= 2, `select 数=${selects.length}`);

        if (selects.length >= 2) {
          // 选第一个选项(非空)
          await selects[0].selectOption({ index: 1 });
          await sleep(200);
          await selects[1].selectOption({ index: 2 }); // 选第二个,避免相同
          await sleep(200);
          // 点创建关系
          const createRelBtn = page.locator('.ui-inline-form button:has-text("创建关系")').first();
          if (await createRelBtn.count() > 0) {
            const decisionsBefore = await page.locator('.ui-panel-footer .decision-row').count();
            await createRelBtn.click();
            await sleep(2000);
            const decisionsAfter = await page.locator('.ui-panel-footer .decision-row').count();
            record('创建关系后待确认决策增加', decisionsAfter > decisionsBefore,
              `${decisionsBefore}→${decisionsAfter}`);

            // 确认关系
            if (decisionsAfter > 0) {
              const confirmBtn = page.locator('.ui-panel-footer button:has-text("确认")').first();
              await confirmBtn.click();
              await sleep(2500);
              const decisionsAfterConfirm = await page.locator('.ui-panel-footer .decision-row').count();
              record('确认关系后决策被 resolve', decisionsAfterConfirm < decisionsAfter,
                `${decisionsAfter}→${decisionsAfterConfirm}`);
            }
          }
        }
      }
    }
  }

} catch (err) {
  record('脚本执行', false, err.message + '\n' + err.stack);
} finally {
  await browser.close();
}
console.log('\n========== 图谱流程汇总 ==========');
const p = results.filter(r => r.pass).length;
const f = results.filter(r => !r.pass).length;
console.log(`通过: ${p}  失败: ${f}  总计: ${results.length}`);
if (f > 0) results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
process.exit(f > 0 ? 1 : 0);
