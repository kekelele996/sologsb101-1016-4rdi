/**
 * 路由表（@solidjs/router）
 * /ponds、/gates、/observations、/assays、/schedules、/export
 * 每个路由都可以直接粘贴 URL 刷新打开（nginx 已配置 try_files 回退）。
 */
import { Navigate, Route, Router } from '@solidjs/router';
import App from '../App';
import PondList from '../pages/PondList';
import GateConfig from '../pages/GateConfig';
import ObservationEntry from '../pages/ObservationEntry';
import AssayEntry from '../pages/AssayEntry';
import ScheduleBoard from '../pages/ScheduleBoard';
import ExportView from '../pages/ExportView';

/** 路由路径常量：全项目唯一来源，避免手写字符串不一致 */
export const ROUTES = {
  ponds: '/ponds',
  gates: '/gates',
  observations: '/observations',
  assays: '/assays',
  schedules: '/schedules',
  export: '/export',
} as const;

/** 导航项（侧边栏消费） */
export const NAV_ITEMS = [
  { path: ROUTES.ponds, label: '蒸发池台账', hint: '池系 · 阶段 · 当期密度' },
  { path: ROUTES.gates, label: '闸门串级', hint: '走向拓扑 · 开度就地编辑' },
  { path: ROUTES.observations, label: '卤水日观测', hint: '密度 · 温度 · 蒸发量' },
  { path: ROUTES.assays, label: '离子组分', hint: '达标判定 · 组分曲线' },
  { path: ROUTES.schedules, label: '走水编排', hint: '拖拽排序 · 出卤推进' },
  { path: ROUTES.export, label: '晒程汇总', hint: '进度 · JSON 导入导出' },
] as const;

export function AppRouter() {
  return (
    <Router root={App}>
      <Route path="/" component={() => <Navigate href={ROUTES.ponds} />} />
      <Route path={ROUTES.ponds} component={PondList} />
      <Route path={ROUTES.gates} component={GateConfig} />
      <Route path={ROUTES.observations} component={ObservationEntry} />
      <Route path={ROUTES.assays} component={AssayEntry} />
      <Route path={ROUTES.schedules} component={ScheduleBoard} />
      <Route path={ROUTES.export} component={ExportView} />
      <Route path="*" component={() => <Navigate href={ROUTES.ponds} />} />
    </Router>
  );
}

export default AppRouter;
