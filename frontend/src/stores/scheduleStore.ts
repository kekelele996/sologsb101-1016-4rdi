/**
 * 走水编排状态管理（Solid 原生能力）
 * 用 createStore 维护走水顺序与状态推进；出卤完成后回写池阶段与实际密度。
 * 计划日期不是孤立字段：闸门开度或卤水日观测变化后，受影响的计划标记为
 「待重算」，调度台按池系串级走向与最近观测重算预计出卤日期与可用水量；
 * 调度员手工锁过日期的计划保住原日期，只提示冲突。
 * 重算按池系分侧推进：一侧失败不影响另一侧，重跑时只补算仍为「待重算」
 * 的计划（算好的计划不再生成）。
 */
import { createEffect, createRoot, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { Gate } from '../types/gate';
import type { Schedule, ScheduleDraft, ScheduleState } from '../types/schedule';
import { SCHEDULE_STATE_FLOW } from '../types/schedule';
import {
  advanceScheduleState,
  db,
  initDatabase,
  markSchedulesStale,
  putSchedule,
  removeSchedule,
  reorderSchedules,
} from '../utils/db';
import { nowIso, uuid } from '../utils/id';
import {
  downstreamPondIds,
  recalcSchedule,
  sortPondsByCascade,
  type RecalcContext,
} from '../utils/scheduleCalc';
import { usePondStore } from './pondStore';

/** 走水编排筛选条件 */
export interface ScheduleFilters {
  keyword: string;
  seriesName: string | 'all';
  state: ScheduleState | 'all';
}

const EMPTY_FILTERS: ScheduleFilters = { keyword: '', seriesName: 'all', state: 'all' };

interface ScheduleState_ {
  rows: Schedule[];
  loading: boolean;
  error: string;
  lastMessage: string;
}

/** 一次重算的结果汇总（按侧统计，失败的留给下次重试） */
export interface RecalcSummary {
  computed: number;
  failed: number;
  skipped: number;
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
  /** 是否正在重算（按钮与自动重算共用，避免并发） */
  const [recalculating, setRecalculating] = createSignal(false);

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

  const pondStore = usePondStore();

  /** 组装重算上下文：池、闸门串级、最近观测 */
  function buildContext(): RecalcContext {
    return {
      ponds: pondStore.state.ponds,
      gates: pondStore.state.gates,
      observations: pondStore.state.observations,
    };
  }

  /** 把指定池的未出卤计划标记为待重算（已出卤的不再生成） */
  async function markStale(pondIds: string[]): Promise<void> {
    if (pondIds.length === 0) return;
    const ids = state.rows
      .filter((row) => pondIds.includes(row.pondId) && row.state !== '已出卤' && row.recalcState === '已算好')
      .map((row) => row.id);
    await markSchedulesStale(ids);
  }

  /**
   * 重算一个池系（一侧）内所有「待重算」计划。
   * 按串级走向排序（上游优先），逐条重算、逐条落库；单条失败跳过并计数，
   * 不阻断本侧其余计划 —— 重跑时仍为「待重算」的会被重试，已算好的不再生成。
   */
  async function recalcSeries(seriesName: string): Promise<RecalcSummary> {
    const summary: RecalcSummary = { computed: 0, failed: 0, skipped: 0 };
    const ctx = buildContext();
    const seriesPondIds = ctx.ponds.filter((pond) => pond.seriesName === seriesName).map((pond) => pond.id);
    const cascadeOrder = sortPondsByCascade(seriesPondIds, ctx.gates);
    const targets = state.rows
      .filter(
        (row) =>
          row.state !== '已出卤' &&
          row.recalcState === '待重算' &&
          seriesPondIds.includes(row.pondId),
      )
      .sort((a, b) => {
        const ra = cascadeOrder.indexOf(a.pondId);
        const rb = cascadeOrder.indexOf(b.pondId);
        return ra - rb || a.orderIndex - b.orderIndex;
      });
    for (const row of targets) {
      try {
        const outcome = recalcSchedule(row, ctx);
        await putSchedule({
          ...row,
          expectedDate: outcome.expectedDate,
          availableVolumeM3: outcome.availableVolumeM3,
          openingSnapshot: outcome.openingSnapshot,
          conflict: outcome.conflict,
          conflictNote: outcome.conflictNote,
          recalcState: '已算好',
        });
        summary.computed += 1;
      } catch {
        // 单条重算失败：保留「待重算」状态，留给下一次按侧重试
        summary.failed += 1;
      }
    }
    summary.skipped = state.rows.filter(
      (row) => row.state !== '已出卤' && row.recalcState === '已算好' && seriesPondIds.includes(row.pondId),
    ).length;
    return summary;
  }

  /**
   * 重算全部池系：按池系分侧，各侧独立 try/catch，
   * 一侧失败不影响另一侧；汇总已算好 / 失败待重试条数。
   */
  async function recalcAll(manual = false): Promise<RecalcSummary> {
    if (recalculating()) return { computed: 0, failed: 0, skipped: 0 };
    setRecalculating(true);
    const total: RecalcSummary = { computed: 0, failed: 0, skipped: 0 };
    const failedSeries: string[] = [];
    try {
      const seriesList = pondStore.seriesOptions();
      for (const seriesName of seriesList) {
        try {
          const part = await recalcSeries(seriesName);
          total.computed += part.computed;
          total.failed += part.failed;
        } catch {
          // 一侧整体失败：记下池系，其余池系继续
          failedSeries.push(seriesName);
        }
      }
      if (total.failed > 0 || failedSeries.length > 0) {
        setState(
          'lastMessage',
          `重算完成：${total.computed} 条已算好，${total.failed + failedSeries.length} 条失败待重试（仍为「待重算」，可再次重算）`,
        );
      } else if (total.computed > 0) {
        setState('lastMessage', `已按池系串级走向与最近观测重算 ${total.computed} 条计划的预计出卤日期与可用水量`);
      } else if (manual) {
        setState('lastMessage', `没有需要重算的计划（${total.skipped} 条均已算好）`);
      }
    } finally {
      setRecalculating(false);
    }
    return total;
  }

  /** 闸门开度变化：下游沿串级受影响的计划标记待重算，然后按侧重算 */
  async function notifyGateChanged(gate: Gate): Promise<void> {
    const affected = Array.from(downstreamPondIds(gate.toPondId, pondStore.state.gates));
    await markStale(affected);
    await recalcAll();
  }

  /** 卤水日观测变化：该池计划标记待重算，然后按侧重算 */
  async function notifyObservationChanged(pondId: string): Promise<void> {
    await markStale([pondId]);
    await recalcAll();
  }

  // 首屏数据就绪后自动重算一次：播种的旧计划均为「待重算」，
  // 打开编排台即可看到按串级走向与最近观测算出的预计出卤日期与可用水量。
  let autoTried = false;
  createEffect(() => {
    if (autoTried) return;
    if (!pondStore.state.ready || state.rows.length === 0) return;
    const hasStale = state.rows.some((row) => row.state !== '已出卤' && row.recalcState === '待重算');
    if (!hasStale) {
      autoTried = true;
      return;
    }
    autoTried = true;
    void recalcAll();
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
      lockedDate: draft.lockedDate,
      recalcState: '待重算',
      expectedDate: '',
      availableVolumeM3: 0,
      openingSnapshot: [],
      conflict: false,
      conflictNote: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    await putSchedule(row);
    setState('lastMessage', `已新建走水计划：${row.planDate}，正在按串级走向重算预计出卤日期`);
    void recalcAll();
    return row;
  }

  async function updateSchedule(scheduleId: string, draft: ScheduleDraft): Promise<void> {
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined) return;
    const lockedOff = existing.lockedDate && !draft.lockedDate;
    await putSchedule({
      ...existing,
      pondId: draft.pondId,
      planDate: draft.planDate,
      targetDensity: draft.targetDensity,
      volumeM3: draft.volumeM3,
      operator: draft.operator.trim(),
      state: draft.state,
      orderIndex: draft.orderIndex,
      lockedDate: draft.lockedDate,
      // 编辑后统一标记待重算；解锁后重算会给出新日期，锁着则保住原日期
      recalcState: '待重算',
      conflict: false,
      conflictNote: '',
    });
    setState('lastMessage', lockedOff ? '走水计划已更新，日期锁定已解除，等待重算' : '走水计划已更新，已标记待重算');
    await recalcAll();
  }

  async function deleteSchedule(scheduleId: string): Promise<void> {
    await removeSchedule(scheduleId);
    setState('lastMessage', '走水计划已删除');
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
    recalculating,
    setMessage,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    advance,
    moveBefore,
    moveToIndex,
    recalcAll,
    recalcSeries,
    markStale,
    notifyGateChanged,
    notifyObservationChanged,
  };
}

const store = createRoot(createScheduleStore);

export function useScheduleStore() {
  return store;
}
