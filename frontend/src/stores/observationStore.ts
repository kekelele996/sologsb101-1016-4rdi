/**
 * 卤水日观测状态管理（Solid 原生能力）
 * 用 createSignal 维护筛选条件与派生统计，供 /observations、/assays、/schedules 共用。
 */
import { createMemo, createRoot, createSignal } from 'solid-js';
import { liveQuery } from 'dexie';
import type { Observation } from '../types/observation';
import { db, initDatabase, upsertObservation } from '../utils/db';
import { round1 } from '../utils/brine';
import { nowIso, today, uuid } from '../utils/id';
import type { ObservationDraft } from '../types/observation';
import { useScheduleStore } from './scheduleStore';

/** 观测筛选条件（关键字 + 池系 + 日期区间），同步到 URL query */
export interface ObservationFilters {
  keyword: string;
  seriesName: string | 'all';
  from: string;
  to: string;
}

const EMPTY_FILTERS: ObservationFilters = { keyword: '', seriesName: 'all', from: '', to: '' };

/** 批量录入的一行 */
export interface BatchRow {
  pondCode: string;
  date: string;
  densityGcm3: number;
  tempC: number;
  levelCm: number;
  windLevel: number;
}

function createObservationStore() {
  const [filters, setFilters] = createSignal<ObservationFilters>({ ...EMPTY_FILTERS });
  const [rows, setRows] = createSignal<Observation[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [lastMessage, setLastMessage] = createSignal('');

  // 建库/播种必须在 liveQuery 的 querier **之外**发起：
  // Dexie liveQuery 依赖「同一次微任务作用域」内的读操作来采集可观测性集合
  // （observability set）。若在 querier 里先 `await initDatabase()` 再查询，
  // 查询落在 await 之后的另一个微任务里，采集不到表/索引范围，
  // 数据库变更时 obsSetsOverlap 判定为空 → 订阅只产出一次结果、此后永不重查，
  // 表现为「观测条数」与新写入的记录都不刷新（整页刷新才正确）。
  // index.tsx 已 `void initDatabase()`，此处再次调用共用同一个 Promise（幂等）。
  void initDatabase();

  liveQuery(async () => {
    return db.observations.toArray();
  }).subscribe({
    next: (list) => {
      setRows([...list].sort((a, b) => b.date.localeCompare(a.date)));
      setLoading(false);
      setError('');
    },
    error: (err: unknown) => {
      setError(err instanceof Error ? err.message : '读取观测数据失败');
      setLoading(false);
    },
  });

  function patchFilters(patch: Partial<ObservationFilters>): void {
    setFilters({ ...filters(), ...patch });
  }

  function resetFilters(): void {
    setFilters({ ...EMPTY_FILTERS });
  }

  /** 滤波后的观测记录（供页面直接消费） */
  const visible = createMemo<Observation[]>(() => {
    const current = filters();
    const keyword = current.keyword.trim().toLowerCase();
    return rows().filter((row) => {
      if (current.from !== '' && row.date < current.from) return false;
      if (current.to !== '' && row.date > current.to) return false;
      if (keyword === '') return true;
      return row.date.includes(keyword) || String(row.densityGcm3).includes(keyword);
    });
  });

  /** 派生统计：观测条数、平均蒸发量、平均密度、最近观测日期 */
  const stats = createMemo(() => {
    const list = visible();
    if (list.length === 0) {
      return { count: 0, avgEvapMm: 0, avgDensity: 0, latestDate: '', latestDensity: 0, totalEvapMm: 0 };
    }
    const totalEvap = list.reduce((acc, row) => acc + row.evapMm, 0);
    const totalDensity = list.reduce((acc, row) => acc + row.densityGcm3, 0);
    const latest = list.reduce((acc, row) => (row.date > acc.date ? row : acc));
    return {
      count: list.length,
      avgEvapMm: round1(totalEvap / list.length),
      avgDensity: Math.round((totalDensity / list.length) * 1000) / 1000,
      latestDate: latest.date,
      latestDensity: latest.densityGcm3,
      totalEvapMm: round1(totalEvap),
    };
  });

  /** 批量录入：同池同日覆盖写入 */
  async function batchUpsert(ponds: Array<{ id: string; code: string }>, list: BatchRow[]): Promise<number> {
    let count = 0;
    const affectedPondIds = new Set<string>();
    for (const row of list) {
      const pond = ponds.find((item) => item.code === row.pondCode);
      if (pond === undefined) continue;
      const stamp = nowIso();
      const draft: Observation = {
        id: uuid('obs'),
        pondId: pond.id,
        date: row.date === '' ? today() : row.date,
        densityGcm3: row.densityGcm3,
        tempC: row.tempC,
        levelCm: row.levelCm,
        windLevel: row.windLevel,
        evapMm: 0,
        createdAt: stamp,
        updatedAt: stamp,
        revision: 2,
      };
      await upsertObservation(draft);
      affectedPondIds.add(pond.id);
      count += 1;
    }
    setLastMessage(count === 0 ? '没有可写入的行，请检查池号是否正确' : `已批量写入 ${count} 条卤水日观测`);
    // 观测变化后，相关池的走水计划标记待重算并按串级重算预计出卤日期
    if (count > 0) {
      const scheduleStore = useScheduleStore();
      for (const pondId of affectedPondIds) {
        await scheduleStore.notifyObservationChanged(pondId);
      }
    }
    return count;
  }

  /** 单条保存（同池同日覆盖） */
  async function saveOne(draft: ObservationDraft): Promise<Observation> {
    const stamp = nowIso();
    const row = await upsertObservation({
      id: uuid('obs'),
      pondId: draft.pondId,
      date: draft.date,
      densityGcm3: draft.densityGcm3,
      tempC: draft.tempC,
      levelCm: draft.levelCm,
      windLevel: draft.windLevel,
      evapMm: draft.evapMm,
      createdAt: stamp,
      updatedAt: stamp,
      revision: 2,
    });
    setLastMessage(`已保存 ${row.date} 的观测记录（同池同日自动覆盖）`);
    // 最近观测是预计出卤日期的外推依据，保存后重算该池计划
    const scheduleStore = useScheduleStore();
    await scheduleStore.notifyObservationChanged(row.pondId);
    return row;
  }

  return {
    filters,
    patchFilters,
    resetFilters,
    rows,
    visible,
    stats,
    loading,
    error,
    lastMessage,
    setLastMessage,
    batchUpsert,
    saveOne,
  };
}

const store = createRoot(createObservationStore);

export function useObservationStore() {
  return store;
}
