// 深度交互验证——覆盖拖拽/悬停/创建流程/过滤切换等动态行为
import { chromium } from 'playwright-core';
import { existsSync } from 'fs';

const URL = 'http://localhost:5173/';
const CHROMIUM_PATHS = [
  'C:\\Users\\10652\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe',
  'C:\\Users\\10652\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1223\\chrome-headless-shell-win64\\chrome-headless-shell.exe',
];
const EXECUTABLE = CHROMIUM_PATHS.find(p => existsSync(p));

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  const mark = pass ? '✓' : '✗';
  console.log(`${mark} ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on('pageerror', err => consoleErrors.push(err.message));

  try {
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(2000);

    console.log('=== A. agent-panel 拖拽改宽 ===');
    // 先打开 Agent 面板
    const aiBtn = page.locator('.titlebar button').filter({ hasText: '' });
    const buttons = await page.locator('.titlebar button, .titlebar-right button').all();
    for (const b of buttons) {
      const title = await b.getAttribute('title') || '';
      if (title.includes('AI') || title.includes('助手')) { await b.click(); break; }
    }
    await sleep(800);
    const panelBefore = await page.locator('.panel').first().boundingBox();
    record('Agent 面板打开有宽度', panelBefore !== null && panelBefore.width > 0, panelBefore ? `宽=${Math.round(panelBefore.width)}` : '');

    // 拖拽 panel-resizer 改宽
    const resizer = page.locator('.panel-resizer');
    if (await resizer.count() > 0 && panelBefore) {
      const rBox = await resizer.first().boundingBox();
      const oldW = panelBefore.width;
      // 向左拖 50px(面板变宽)
      await page.mouse.move(rBox.x + rBox.width / 2, rBox.y + 50);
      await page.mouse.down();
      await page.mouse.move(rBox.x + rBox.width / 2 - 50, rBox.y + 50, { steps: 5 });
      await page.mouse.up();
      await sleep(500);
      const panelAfter = await page.locator('.panel').first().boundingBox();
      const widthChanged = panelAfter && Math.abs(panelAfter.width - oldW) > 20;
      record('Agent 面板拖拽改宽生效', widthChanged, `${Math.round(oldW)}→${Math.round(panelAfter?.width || 0)}`);
    } else {
      record('Agent 面板拖拽改宽生效', false, '找不到 resizer');
    }

    console.log('\n=== B. entity-graph 悬停高亮 ===');
    // 切到实体关系
    await page.locator('[data-tip="实体关系"], .activity-btn:has-text("实体关系")').first().click().catch(() => {});
    await sleep(2000);

    const nodes = await page.locator('.node:has(.node-avatar)').count();
    if (nodes >= 2) {
      // 记录悬停前所有节点的 opacity/dim 状态
      const beforeState = await page.locator('.node').evaluateAll(els =>
        els.map(e => window.getComputedStyle(e).opacity)
      );
      // 悬停第一个节点
      await page.locator('.node').first().hover();
      await sleep(400);
      const hoverNodeId = await page.locator('.node').first().evaluate((el) => el.className);
      // 验证 hoverNodeId 出现在某节点的 class 里(is-hover),且邻居外的节点 is-dimmed
      const afterState = await page.locator('.node').evaluateAll(els =>
        els.map(e => ({ opacity: window.getComputedStyle(e).opacity, classes: e.className }))
      );
      // 悬停后应有节点变成 is-hover 或 is-dimmed
      const hasHoverState = afterState.some(s => s.classes.includes('is-hover'));
      const hasDimmed = afterState.some(s => s.classes.includes('is-dimmed') || parseFloat(s.opacity) < 0.5);
      record('图谱悬停高亮生效', hasHoverState || hasDimmed, `hover态=${hasHoverState} dimmed态=${hasDimmed}`);

      // 移开鼠标,状态恢复
      await page.locator('.editor-toolbar, .main').first().hover().catch(() => {});
      await sleep(400);
    }

    console.log('\n=== C. entity-graph 来源层过滤切换 ===');
    const chipsBefore = await page.locator('.ui-chip').count();
    if (chipsBefore > 0) {
      const edgesBefore = await page.locator('.edge-label').count();
      // 点一个 candidate 芯片(切换隐藏)
      const candidateChip = page.locator('.ui-chip').filter({ hasText: '候选' });
      if (await candidateChip.count() > 0) {
        await candidateChip.first().click();
        await sleep(500);
        const edgesAfter = await page.locator('.edge-label').count();
        record('来源层过滤切换生效', edgesAfter !== edgesBefore, `切换前=${edgesBefore} 切换后=${edgesAfter} 边`);
        // 切回来
        await candidateChip.first().click();
        await sleep(300);
      } else {
        record('来源层过滤切换生效', false, '找不到候选芯片');
      }
    }

    console.log('\n=== D. entity-graph 缩放(滚轮) ===');
    const zoomBtn = page.locator('.zoom-ctl button').nth(1); // 中间显示百分比的重置按钮
    if (await zoomBtn.count() > 0) {
      const zoomTextBefore = await zoomBtn.textContent();
      // 点 + 放大
      const plusBtn = page.locator('.zoom-ctl button').first();
      await plusBtn.click();
      await sleep(300);
      const zoomTextAfter = await zoomBtn.textContent();
      const changed = zoomTextBefore !== zoomTextAfter;
      record('图谱缩放控件生效', changed, `${zoomTextBefore}→${zoomTextAfter}`);
    } else {
      record('图谱缩放控件生效', false, '找不到缩放按钮');
    }

    console.log('\n=== E. entity-graph 节点详情 popover ===');
    if (nodes > 0) {
      const popoverBefore = await page.locator('.node-popover').count();
      await page.locator('.node').first().click();
      await sleep(500);
      const popoverAfter = await page.locator('.node-popover').count();
      record('节点点击弹出详情 popover', popoverAfter > popoverBefore, `点击前=${popoverBefore} 点击后=${popoverAfter}`);
      // popover 内容
      if (popoverAfter > 0) {
        const popoverText = await page.locator('.node-popover').first().textContent();
        record('popover 含实体信息', popoverText.length > 10, `内容长度=${popoverText.length}`);
      }
    }

    console.log('\n=== F. document-explorer 新建文件夹流程 ===');
    // 切回文档
    await page.locator('[data-tip="文档"], .activity-btn:has-text("文档")').first().click().catch(() => {});
    await sleep(800);

    const newFolderBtn = page.locator('button[title="新建文件夹"]');
    if (await newFolderBtn.count() > 0) {
      const treeCountBefore = await page.locator('.tree-node').count();
      await newFolderBtn.first().click();
      await sleep(500);
      // 出现就地创建输入框
      const createInput = await page.locator('.create-input').count();
      record('新建文件夹触发就地输入框', createInput > 0, `输入框数=${createInput}`);
      if (createInput > 0) {
        await page.locator('.create-input').first().fill('自动化测试文件夹');
        await sleep(200);
        await page.locator('.create-input').first().press('Enter');
        await sleep(1000);
        const treeCountAfter = await page.locator('.tree-node').count();
        record('新建文件夹提交后树节点增加', treeCountAfter > treeCountBefore,
          `提交前=${treeCountBefore} 提交后=${treeCountAfter}`);
        // 验证新文件夹出现在树里
        const hasNewFolder = await page.locator('.tree-node', { hasText: '自动化测试文件夹' }).count();
        record('新文件夹出现在树中', hasNewFolder > 0, '');
      }
    }

    console.log('\n=== G. document-explorer 右键菜单 ===');
    const treeNode = page.locator('.tree-node').first();
    if (await treeNode.count() > 0) {
      const menuBefore = await page.locator('.ui-ctx-menu').count();
      await treeNode.click({ button: 'right' });
      await sleep(500);
      const menuAfter = await page.locator('.ui-ctx-menu').count();
      record('右键弹出上下文菜单(UiContextMenu)', menuAfter > menuBefore, `弹出前=${menuBefore} 弹出后=${menuAfter}`);
      if (menuAfter > 0) {
        const menuItems = await page.locator('.ui-ctx-item').allTextContents();
        record('右键菜单含预期项', menuItems.length >= 3, `项=[${menuItems.join(',')}]`);
        // 点外部关闭
        await page.locator('.main, .editor-toolbar').first().click().catch(() => {});
        await sleep(400);
        const menuClosed = await page.locator('.ui-ctx-menu').count();
        record('右键菜单点外部关闭', menuClosed === 0, `剩余=${menuClosed}`);
      }
    }

    console.log('\n=== H. 运行时错误最终检查 ===');
    const realErrors = consoleErrors.filter(e => !e.includes('favicon'));
    record('全流程无未捕获异常', realErrors.length === 0,
      realErrors.length === 0 ? '' : realErrors.slice(0, 3).join(' | '));

  } catch (err) {
    record('脚本执行', false, err.message);
  } finally {
    await browser.close();
  }

  console.log('\n========== 深度交互汇总 ==========');
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`通过: ${passed}  失败: ${failed}  总计: ${results.length}`);
  if (failed > 0) {
    console.log('\n失败项:');
    results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
