/**
 * 应用入口：挂载 Solid 渲染树，注入路由（路由表见 src/router/index.tsx）
 */
import { render } from 'solid-js/web';
import { AppRouter } from './router';
import { initDatabase } from './utils/db';
import './styles/main.css';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('未找到 #root 挂载节点');
}

// 首屏即打开 IndexedDB 并按需播种演示数据（幂等；store 内部也会 await 同一个 Promise）
void initDatabase();

render(() => <AppRouter />, root);
