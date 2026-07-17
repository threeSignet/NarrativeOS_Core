<script setup lang="ts">
// 完整关系图谱画布（Obsidian 式交互）
// 核心：力导向收敛后彻底静止 + 节点按连接数大小 + 悬停高亮邻居 + 缩放平移
import { ref, computed, onMounted, onBeforeUnmount, reactive, watch } from 'vue';
import { useUiStore } from '../../stores/ui';
import { useEntityStore } from '../../stores/entity';
import type { GraphNode } from '../../api/types';
import { GRAPH_LAYER_META, layerColor, layerDash, layerLabel, predicateLabel, relationTypeLabel } from '../../utils/entityKinds';
import { UiEmpty } from '../../components';

const ui = useUiStore();
const entity = useEntityStore();

onMounted(() => { if (ui.projectId) entity.loadGraph(ui.projectId); });
watch(() => ui.projectId, (pid) => { if (pid && ui.activeActivity === 'entity-graph') entity.loadGraph(pid); });

// ===== 节点数据结构 =====
interface SimNode extends GraphNode { x: number; y: number; vx: number; vy: number; fixed?: boolean; degree: number }
const simNodes = ref<SimNode[]>([]);
const W = 1200, H = 800;

// ===== 节点度中心性（连接数）→ 半径映射（Obsidian 式：核心节点更大）=====
function computeDegrees() {
  const g = entity.filteredGraph;
  if (!g) return;
  const deg = new Map<string, number>();
  for (const e of g.edges) {
    deg.set(e.sourceNodeId, (deg.get(e.sourceNodeId) ?? 0) + 1);
    deg.set(e.targetNodeId, (deg.get(e.targetNodeId) ?? 0) + 1);
  }
  for (const n of simNodes.value) {
    n.degree = deg.get(n.id) ?? 0;
  }
}
function nodeRadius(n: SimNode): number {
  // 基础 16px，每条连接 +3px，上限 36px
  return Math.min(36, 16 + n.degree * 3);
}

// ===== 力导向布局（收敛后冻结）=====
function initSim() {
  const g = entity.filteredGraph;
  if (!g || g.nodes.length === 0) return;
  const rect = wrapRef.value?.getBoundingClientRect();
  const cw = rect?.width || W;
  const ch = rect?.height || H;
  simNodes.value = g.nodes.map((n, i) => {
    const angle = (i / g.nodes.length) * Math.PI * 2;
    const r = Math.min(cw, ch) * 0.25;
    return reactive({ ...n, x: cw/2 + r*Math.cos(angle), y: ch/2 + r*Math.sin(angle), vx: 0, vy: 0, degree: 0 });
  });
  computeDegrees();
  runConverge(150);
}

// 静态布局：同步收敛——所有轮在一个 JS tick 内跑完。
// Vue 渲染时节点直接出现在最终位置，用户看不到任何移动过程，彻底无弹动。
let frozen = true;
function runConverge(rounds = 150) {
  frozen = false;
  for (let i = 0; i < rounds; i++) {
    step();
  }
  for (const n of simNodes.value) { n.vx = 0; n.vy = 0; n.fixed = true; }
  frozen = true;
}
function startSim() { runConverge(50); }
function stopSim() {}

