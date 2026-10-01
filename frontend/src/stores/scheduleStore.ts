/**
 * 走水编排状态管理（Solid 原生能力）
 * 用 createStore 维护走水顺序与状态推进；出卤完成后回写池阶段与实际密度。
 *
 * 串级联动：闸门开度 / 卤日观测变化后，受影响计划在持久层已被标成「待重算」；
 * 本 store 负责按池系串级走向与最近观测重算预计出卤日期与可用水量：
 * - 未锁日期的计划重算后对齐到预计日期；
 * - 手工锁过日期的计划保住原日期，仅在页面提示日期冲突；
 * - 重算失败按责任侧（闸门侧 / 调度侧）重试，已算好的计划不再重复生成。
 */
import { createRoot, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { Schedule, ScheduleDraft, ScheduleState, DataSide } from '../types/schedule';
import { SCHEDULE_STATE_FLOW } from '../types/schedule';
import {
  advanceScheduleState,
  applyScheduleFailure,
  applyScheduleForecast,
  confirmScheduleMismatch,
  db,
  initDatabase,
  putSchedule,
  removeSchedule,
  reorderSchedules,
  setScheduleDateLocked,
} from '../utils/db';
import { forecastSchedule } from '../utils/forecast';
import { nowIso, uuid } from '../utils/id';
import { usePondStore } from './pondStore';

/** 走水编排筛选条件 */
export interface ScheduleFilters {
  keyword: string;
  seriesName: string | 'all';
  state: ScheduleState | 'all';
}

const EMPTY_FILTERS: ScheduleFilters = { keyword: '', seriesName: 'all', state: 'all' };

/** 一批重算的结果汇报（按侧重试时逐侧生成） */
export interface RecalcReport {
  total: number;
  succeeded: number;
  failed: number;
  gateSideFailed: number;
  dispatchSideFailed: number;
  messages: string[];
}

interface ScheduleState_ {
  rows: Schedule[];
  loading: boolean;
  error: string;
  lastMessage: string;
}

function createScheduleStore() {
  const [state, setState] = createStore<ScheduleState_>({
    rows: [],
    loading: true,
    error: '',
    lastMessage: '',
  });
  const [filters, setFilters] = createSignal<ScheduleFilters>({ ...EMPTY_FILTERS });
  const [draggingId, setDraggingId] = createSignal<string | null>(null);
  const [recalculating, setRecalculating] = createSignal<DataSide | 'all' | null>(null);

  // 同 observationStore：建库必须放在 querier 外，否则 liveQuery 采集不到可观测性集合，
  // 数据库变更后不会重查 —— 走水计划条数与拖拽后的顺序都不会原地刷新。
  void initDatabase();

  liveQuery(async () => {
    return db.schedules.toArray();
  }).subscribe({
    next: (list) => {
      setState('rows', [...list].sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate)));
      setState('loading', false);
      setState('error', '');
    },
    error: (err: unknown) => {
      setState({ loading: false, error: err instanceof Error ? err.message : '读取走水编排失败' });
    },
  });

  function patchFilters(patch: Partial<ScheduleFilters>): void {
    setFilters({ ...filters(), ...patch });
  }

  function resetFilters(): void {
    setFilters({ ...EMPTY_FILTERS });
  }

  function setMessage(message: string): void {
    setState('lastMessage', message);
  }

  /**
   * 对单条计划执行一次重算（逐条落库，中途失败不影响其他计划）。
   * @returns 失败责任侧；成功 / 无需重算返回 null
   */
  async function recalculateOne(scheduleId: string): Promise<DataSide | null> {
    const [schedule, ponds, gates, observations] = await Promise.all([
      db.schedules.get(scheduleId),
      db.ponds.toArray(),
      db.gates.toArray(),
      db.observations.toArray(),
    ]);
    if (schedule === undefined) return null;
    if (schedule.state === '已出卤') return null;

    const result = forecastSchedule(schedule, ponds, gates, observations);
    if (!result.ok) {
      await applyScheduleFailure(schedule.id, result.side, result.reason);
      return result.side;
    }
    // 未锁日期：计划日期对齐预计出卤日期；锁定：保住原日期，仅记录预计日期
    await applyScheduleForecast(schedule.id, result, {
      dateLocked: schedule.dateLocked,
      planDate: schedule.dateLocked ? undefined : result.forecastDate,
    });
    return null;
  }

  /**
   * 批量重算：只挑「待重算 / 重算失败」的未完成计划，已算好的计划不再生成。
   * side 给定时只重试该责任侧的失败计划（闸门侧 / 调度侧按侧重试）。
   * 逐条独立落库：重算中途失败，已经算好的条目不会回滚、下次重试也不会重复生成。
   */
  async function recalculateStale(side: DataSide | 'all' = 'all'): Promise<RecalcReport> {
    setRecalculating(side);
    try {
      const rows = await db.schedules.toArray();
      const targets = rows.filter((row) => {
        if (row.state === '已出卤') return false;
        if (row.calcStatus === '已算好') return false;
        if (side !== 'all') {
          // 待重算（尚未区分责任侧）两侧重试都要带上；失败计划只在对应侧重试
          if (row.calcStatus === '重算失败' && row.calcSide !== side) return false;
        }
        return true;
      });

      const report: RecalcReport = { total: targets.length, succeeded: 0, failed: 0, gateSideFailed: 0, dispatchSideFailed: 0, messages: [] };
      for (const row of targets) {
        // eslint-disable-next-line no-await-in-loop -- 必须逐条落库：中途失败后按侧重试，算好的不再生成
        const failedSide = await recalculateOne(row.id);
        if (failedSide === null) {
          report.succeeded += 1;
        } else {
          report.failed += 1;
          if (failedSide === '闸门侧') report.gateSideFailed += 1;
          else report.dispatchSideFailed += 1;
          report.messages.push(`${row.id}：${failedSide}失败`);
        }
      }

      if (report.total === 0) {
        setMessage(side === 'all' ? '没有需要重算的计划（已算好的计划不再生成）' : `${side}没有需要重试的计划`);
      } else {
        const parts = [`本轮${side === 'all' ? '重算' : `按${side}重试`} ${report.total} 条：成功 ${report.succeeded} 条`];
        if (report.gateSideFailed > 0) parts.push(`闸门侧待处理 ${report.gateSideFailed} 条`);
        if (report.dispatchSideFailed > 0) parts.push(`调度侧待补数据 ${report.dispatchSideFailed} 条`);
        setMessage(parts.join('，'));
      }
      return report;
    } finally {
      setRecalculating(null);
    }
  }

  /** 新建后立即按当前串级与观测做一次推算；失败也落库，挂起为待重算/失败供按侧重试 */
  async function createSchedule(draft: ScheduleDraft): Promise<Schedule> {
    const stamp = nowIso();
    const row: Schedule = {
      id: uuid('schedule'),
      pondId: draft.pondId,
      planDate: draft.planDate,
      targetDensity: draft.targetDensity,
      volumeM3: draft.volumeM3,
      operator: draft.operator.trim(),
      state: draft.state,
      orderIndex: draft.orderIndex,
      dateLocked: draft.dateLocked,
      forecastDate: '',
      availableWaterM3: 0,
      calcStatus: '待重算',
      calcSide: '',
      calcError: '',
      calculatedAt: '',
      basisGateOpenings: {},
      mismatchConfirmedAt: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    await putSchedule(row);
    const failedSide = await recalculateOne(row.id);
    if (failedSide !== null) {
      setState('lastMessage', `已新建走水计划，但重算失败（${failedSide}），已挂起到对应侧重试队列`);
    } else {
      setState('lastMessage', `已新建走水计划并完成串级推算：${row.planDate}`);
    }
    return row;
  }

  async function updateSchedule(scheduleId: string, draft: ScheduleDraft): Promise<void> {
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined) return;
    // 编辑可能改了池 / 目标密度 / 日期或锁定状态，统一按「待重算」走一遍，锁定的日期不被覆盖
    await putSchedule({
      ...existing,
      pondId: draft.pondId,
      planDate: draft.planDate,
      targetDensity: draft.targetDensity,
      volumeM3: draft.volumeM3,
      operator: draft.operator.trim(),
      state: draft.state,
      orderIndex: draft.orderIndex,
      dateLocked: draft.dateLocked,
      forecastDate: '',
      calcStatus: '待重算',
      calcSide: '',
      calcError: '',
      calculatedAt: '',
      basisGateOpenings: {},
      mismatchConfirmedAt: '',
    });
    await recalculateOne(scheduleId);
    setState('lastMessage', '走水计划已更新并重新推算');
  }

  async function deleteSchedule(scheduleId: string): Promise<void> {
    await removeSchedule(scheduleId);
    setState('lastMessage', '走水计划已删除');
  }

  async function toggleDateLock(scheduleId: string, dateLocked: boolean): Promise<void> {
    await setScheduleDateLocked(scheduleId, dateLocked);
    setState('lastMessage', dateLocked ? '已锁定计划日期：重算只更新预计日期，冲突会单独提示' : '已解除日期锁定：下次重算会对齐预计出卤日期');
  }

  async function confirmMismatch(scheduleId: string): Promise<void> {
    await confirmScheduleMismatch(scheduleId);
    setState('lastMessage', '已确认该计划与闸门开度记录的短时不一致；闸门再次调整后会重新挂起');
  }

  async function advance(scheduleId: string): Promise<ScheduleState | null> {
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined) return null;
    const index = SCHEDULE_STATE_FLOW.indexOf(existing.state);
    if (index < 0 || index >= SCHEDULE_STATE_FLOW.length - 1) return null;
    const next = SCHEDULE_STATE_FLOW[index + 1];
    const pondStore = usePondStore();
    const stat = pondStore.statOf(existing.pondId);
    const actualDensity = stat.currentDensity > 0 ? stat.currentDensity : existing.targetDensity;
    await advanceScheduleState(scheduleId, next, actualDensity);
    await pondStore.refreshCounts();
    setState(
      'lastMessage',
      next === '已出卤'
        ? `已出卤：池阶段已推进，实际密度回写为 ${actualDensity} g/cm³`
        : `状态已推进为「${next}」`,
    );
    return next;
  }

  /** 拖拽排序：把 fromId 移动到 toId 之前 */
  async function moveBefore(fromId: string, toId: string): Promise<void> {
    if (fromId === toId) return;
    const list = [...state.rows].sort((a, b) => a.orderIndex - b.orderIndex);
    const fromIndex = list.findIndex((row) => row.id === fromId);
    const toIndex = list.findIndex((row) => row.id === toId);
    if (fromIndex < 0 || toIndex < 0) return;
    const [moved] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, moved);
    await reorderSchedules(list.map((row) => row.id));
    setState('lastMessage', `已调整走水顺序：${moved.planDate} 移动到第 ${toIndex + 1} 位`);
  }

  async function moveToIndex(id: string, targetIndex: number): Promise<void> {
    const list = [...state.rows].sort((a, b) => a.orderIndex - b.orderIndex);
    const fromIndex = list.findIndex((row) => row.id === id);
    if (fromIndex < 0) return;
    const [moved] = list.splice(fromIndex, 1);
    const index = Math.max(0, Math.min(list.length, targetIndex));
    list.splice(index, 0, moved);
    await reorderSchedules(list.map((row) => row.id));
    setState('lastMessage', `已把 ${moved.planDate} 调整到第 ${index + 1} 位`);
  }

  return {
    state,
    filters,
    patchFilters,
    resetFilters,
    draggingId,
    setDraggingId,
    setMessage,
    recalculating,
    recalculateOne,
    recalculateStale,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    toggleDateLock,
    confirmMismatch,
    advance,
    moveBefore,
    moveToIndex,
  };
}

const store = createRoot(createScheduleStore);

export function useScheduleStore() {
  return store;
}
