<script setup lang="ts">
// 完整关系图谱画布（模块主区）——div 绝对定位节点 + SVG overlay 连线
// 关键修复：节点用 CSS 绝对定位（top/left 是 px），拖拽直接用鼠标 screen 坐标，
// 彻底避免 SVG viewBox 坐标空间≠屏幕坐标的"不跟手"问题。
import { ref, computed, onMounted, onBeforeUnmount, reactive, watch } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useEntityStore } from '../../stores/entity';
import type { GraphNode } from '../../api/types';
import { GRAPH_LAYER_META, layerColor, layerDash, layerLabel, predicateLabel, relationTypeLabel } from '../../utils/entityKinds';

const ui = useUiStore();
const entity = useEntityStore();

onMounted(() => { if (ui.projectId) entity.loadGraph(ui.projectId); });
// 切项目时重新加载图谱（onMounted 只执行一次，切项目不会重新挂载）
watch(() => ui.projectId, (pid) => { if (pid && ui.activeActivity === 'entity-graph') entity.loadGraph(pid); });

// ===== 力导向布局（极简，无依赖） =====
interface SimNode extends GraphNode { x: number; y: number; vx: number; vy: number; fixed?: boolean }
const simNodes = ref<SimNode[]>([]);
// 画布参考尺寸（用于力导向的引力中心；实际随容器动态读）
const W = 1200, H = 800;

function initSim() {
  const g = entity.filteredGraph;
  if (!g || g.nodes.length === 0) return;
  // 用 wrap（不受 transform 影响）的尺寸做初始布局
  const rect = wrapRef.value?.getBoundingClientRect();
  const cw = rect?.width || W;
  const ch = rect?.height || H;
  simNodes.value = g.nodes.map((n, i) => {
    const angle = (i / g.nodes.length) * Math.PI * 2;
    const r = Math.min(cw, ch) * 0.25;
    return reactive({ ...n, x: cw/2 + r*Math.cos(angle), y: ch/2 + r*Math.sin(angle), vx: 0, vy: 0 });
  });
  runConverge(120);
}

// 静态布局：initSim 排好后跑固定轮数收敛（不持续 RAF，节点静态不动）
let rafId = 0;
function runConverge(rounds = 120) {
  cancelAnimationFrame(rafId);
  let i = 0;
  const tick = () => {
    step();
    i++;
    if (i < rounds) { rafId = requestAnimationFrame(tick); }
  };
  rafId = requestAnimationFrame(tick);
}
// 拖拽后局部重平衡（少量轮数，节点微调后停）
function startSim() { runConverge(40); }
function stopSim() { cancelAnimationFrame(rafId); }

function step() {
  const nodes = simNodes.value;
  if (nodes.length === 0) return;
  const edges = entity.filteredGraph?.edges ?? [];
  // 引力中心用 wrap（外层，不受 transform 影响）的逻辑尺寸中心。
  // 节点坐标是逻辑坐标，不能用 canvas（有 transform）的 rect，否则缩放后中心偏移。
  const rect = wrapRef.value?.getBoundingClientRect();
  const cx = rect ? rect.width / 2 : W / 2;
  const cy = rect ? rect.height / 2 : H / 2;
  const REPULSION = 9000, SPRING = 0.02, SPRING_LEN = 150, CENTER = 0.004, DAMP = 0.86;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx*dx + dy*dy;
      if (d2 < 1) { d2 = 1; dx = Math.random(); dy = Math.random(); }
      const d = Math.sqrt(d2);
      const f = REPULSION / d2;
      const fx = (dx/d) * f, fy = (dy/d) * f;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
  }
  for (const e of edges) {
    const a = nodes.find((n) => n.id === e.sourceNodeId);
    const b = nodes.find((n) => n.id === e.targetNodeId);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx*dx + dy*dy) || 1;
    const f = (d - SPRING_LEN) * SPRING;
    const fx = (dx/d) * f, fy = (dy/d) * f;
    a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
  }
  for (const n of nodes) {
    if (n.fixed) continue;
    n.vx += (cx - n.x) * CENTER;
    n.vy += (cy - n.y) * CENTER;
    n.vx *= DAMP; n.vy *= DAMP;
    n.x += n.vx; n.y += n.vy;
  }
}

watch(() => entity.filteredGraph, (g) => { if (g) initSim(); }, { immediate: true });
onBeforeUnmount(() => stopSim());

// ===== 拖拽（核心修复：screen 坐标 → 节点 x/y，经 viewBox 比例换算） =====
const canvasRef = ref<HTMLElement | null>(null);
const draggingId = ref<string | null>(null);

