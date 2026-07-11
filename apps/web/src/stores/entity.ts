// Entity store——实体列表 + 关系图谱 + 审核态机（里程碑②③）
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  listEntities, getEntity,
  createEntity, promoteEntity, approveEntity, registerEntity, deprecateEntity,
  type EntityCard,
} from '../api/entities';
import { getGraph } from '../api/graph';
import { listDecisions, resolveDecision, type PendingDecision } from '../api/decisions';
import type { GraphView } from '../api/types';

export const useEntityStore = defineStore('entity', () => {
  const entities = ref<EntityCard[]>([]);
  const graph = ref<GraphView | null>(null);
  const selectedId = ref<string | null>(null);
  const selected = ref<EntityCard | null>(null);
  const loading = ref(false);
  const error = ref('');
  /** 搜索关键词（侧栏/图谱共享，实时过滤/高亮） */
  const query = ref('');
  /** 来源层过滤（§10.2 GraphFilterState.layers）。
   * 默认隐藏 hint（推测边），§10.8 要求"默认隐藏推测边和低置信度提示"。
   * hiddenLayers 存被隐藏的层；空 = 全显。 */
  const hiddenLayers = ref<Set<string>>(new Set(['hint']));
  function toggleLayer(layer: string) {
    const s = new Set(hiddenLayers.value);
    if (s.has(layer)) s.delete(layer); else s.add(layer);
    hiddenLayers.value = s;
  }

  /** 加载实体列表（status 省略=全部） */
  async function loadEntities(projectId: string, status?: 'registered' | 'candidate') {
    loading.value = true; error.value = '';
    try {
      entities.value = await listEntities(projectId, status);
    } catch (e) {
      error.value = (e as Error).message;
      entities.value = [];
    } finally {
      loading.value = false;
    }
  }

  /** 按 query 过滤的实体列表（侧栏实时过滤用） */
  const filteredEntities = computed(() => {
    const q = query.value.trim().toLowerCase();
    if (!q) return entities.value;
    return entities.value.filter((e) =>
      e.name.toLowerCase().includes(q)
      || e.typeLabel.toLowerCase().includes(q)
      || e.tags.some((t) => t.toLowerCase().includes(q)),
    );
  });

  /** 按 hiddenLayers 过滤后的图谱（隐藏的层节点+边都过滤掉）。
   * 节点：若节点的 sourceLayer 被隐藏则不显示。
   * 边：若边的 sourceLayer 被隐藏则不显示。 */
  const filteredGraph = computed<GraphView | null>(() => {
    if (!graph.value) return null;
    const hidden = hiddenLayers.value;
    if (hidden.size === 0) return graph.value;
    const nodes = graph.value.nodes.filter((n) => !hidden.has(n.sourceLayer));
    const visibleIds = new Set(nodes.map((n) => n.id));
    const edges = graph.value.edges.filter((e) =>
      !hidden.has(e.sourceLayer) && visibleIds.has(e.sourceNodeId) && visibleIds.has(e.targetNodeId),
    );
    return { ...graph.value, nodes, edges };
  });

  /** 按 query 标记图谱节点是否匹配（图谱高亮用，基于 filteredGraph） */
  const matchedNodeIds = computed(() => {
    const q = query.value.trim().toLowerCase();
    if (!q || !filteredGraph.value) return null; // null = 无搜索，全部正常显示
    return new Set(
      filteredGraph.value.nodes
        .filter((n) =>
          n.label.toLowerCase().includes(q)
          || n.projectTypeLabel.toLowerCase().includes(q)
          || (n.tags ?? []).some((t) => t.toLowerCase().includes(q)),
        )
        .map((n) => n.id),
    );
  });

  /** 加载关系图谱（默认 relationship 模式：含候选+关联，能看到未进 Core 的关系） */
  async function loadGraph(projectId: string, mode: 'world' | 'relationship' | 'spatial' | 'timeline' = 'relationship') {
    try {
      graph.value = await getGraph(projectId, mode);
    } catch (e) {
      error.value = (e as Error).message;
      graph.value = null;
    }
  }

  /** 选中实体（加载详情卡） */
  async function selectEntity(projectId: string, id: string | null) {
    selectedId.value = id;
    if (!id) { selected.value = null; return; }
    try {
      selected.value = await getEntity(projectId, id);
    } catch (e) {
      selected.value = null;
      error.value = (e as Error).message;
    }
  }

  // ===== 写入 action（里程碑③：审核态机）=====
  const pendingDecisions = ref<PendingDecision[]>([]);
  const acting = ref(false); // 操作进行中（防重复点击）

  /** 刷新实体列表 + 图谱 + 决策（写入后统一刷新） */
  async function refreshAll(projectId: string) {
    await Promise.all([
      loadEntities(projectId),
      loadGraph(projectId),
      loadDecisions(projectId),
    ]);
  }

  /** 新建实体（一步到位到 candidate） */
  async function create(projectId: string, input: { displayName: string; typeLabel: string; summary?: string }) {
    acting.value = true; error.value = '';
    try {
      await createEntity(projectId, input);
      await refreshAll(projectId);
    } catch (e) { error.value = (e as Error).message; throw e; }
    finally { acting.value = false; }
  }

  /** candidate → approved */
  async function approve(projectId: string, id: string) {
    acting.value = true;
    try { await approveEntity(projectId, id); await refreshAll(projectId); }
    catch (e) { error.value = (e as Error).message; throw e; }
    finally { acting.value = false; }
  }

  /** approved → registered（直接注册，或经决策确认） */
  async function register(projectId: string, id: string) {
    acting.value = true;
    try { await registerEntity(projectId, id); await refreshAll(projectId); }
    catch (e) { error.value = (e as Error).message; throw e; }
    finally { acting.value = false; }
  }

  /** 废弃实体 */
  async function deprecate(projectId: string, id: string, reason?: string) {
    acting.value = true;
    try { await deprecateEntity(projectId, id, reason); await refreshAll(projectId); }
    catch (e) { error.value = (e as Error).message; throw e; }
    finally { acting.value = false; }
  }

  /** 加载待确认决策 */
  async function loadDecisions(projectId: string) {
    try {
      const all = await listDecisions(projectId);
      pendingDecisions.value = all.filter((d) => d.status === 'open');
    } catch { pendingDecisions.value = []; }
  }

  /** 解决决策（confirm_entity + resolve → 触发注册进 Core） */
  async function resolvePendingDecision(projectId: string, id: string, action: 'resolve' | 'dismiss' = 'resolve') {
    acting.value = true;
    try {
      await resolveDecision(projectId, id, action);
      await refreshAll(projectId);
    } catch (e) { error.value = (e as Error).message; throw e; }
    finally { acting.value = false; }
  }

  function clear() {
    entities.value = []; graph.value = null;
    selectedId.value = null; selected.value = null; error.value = ''; query.value = '';
    pendingDecisions.value = [];
  }

  return { entities, graph, filteredGraph, selectedId, selected, loading, error, acting,
    query, hiddenLayers, toggleLayer,
    filteredEntities, matchedNodeIds, pendingDecisions,
    loadEntities, loadGraph, selectEntity, clear,
    create, approve, register, deprecate,
    loadDecisions, resolvePendingDecision };
});
