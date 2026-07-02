// 起草工作台前端入口
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './styles/tokens.css';
import './styles/shell.css';
import { applyPreferencesAtBoot } from './composables/usePreferences';

// 关键：在 Vue mount 之前应用 localStorage 中的主题与编辑器外观偏好，
// 消除「刷新时深色闪烁」并保证字号/行距首屏即正确。
applyPreferencesAtBoot();

const app = createApp(App);
app.use(createPinia());
app.mount('#app');
