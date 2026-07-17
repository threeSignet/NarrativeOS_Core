// AI 助手面板插件 manifest——贡献右侧 dock 面板视图
// 不声明 activity/sideView/mainView：Agent 面板由标题栏 AI 按钮控制开关，
// 独立于活动栏路由。App.vue 经 registry.getPanelView() 查询后渲染。
import type { PluginManifest } from '../../shell/types';
import AgentPanel from './AgentPanel.vue';

export const agentPanelManifest: PluginManifest = {
  id: 'agent-panel',
  panelView: AgentPanel,
};