function step() {
  if (frozen) return;
  const nodes = simNodes.value;
  if (nodes.length === 0) return;
  const edges = entity.filteredGraph?.edges ?? [];
  const rect = wrapRef.value?.getBoundingClientRect();
  const cx = rect ? rect.width / 2 : W / 2;
  const cy = rect ? rect.height / 2 : H / 2;
  const REPULSION = 12000, SPRING = 0.015, SPRING_LEN = 160, CENTER = 0.003, DAMP = 0.82;
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

watch(() => entity.filteredGraph, () => { initSim(); }, { immediate: true });
onBeforeUnmount(() => stopSim());

// ===== 拖拽节点（Obsidian 式：拖时跟随鼠标，松手后微调平衡）=====
const canvasRef = ref<HTMLElement | null>(null);
const draggingId = ref<string | null>(null);

function onNodeDown(n: SimNode, e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  n.fixed = true;
  frozen = false;
  draggingId.value = n.id;
  // 拖拽时清零其他节点速度，避免连锁漂移
  for (const o of simNodes.value) { if (o.id !== n.id) { o.vx = 0; o.vy = 0; o.fixed = true; } }
  const rect = canvasRef.value?.getBoundingClientRect();
  if (!rect) return;
  const scaleX = rect.width / rect.width; // canvas 和 wrap 同尺寸（无内部 scale）
  const startX = e.clientX, startY = e.clientY;
  const ox = n.x, oy = n.y;
  const onMove = (ev: MouseEvent) => {
    n.x = ox + (ev.clientX - startX);
    n.y = oy + (ev.clientY - startY);
  };
  const onUp = () => {
    draggingId.value = null;
    // 松手后冻结，不重新跑力导向（Obsidian 拖完就停）
    for (const o of simNodes.value) { o.vx = 0; o.vy = 0; o.fixed = true; }
    frozen = true;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// ===== 缩放（以鼠标为中心）+ 平移 =====
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
  const newZoom = Math.max(0.2, Math.min(3, oldZoom * (e.deltaY < 0 ? 1.12 : 0.89)));
  const ix = (mx - panX.value) / oldZoom;
  const iy = (my - panY.value) / oldZoom;
  panX.value = mx - ix * newZoom;
  panY.value = my - iy * newZoom;
  zoom.value = newZoom;
}
let zoomResumeTimer: ReturnType<typeof setTimeout> | undefined;

// 空白处拖拽平移
const panning = ref(false);
function onCanvasDown(e: MouseEvent) {
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

// ===== 悬停高亮（Obsidian 标志性交互）=====
const hoverNodeId = ref<string | null>(null);
const hoverNeighborIds = computed(() => {
  if (!hoverNodeId.value || !entity.filteredGraph) return null;
  const ids = new Set<string>([hoverNodeId.value]);
  for (const e of entity.filteredGraph.edges) {
    if (e.sourceNodeId === hoverNodeId.value) ids.add(e.targetNodeId);
    if (e.targetNodeId === hoverNodeId.value) ids.add(e.sourceNodeId);
  }
  return ids;
});
function onNodeEnter(n: SimNode) { hoverNodeId.value = n.id; }
function onNodeLeave() { hoverNodeId.value = null; }
function isHighlighted(id: string): boolean {
  if (!hoverNodeId.value) return true; // 无悬停，全部正常
  return hoverNeighborIds.value?.has(id) ?? false;
}
function isEdgeHighlighted(srcId: string, tgtId: string): boolean {
  if (!hoverNodeId.value) return true;
  return srcId === hoverNodeId.value || tgtId === hoverNodeId.value;
}

// ===== 边渲染（每条关系独立边 + 线型区分）=====
const NODE_R = 26;
interface RenderedEdge {
  id: string; label: string; sourceLayer: string; direction: string;
  x1: number; y1: number; x2: number; y2: number;
  cx: number; cy: number; lx: number; ly: number;
  color: string; dash: string; highlighted: boolean;
}
function edgeLabel(e: { label: string; sourceLayer: string }): string {
  // 创作关联的 label 是作者自填中文（如"互为镜像"），原样用
  if (e.sourceLayer === 'association') return e.label;
  // candidate/committed 的 label 可能是英文 relationTypeId（如 siblings/ally），
  // 后端蓝图无 relationTypes 定义时 fallback 到原始 ID，这里用 relationTypeLabel 转中文
  return relationTypeLabel(e.label);
}
const simEdges = computed<RenderedEdge[]>(() => {
  const g = entity.filteredGraph;
  if (!g) return [];
  const map = new Map(simNodes.value.map((n) => [n.id, n]));
  const matched = entity.matchedNodeIds;
  const pairCount = new Map<string, { idx: number }>();
  const rendered: RenderedEdge[] = [];
  for (const e of g.edges) {
    const a = map.get(e.sourceNodeId); const b = map.get(e.targetNodeId);
    if (!a || !b) continue;
    const pairKey = [e.sourceNodeId, e.targetNodeId].sort().join('::');
    const pc = pairCount.get(pairKey) ?? { idx: 0 };
    const myIdx = pc.idx; pc.idx += 1; pairCount.set(pairKey, pc);
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.sqrt(dx*dx + dy*dy) || 1;
    const ux = dx / dist, uy = dy / dist;
    const rA = nodeRadius(a), rB = nodeRadius(b);
    const x1 = a.x + ux * rA, y1 = a.y + uy * rA;
    const x2 = b.x - ux * rB, y2 = b.y - uy * rB;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const curve = myIdx === 0 ? 0 : (myIdx % 2 === 1 ? 1 : -1) * (Math.ceil(myIdx / 2) * 28);
    const cx = mx + (-uy) * curve, cy = my + (ux) * curve;
    const searchMatched = matched === null ? true : (matched.has(e.sourceNodeId) && matched.has(e.targetNodeId));
    const hoverMatched = isEdgeHighlighted(e.sourceNodeId, e.targetNodeId);
    rendered.push({
      id: e.id, label: edgeLabel(e), sourceLayer: e.sourceLayer, direction: e.direction,
      x1, y1, x2, y2, cx, cy, lx: cx, ly: cy,
      color: layerColor(e.sourceLayer), dash: layerDash(e.sourceLayer),
      highlighted: searchMatched && (hoverNodeId.value ? hoverMatched : true),
    });
  }
  return rendered;
});

// ===== 节点详情 popover =====
const popoverNodeId = ref<string | null>(null);
const popoverNode = computed(() =>
  popoverNodeId.value ? simNodes.value.find((n) => n.id === popoverNodeId.value) ?? null : null,
);
function onSelectNode(n: SimNode) {
  if (ui.projectId) entity.selectEntity(ui.projectId, n.id);
  popoverNodeId.value = popoverNodeId.value === n.id ? null : n.id;
}
function closePopover() { popoverNodeId.value = null; }

function nodeMatched(id: string): boolean {
  const m = entity.matchedNodeIds;
  return m === null ? true : m.has(id);
}
</script>

<script lang="ts">
// 额外 script 块（目前空，保留用于未来非响应式导出）
</script>

<template>
  <div ref="wrapRef" class="graph-canvas-wrap" @wheel="onWheel">
    <UiEmpty
      v-if="!entity.filteredGraph || entity.filteredGraph.nodes.length === 0"
      block
      icon="graph-empty"
      title="关系图谱为空"
      description="还没有实体或关系。注册实体后，这里会展示完整关系网络。"
    />

    <div
      v-else
      ref="canvasRef"
      class="graph-canvas"
      :class="{ 'is-panning': panning }"
      :style="{ transform: `translate(${panX}px, ${panY}px) scale(${zoom})` }"
      @mousedown="onCanvasDown"
    >
      <!-- SVG overlay：每条关系一条独立边，按 sourceLayer 线型区分 -->
      <svg class="edges-svg">
        <g v-for="e in simEdges" :key="e.id">
          <path
            :d="`M${e.x1},${e.y1} Q${e.cx},${e.cy} ${e.x2},${e.y2}`"
            :stroke="e.color"
            :stroke-opacity="hoverNodeId && !e.highlighted ? 0.05 : (e.highlighted ? 0.7 : 0.15)"
            :stroke-width="e.highlighted ? 2 : 1"
            :stroke-dasharray="e.dash"
            fill="none"
          />
          <g v-if="e.highlighted && (!hoverNodeId || e.highlighted)" :transform="`translate(${e.lx},${e.ly})`">
            <rect
              :x="-(e.label.length * 6 + 6)" y="-9"
              :width="e.label.length * 12 + 12" height="18" rx="9"
              :fill="e.color" fill-opacity="0.18" :stroke="e.color" stroke-opacity="0.4"
            />
            <text x="0" y="4" text-anchor="middle" class="edge-label" :fill="e.color">{{ e.label }}</text>
          </g>
        </g>
      </svg>

      <!-- 节点（Obsidian 式：按度数大小 + 悬停高亮） -->
      <div
        v-for="n in simNodes" :key="n.id"
        class="node"
        :class="[
          'layer--' + n.sourceLayer,
          {
            'is-selected': entity.selectedId === n.id,
            'is-dragging': draggingId === n.id,
            'is-dimmed': !isHighlighted(n.id) || !nodeMatched(n.id),
            'is-hover': hoverNodeId === n.id,
            'is-matched': entity.matchedNodeIds !== null && nodeMatched(n.id),
          },
        ]"
        :style="{ left: n.x + 'px', top: n.y + 'px' }"
        @mousedown="onNodeDown(n, $event)"
        @click="onSelectNode(n)"
        @mouseenter="onNodeEnter(n)"
        @mouseleave="onNodeLeave"
      >
        <div
          class="node-avatar"
          :style="{
            width: nodeRadius(n) * 2 + 'px',
            height: nodeRadius(n) * 2 + 'px',
            borderColor: layerColor(n.sourceLayer),
            background: layerColor(n.sourceLayer) + '22',
            fontSize: Math.max(12, nodeRadius(n) * 0.5) + 'px',
          }"
        >{{ n.label.slice(0, 1) }}</div>
        <div class="node-name">{{ n.label }}</div>
        <div class="node-type">{{ n.projectTypeLabel }}</div>
      </div>
    </div>

    <!-- 节点详情面板 -->
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
      <div class="popover-section">
        <div class="section-title">连接数</div>
        <div class="popover-degree">{{ popoverNode.degree }} 条关系</div>
      </div>
    </div>

    <!-- 图例 + 缩放控件 -->
    <div class="graph-overlay">
      <div class="legend">
        <span v-for="l in GRAPH_LAYER_META" :key="l.key" class="legend-item">
          <span class="legend-dot" :style="{ background: l.color }"></span>{{ l.label }}
        </span>
      </div>
      <div class="zoom-ctl">
        <button @click="zoom = Math.min(3, zoom * 1.2)">＋</button>
        <button @click="zoom = 1; panX = 0; panY = 0">{{ Math.round(zoom * 100) }}%</button>
        <button @click="zoom = Math.max(0.2, zoom * 0.8)">－</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.graph-canvas-wrap {
  position: relative; width: 100%; height: 100%;
  overflow: hidden; background: var(--bg);
  background-image: radial-gradient(circle, var(--border) 1px, transparent 1px);
  background-size: 28px 28px;
}
.graph-canvas {
  position: relative; width: 100%; height: 100%;
  transform-origin: 0 0; cursor: grab;
}
.graph-canvas.is-panning { cursor: grabbing; }
.edges-svg {
  position: absolute; inset: 0; width: 100%; height: 100%;
  pointer-events: none; overflow: visible;
}
.edge-label { font-size: 11px; font-weight: 500; pointer-events: none; user-select: none; }

/* 节点（Obsidian 式圆形） */
.node {
  position: absolute; transform: translate(-50%, -50%);
  cursor: pointer; user-select: none;
  display: flex; flex-direction: column; align-items: center;
  transition: opacity 0.2s ease;
}
.node.is-dragging { z-index: 10; cursor: grabbing; }
.node.is-dimmed { opacity: 0.15; }
.node-avatar {
  border-radius: 50%; border: 2px solid;
  display: flex; align-items: center; justify-content: center;
  font-weight: 600; color: var(--text);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.node:hover .node-avatar { transform: scale(1.12); }
.node.is-hover .node-avatar { transform: scale(1.15); box-shadow: 0 0 12px var(--accent); }
.node.is-selected .node-avatar { border-width: 3px; box-shadow: 0 0 0 2px var(--text); }
.node.is-matched .node-avatar { border-width: 3px; box-shadow: 0 0 10px var(--accent); }
/* 按 sourceLayer 区分边框样式 */
.node.layer--committed .node-avatar { border-style: solid; }
.node.layer--candidate .node-avatar { border-style: dashed; }
.node.layer--draft .node-avatar { border-style: dashed; opacity: 0.85; }
.node.layer--hint .node-avatar { border-style: dotted; opacity: 0.6; }
.node.layer--association .node-avatar { border-style: double; }
.node.layer--view .node-avatar { border-style: dotted; opacity: 0.4; }
.node-name { margin-top: 4px; font-size: var(--fs-xs); font-weight: 500; color: var(--text); white-space: nowrap; }
.node-type { font-size: 10px; color: var(--text-3); }

/* 节点详情面板 */
.node-popover {
  position: absolute; top: var(--sp-3); right: var(--sp-3);
  width: 280px; background: var(--bg-elev, var(--bg-2));
  border: 1px solid var(--border-2); border-radius: var(--r-md);
  box-shadow: var(--shadow-md); padding: var(--sp-3); z-index: 50;
}
.popover-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.popover-name { font-size: var(--fs-md); font-weight: 600; color: var(--text); }
.popover-close { width: 22px; height: 22px; border-radius: var(--r-xs); color: var(--text-3); font-size: 16px; line-height: 1; display: flex; align-items: center; justify-content: center; }
.popover-close:hover { background: var(--bg-3); color: var(--text); }
.popover-meta { font-size: var(--fs-xs); color: var(--text-3); margin-bottom: 8px; display: flex; gap: 4px; align-items: center; }
.dot-sep { opacity: 0.5; }
.popover-summary { font-size: var(--fs-sm); color: var(--text-2); line-height: 1.5; margin-bottom: 8px; }
.popover-section { margin-top: 10px; }
.section-title { font-size: var(--fs-xs); font-weight: 600; color: var(--text-3); margin-bottom: 4px; letter-spacing: 0.04em; }
.popover-attrs { display: flex; flex-direction: column; gap: 4px; }
.popover-attr { display: flex; gap: 6px; align-items: baseline; font-size: var(--fs-xs); }
.attr-label { color: var(--text-3); flex-shrink: 0; min-width: 36px; }
.attr-value { color: var(--text); }
.popover-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.popover-tag { font-size: 10px; padding: 1px 6px; border-radius: var(--r-pill); background: var(--bg-3); color: var(--text-2); }
.popover-degree { font-size: var(--fs-sm); color: var(--text-2); }

/* 图例 + 缩放 */
.graph-overlay {
  position: absolute; bottom: var(--sp-3); left: var(--sp-3); right: var(--sp-3);
  display: flex; justify-content: space-between; align-items: flex-end; pointer-events: none;
}
.legend { display: flex; flex-wrap: wrap; gap: 8px; background: var(--bg-2); border: 1px solid var(--border); padding: 6px 10px; border-radius: var(--r-sm); font-size: var(--fs-xs); color: var(--text-2); }
.legend-item { display: inline-flex; align-items: center; gap: 4px; }
.legend-dot { width: 8px; height: 8px; border-radius: 50%; }
.zoom-ctl { display: flex; gap: 2px; pointer-events: auto; }
.zoom-ctl button { min-width: 36px; height: 28px; padding: 0 8px; background: var(--bg-2); border: 1px solid var(--border); color: var(--text-2); font-size: var(--fs-sm); cursor: pointer; border-radius: var(--r-sm); }
.zoom-ctl button:hover { background: var(--bg-3); color: var(--text); }
</style>