function onNodeDown(n: SimNode, e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  n.fixed = true;
  draggingId.value = n.id;
  stopSim(); // 拖拽时停力导向，避免力把节点拽走
  const rect = canvasRef.value?.getBoundingClientRect();
  if (!rect) return;
  // canvas 内部坐标空间 W×H，渲染到 rect.width×rect.height
  const scaleX = W / rect.width, scaleY = H / rect.height;
  const startX = e.clientX, startY = e.clientY;
  const ox = n.x, oy = n.y;
  const onMove = (ev: MouseEvent) => {
    n.x = ox + (ev.clientX - startX) * scaleX;
    n.y = oy + (ev.clientY - startY) * scaleY;
  };
  const onUp = () => {
    n.fixed = false;
    draggingId.value = null;
    // 拖完继续力导向（让节点重新受力平衡）
    setTimeout(() => startSim(), 100);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// ===== 缩放 + 平移（以鼠标为中心缩放） =====
// canvas 用 transform: translate(panX,panY) scale(zoom)，transform-origin: 0 0。
// 缩放时保持鼠标下的内部点不动：内部坐标 ix=(mx-panX)/zoom，
// 新 panX = mx - ix*newZoom，使 (ix,iy) 缩放后仍映射到屏幕 (mx,my)。
const zoom = ref(1);
const panX = ref(0);
const panY = ref(0);
const wrapRef = ref<HTMLElement | null>(null);
function onWheel(e: WheelEvent) {
  e.preventDefault();
  const wrap = wrapRef.value;
  if (!wrap) return;
  const rect = wrap.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const oldZoom = zoom.value;
  const newZoom = Math.max(0.3, Math.min(2.5, oldZoom * (e.deltaY < 0 ? 1.1 : 0.9)));
  const ix = (mx - panX.value) / oldZoom;
  const iy = (my - panY.value) / oldZoom;
  panX.value = mx - ix * newZoom;
  panY.value = my - iy * newZoom;
  zoom.value = newZoom;
  // 缩放时暂停力导向（避免节点持续移动叠加视觉漂移），结束后恢复
  stopSim();
  clearTimeout(zoomResumeTimer);
  zoomResumeTimer = setTimeout(() => startSim(), 400);
}
let zoomResumeTimer: ReturnType<typeof setTimeout> | undefined;

// 空白处拖拽平移整个图谱
const panning = ref(false);
function onCanvasDown(e: MouseEvent) {
  // 点在节点上不触发平移（节点有自己的 mousedown + stopPropagation）
  if ((e.target as HTMLElement).closest('.node')) return;
  e.preventDefault();
  panning.value = true;
  const startX = e.clientX, startY = e.clientY;
  const ox = panX.value, oy = panY.value;
  const onMove = (ev: MouseEvent) => {
    panX.value = ox + (ev.clientX - startX);
    panY.value = oy + (ev.clientY - startY);
  };
  const onUp = () => {
    panning.value = false;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// 点击节点弹出详情 popover（取代挂属性在节点下方）
const popoverNodeId = ref<string | null>(null);
const popoverNode = computed(() =>
  popoverNodeId.value ? simNodes.value.find((n) => n.id === popoverNodeId.value) ?? null : null,
);

// ===== 边渲染（SVG overlay，每条关系一条独立边，按 sourceLayer 线型区分） =====
// §8.8/§10.1：每条关系一条独立视图边，按来源层用不同线型区分。
// 同一实体对的并行边用不同曲度错开（避免重叠）。
const NODE_R = 26;
interface RenderedEdge {
  id: string;
  label: string;          // 人话关系名（中文）
  sourceLayer: string;
  direction: string;
  x1: number; y1: number; x2: number; y2: number;
  cx: number; cy: number; // 贝塞尔控制点（曲度错开并行边）
  lx: number; ly: number;
  color: string;
  dash: string;           // SVG stroke-dasharray（线型）
  highlighted: boolean;
}

/** 单条 graph edge 的关系名转中文 */
function edgeLabel(e: { label: string; sourceLayer: string }): string {
  if (e.sourceLayer === 'association') return e.label; // 作者自填中文
  return relationTypeLabel(e.label);
}

const simEdges = computed<RenderedEdge[]>(() => {
  const g = entity.filteredGraph; // 用过滤后的图谱（隐藏 hint 等）
  if (!g) return [];
  const map = new Map(simNodes.value.map((n) => [n.id, n]));
  const matched = entity.matchedNodeIds;
  // 统计每对实体的并行边数，用于曲度错开
  const pairCount = new Map<string, { idx: number }>();
  const rendered: RenderedEdge[] = [];
  for (const e of g.edges) {
    const a = map.get(e.sourceNodeId);
    const b = map.get(e.targetNodeId);
    if (!a || !b) continue;
    const pairKey = [e.sourceNodeId, e.targetNodeId].sort().join('::');
    const pc = pairCount.get(pairKey) ?? { idx: 0 };
    const myIdx = pc.idx; pc.idx += 1; pairCount.set(pairKey, pc);

    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.sqrt(dx*dx + dy*dy) || 1;
    const ux = dx / dist, uy = dy / dist;
    const x1 = a.x + ux * NODE_R, y1 = a.y + uy * NODE_R;
    const x2 = b.x - ux * NODE_R, y2 = b.y - uy * NODE_R;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    // 并行边曲度：第 0 条直线，其余交替正负偏移，逐条增大
    const curve = myIdx === 0 ? 0 : (myIdx % 2 === 1 ? 1 : -1) * (Math.ceil(myIdx / 2) * 30);
    const cx = mx + (-uy) * curve;
    const cy = my + (ux) * curve;
    const highlighted = matched === null ? true : (matched.has(e.sourceNodeId) && matched.has(e.targetNodeId));
    rendered.push({
      id: e.id, label: edgeLabel(e), sourceLayer: e.sourceLayer, direction: e.direction,
      x1, y1, x2, y2, cx, cy, lx: cx, ly: cy,
      color: layerColor(e.sourceLayer),
      dash: layerDash(e.sourceLayer),
      highlighted,
    });
  }
  return rendered;
});

// ===== 搜索高亮（来自 store.matchedNodeIds） =====
function nodeMatched(id: string): boolean {
  const m = entity.matchedNodeIds;
  return m === null ? true : m.has(id); // null=无搜索，全亮
}
function onSelectNode(n: SimNode) {
  if (ui.projectId) entity.selectEntity(ui.projectId, n.id);
  // 点击节点弹详情 popover（再次点击同一节点关闭）
  popoverNodeId.value = popoverNodeId.value === n.id ? null : n.id;
}
function closePopover() { popoverNodeId.value = null; }
</script>

<template>
  <div ref="wrapRef" class="graph-canvas-wrap" @wheel="onWheel">
    <div v-if="!entity.filteredGraph || entity.filteredGraph.nodes.length === 0" class="empty-state">
      <svg class="ico" viewBox="0 0 24 24" style="width:48px;height:48px;opacity:.4"><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M8 7h8M8 7l3 9M16 7l-3 9"/></svg>
      <div class="es-title">关系图谱为空</div>
      <div class="es-desc">还没有实体或关系。注册实体后，这里会展示完整关系网络。<br/>可让 AI 助手帮你提取实体，或等待里程碑③手动创建。</div>
    </div>

    <div
      v-else
      ref="canvasRef"
      class="graph-canvas"
      :class="{ 'is-panning': panning }"
      :style="{ transform: `translate(${panX}px, ${panY}px) scale(${zoom})` }"
      @mousedown="onCanvasDown"
    >
      <!-- SVG overlay：每条关系一条独立边，按 sourceLayer 线型区分（§8.8/§10.1） -->
      <svg class="edges-svg">
        <g v-for="e in simEdges" :key="e.id">
          <!-- 贝塞尔曲线（曲度错开并行边） -->
          <path
            :d="`M${e.x1},${e.y1} Q${e.cx},${e.cy} ${e.x2},${e.y2}`"
            :stroke="e.color"
            :stroke-opacity="e.highlighted ? 0.7 : 0.15"
            :stroke-width="e.highlighted ? 2 : 1"
            :stroke-dasharray="e.dash"
            fill="none"
          />
          <!-- 边标签（人话关系名，带背景） -->
          <g v-if="e.highlighted" :transform="`translate(${e.lx},${e.ly})`">
            <rect
              :x="-(e.label.length * 6 + 6)" y="-9"
              :width="e.label.length * 12 + 12" height="18" rx="9"
              :fill="e.color" fill-opacity="0.18"
              :stroke="e.color" stroke-opacity="0.4"
            />
            <text x="0" y="4" text-anchor="middle" class="edge-label" :fill="e.color">{{ e.label }}</text>
          </g>
        </g>
      </svg>

      <!-- 节点（圆形，按 sourceLayer 视觉区分） -->
      <div
        v-for="n in simNodes" :key="n.id"
        class="node"
        :class="[
          'layer--' + n.sourceLayer,
          {
            'is-selected': entity.selectedId === n.id,
            'is-dragging': draggingId === n.id,
            'is-dimmed': !nodeMatched(n.id),
            'is-matched': entity.matchedNodeIds !== null && nodeMatched(n.id),
          },
        ]"
        :style="{ left: n.x + 'px', top: n.y + 'px' }"
        @mousedown="onNodeDown(n, $event)"
        @click="onSelectNode(n)"
      >
        <div class="node-avatar" :style="{ borderColor: layerColor(n.sourceLayer), background: layerColor(n.sourceLayer) + '22' }">
          {{ n.label.slice(0, 1) }}
        </div>
        <div class="node-name">{{ n.label }}</div>
        <div class="node-type">{{ n.projectTypeLabel }}</div>
      </div>
    </div>

    <!-- 节点详情面板（右侧抽屉，§10.3：来源+状态+人话Core摘要+操作） -->
    <div v-if="popoverNode" class="node-popover" @mousedown.stop>
      <div class="popover-head">
        <span class="popover-name">{{ popoverNode.label }}</span>
        <button class="popover-close" @click="closePopover">×</button>
      </div>
      <div class="popover-meta">
        <span>{{ popoverNode.projectTypeLabel }}</span>
        <span class="dot-sep">·</span>
        <span>{{ popoverNode.statusLabel }}</span>
        <span class="dot-sep">·</span>
        <span :style="{ color: layerColor(popoverNode.sourceLayer) }">{{ layerLabel(popoverNode.sourceLayer) }}</span>
      </div>
      <div v-if="popoverNode.summary" class="popover-summary">{{ popoverNode.summary }}</div>
      <!-- 人话 Core 摘要（谓词→中文标签，§9.1 不裸露 predicate） -->
      <div v-if="popoverNode.attributes && popoverNode.attributes.length" class="popover-section">
        <div class="section-title">状态档案</div>
        <div class="popover-attrs">
          <div v-for="(a, i) in popoverNode.attributes" :key="i" class="popover-attr">
            <span class="attr-label">{{ predicateLabel(a.predicate) }}</span>
            <span class="attr-value">{{ a.value }}</span>
          </div>
        </div>
      </div>
      <div v-if="popoverNode.tags && popoverNode.tags.length" class="popover-section">
        <div class="section-title">标签</div>
        <div class="popover-tags">
          <span v-for="t in popoverNode.tags" :key="t" class="popover-tag">{{ t }}</span>
        </div>
      </div>
      <!-- 操作区（§10.3：不同来源层不同操作，里程碑③接入真实动作） -->
      <div class="popover-actions">
        <div class="section-title">操作</div>
        <button v-if="popoverNode.sourceLayer === 'hint'" class="action-btn" disabled>转为候选（里程碑③）</button>
        <button v-else-if="popoverNode.sourceLayer === 'candidate'" class="action-btn" disabled>进入审核（里程碑③）</button>
        <button v-else-if="popoverNode.sourceLayer === 'committed'" class="action-btn" disabled>查看历史 / Retcon（里程碑③）</button>
        <button v-else class="action-btn" disabled>查看详情</button>
      </div>
    </div>

    <!-- 图例（中文）+ 缩放控件 -->
    <div class="graph-overlay">
      <div class="legend">
        <span v-for="l in GRAPH_LAYER_META" :key="l.key" class="legend-item">
          <span class="legend-dot" :style="{ background: l.color }"></span>{{ l.label }}
        </span>
      </div>
      <div class="zoom-ctl">
        <button @click="zoom = Math.min(2.5, zoom * 1.2)">＋</button>
        <button @click="zoom = 1">{{ Math.round(zoom * 100) }}%</button>
        <button @click="zoom = Math.max(0.3, zoom * 0.8)">－</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.graph-canvas-wrap {
  position: relative;
  width: 100%; height: 100%;
  overflow: hidden;
  background: var(--bg);
  background-image: radial-gradient(circle, var(--border) 1px, transparent 1px);
  background-size: 24px 24px;
}
.graph-canvas {
  position: relative;
  width: 100%; height: 100%;
  transform-origin: 0 0;
  cursor: grab;
}
.graph-canvas.is-panning { cursor: grabbing; }
.edges-svg {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  pointer-events: none;
  overflow: visible;
}
.edge-label {
  font-size: 11px;
  font-weight: 500;
  pointer-events: none;
  user-select: none;
}
.node {
  position: absolute;
  transform: translate(-50%, -50%);
  cursor: pointer;
  user-select: none;
  transition: opacity var(--t-fast);
  display: flex; flex-direction: column; align-items: center;
}
.node:active { cursor: grabbing; }
.node.is-dragging { z-index: 10; cursor: grabbing; }
.node.is-dimmed { opacity: 0.18; }
/* 圆形头像 */
.node-avatar {
  width: 48px; height: 48px;
  border-radius: 50%;
  border: 2px solid;
  display: flex; align-items: center; justify-content: center;
  font-size: var(--fs-md); font-weight: 600;
  color: var(--text);
  transition: transform var(--t-fast), border-width var(--t-fast), box-shadow var(--t-fast);
}
.node:hover .node-avatar { transform: scale(1.08); }
.node.is-selected .node-avatar { border-width: 3px; box-shadow: 0 0 0 2px var(--text); }
.node.is-matched .node-avatar { border-width: 3px; box-shadow: 0 0 10px var(--accent); }
/* 按 sourceLayer 区分节点（§10.1 验收 3243：正式/候选/草案/提示节点视觉区分） */
.node.layer--committed .node-avatar { border-style: solid; }
.node.layer--candidate .node-avatar { border-style: dashed; }
.node.layer--draft .node-avatar { border-style: dashed; opacity: 0.85; }
.node.layer--hint .node-avatar { border-style: dotted; opacity: 0.6; }
.node.layer--association .node-avatar { border-style: double; }
.node.layer--view .node-avatar { border-style: dotted; opacity: 0.4; }
.node-name {
  margin-top: 4px;
  font-size: var(--fs-xs); font-weight: 500;
  color: var(--text);
  white-space: nowrap;
}
.node-type {
  font-size: 10px;
  color: var(--text-3);
}

/* 节点详情 popover（右上角浮窗） */
.node-popover {
  position: absolute;
  top: var(--sp-3); right: var(--sp-3);
  width: 280px;
  background: var(--bg-elev, var(--bg-2));
  border: 1px solid var(--border-2);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-md);
  padding: var(--sp-3);
  z-index: 50;
}
.popover-head {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 4px;
}
.popover-name { font-size: var(--fs-md); font-weight: 600; color: var(--text); }
.popover-close {
  width: 22px; height: 22px; border-radius: var(--r-xs);
  color: var(--text-3); font-size: 16px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
}
.popover-close:hover { background: var(--bg-3); color: var(--text); }
.popover-meta { font-size: var(--fs-xs); color: var(--text-3); margin-bottom: 8px; display: flex; gap: 4px; align-items: center; }
.dot-sep { opacity: 0.5; }
.popover-summary { font-size: var(--fs-sm); color: var(--text-2); line-height: 1.5; margin-bottom: 8px; }
.popover-attrs { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.popover-attr {
  display: flex; gap: 6px; align-items: baseline;
  font-size: var(--fs-xs);
}
.attr-label { color: var(--text-3); flex-shrink: 0; min-width: 36px; }
.attr-value { color: var(--text); }
.popover-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.popover-tag {
  font-size: 10px; padding: 1px 6px;
  border-radius: var(--r-pill);
  background: var(--bg-3); color: var(--text-2);
}
.popover-section { margin-top: 10px; }
.section-title {
  font-size: var(--fs-xs); font-weight: 600;
  color: var(--text-3); margin-bottom: 4px;
  letter-spacing: 0.04em;
}
.popover-actions { margin-top: 12px; }
.action-btn {
  width: 100%; padding: 6px 10px;
  font-size: var(--fs-sm); color: var(--text-2);
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--r-sm); cursor: not-allowed;
  text-align: left;
}

.graph-overlay {
  position: absolute; bottom: var(--sp-3); left: var(--sp-3); right: var(--sp-3);
  display: flex; justify-content: space-between; align-items: flex-end;
  pointer-events: none;
}
.legend {
  display: flex; flex-wrap: wrap; gap: 8px;
  background: var(--bg-2); border: 1px solid var(--border);
  padding: 6px 10px; border-radius: var(--r-sm);
  font-size: var(--fs-xs); color: var(--text-2);
}
.legend-item { display: inline-flex; align-items: center; gap: 4px; }
.legend-dot { width: 8px; height: 8px; border-radius: 50%; }
.zoom-ctl { display: flex; gap: 2px; pointer-events: auto; }
.zoom-ctl button {
  min-width: 32px; height: 28px; padding: 0 8px;
  background: var(--bg-2); border: 1px solid var(--border); color: var(--text-2);
  font-size: var(--fs-sm); cursor: pointer; border-radius: var(--r-sm);
}
.zoom-ctl button:hover { background: var(--bg-3); color: var(--text); }
</style>
