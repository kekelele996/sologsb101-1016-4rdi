/**
 * 蒸发池状态管理（Solid 原生能力）
 * 用 createStore 维护池列表与当前池系；通过 Dexie liveQuery 订阅全量数据。
 */
import { createMemo, createRoot, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { Pond, PondDraft, PondStage } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule } from '../types/schedule';
import { DB_SCHEMA_VERSION, ROW_REVISION, countAll, db, initDatabase, putPond, removePond } from '../utils/db';
import { effectiveVerdict, pondVolumeM3 } from '../utils/brine';
import { nowIso, uuid } from '../utils/id';

/** 单口池的派生统计，供 /ponds、/gates、/export 复用 */
export interface PondStat {
  pondId: string;
  /** 最近观测日期 */
  lastObservationDate: string;
  /** 当期密度（最近一次观测） */
  currentDensity: number;
  /** 最近蒸发量（mm/d） */
  lastEvapMm: number;
  /** 观测条数 */
  observationCount: number;
  /** 有效体积（m³） */
  volumeM3: number;
  /** 上游闸门数 */
  inboundGates: number;
  /** 下游闸门数 */
  outboundGates: number;
  /** 最近组分判定 */
  lastVerdict: string;
  /** 是否进入出卤候选（最近化验达标） */
  dischargeReady: boolean;
  /** 走水计划条数 */
  scheduleCount: number;
}

interface PondState {
  ponds: Pond[];
  gates: Gate[];
  observations: Observation[];
  assays: Assay[];
  schedules: Schedule[];
  currentSeries: string | null;
  loading: boolean;
  ready: boolean;
  error: string;
  counts: Record<string, number>;
}

const SERIES_KEY = 'gbbrinepond:currentSeries';

function readSeries(): string | null {
  try {
    const raw = window.localStorage.getItem(SERIES_KEY);
    return raw === null || raw === '' ? null : raw;
  } catch {
    return null;
  }
}

function writeSeries(value: string | null): void {
  try {
    window.localStorage.setItem(SERIES_KEY, value ?? '');
  } catch {
    /* 隐私模式下写入失败时静默降级 */
  }
}

function createPondStore() {
  const [state, setState] = createStore<PondState>({
    ponds: [],
    gates: [],
    observations: [],
    assays: [],
    schedules: [],
    currentSeries: readSeries(),
    loading: true,
    ready: false,
    error: '',
    counts: {},
  });

  const [revision, setRevision] = createSignal(0);
  const [pondFilters, setPondFilters] = createSignal<{ keyword: string; stage: PondStage | 'all' }>({
    keyword: '',
    stage: 'all',
  });
  let subscribed = false;

  async function loadAll(): Promise<void> {
    setState('loading', true);
    setState('error', '');
    try {
      await initDatabase();
      if (!subscribed) {
        subscribed = true;
        liveQuery(async () => {
          const [ponds, gates, observations, assays, schedules] = await Promise.all([
            db.ponds.toArray(),
            db.gates.toArray(),
            db.observations.toArray(),
            db.assays.toArray(),
            db.schedules.toArray(),
          ]);
          return { ponds, gates, observations, assays, schedules };
        }).subscribe({
          next: ({ ponds, gates, observations, assays, schedules }) => {
            const sorted = [...ponds].sort(
              (a, b) => a.seriesName.localeCompare(b.seriesName, 'zh-Hans-CN') || a.code.localeCompare(b.code),
            );
            setState({
              ponds: sorted,
              gates,
              observations: [...observations].sort((a, b) => a.date.localeCompare(b.date)),
              assays: [...assays].sort((a, b) => a.date.localeCompare(b.date)),
              schedules: [...schedules].sort((a, b) => a.orderIndex - b.orderIndex),
              loading: false,
              ready: true,
              error: '',
            });
            const seriesList = Array.from(new Set(sorted.map((pond) => pond.seriesName)));
            if (state.currentSeries === null || !seriesList.includes(state.currentSeries)) {
              setCurrentSeries(seriesList.length > 0 ? seriesList[0] : null);
            }
          },
          error: (err: unknown) => {
            setState({ loading: false, error: err instanceof Error ? err.message : '读取蒸发池数据失败' });
          },
        });
      }
      await refreshCounts();
    } catch (err) {
      setState({ loading: false, error: err instanceof Error ? err.message : '初始化本地数据库失败' });
    }
  }

  const seriesOptions = createMemo<string[]>(() => {
    const set = new Set(state.ponds.map((pond) => pond.seriesName));
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  });

  const stats = createMemo<Record<string, PondStat>>(() => {
    const result: Record<string, PondStat> = {};
    state.ponds.forEach((pond) => {
      const pondObs = state.observations
        .filter((row) => row.pondId === pond.id)
        .sort((a, b) => a.date.localeCompare(b.date));
      const latestObs = pondObs.length > 0 ? pondObs[pondObs.length - 1] : null;
      const pondAssays = state.assays
        .filter((row) => row.pondId === pond.id)
        .sort((a, b) => a.date.localeCompare(b.date));
      const latestAssay = pondAssays.length > 0 ? pondAssays[pondAssays.length - 1] : null;
      const verdict = latestAssay === null ? '—' : effectiveVerdict(latestAssay);
      result[pond.id] = {
        pondId: pond.id,
        lastObservationDate: latestObs === null ? '' : latestObs.date,
        currentDensity: latestObs === null ? 0 : latestObs.densityGcm3,
        lastEvapMm: latestObs === null ? 0 : latestObs.evapMm,
        observationCount: pondObs.length,
        volumeM3: pondVolumeM3(pond.areaM2, pond.depthCm),
        inboundGates: state.gates.filter((gate) => gate.toPondId === pond.id).length,
        outboundGates: state.gates.filter((gate) => gate.fromPondId === pond.id).length,
        lastVerdict: verdict,
        dischargeReady: verdict === '达标',
        scheduleCount: state.schedules.filter((row) => row.pondId === pond.id).length,
      };
    });
    return result;
  });

  function statOf(pondId: string): PondStat {
    return (
      stats()[pondId] ?? {
        pondId,
        lastObservationDate: '',
        currentDensity: 0,
        lastEvapMm: 0,
        observationCount: 0,
        volumeM3: 0,
        inboundGates: 0,
        outboundGates: 0,
        lastVerdict: '—',
        dischargeReady: false,
        scheduleCount: 0,
      }
    );
  }

  function setCurrentSeries(series: string | null): void {
    setState('currentSeries', series);
    writeSeries(series);
  }

  function patchFilters(patch: Partial<{ keyword: string; stage: PondStage | 'all' }>): void {
    setPondFilters({ ...pondFilters(), ...patch });
  }

  function resetFilters(): void {
    setPondFilters({ keyword: '', stage: 'all' });
    setCurrentSeries(seriesOptions().length > 0 ? seriesOptions()[0] : null);
  }

  async function createPond(draft: PondDraft): Promise<Pond> {
    const stamp = nowIso();
    const row: Pond = {
      id: uuid('pond'),
      code: draft.code.trim() || '未命名池',
      seriesName: draft.seriesName.trim() || '未分配池系',
      areaM2: draft.areaM2,
      depthCm: draft.depthCm,
      stage: draft.stage,
      status: draft.status,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putPond(row);
    // 新建后必须让这口池在 /ponds 立即可见：列表受「池系」筛选约束，
    // 若新池属于另一个池系（或当前关键字/阶段筛选把它排除），会被整口隐藏。
    // 因此把当前池系切到新池所属池系，并清空关键字与阶段筛选。
    patchFilters({ keyword: '', stage: 'all' });
    setCurrentSeries(row.seriesName);
    setRevision(revision() + 1);
    return row;
  }

  async function updatePond(pondId: string, draft: PondDraft): Promise<void> {
    const existing = state.ponds.find((pond) => pond.id === pondId);
    if (existing === undefined) return;
    await putPond({
      ...existing,
      code: draft.code.trim() || existing.code,
      seriesName: draft.seriesName.trim() || existing.seriesName,
      areaM2: draft.areaM2,
      depthCm: draft.depthCm,
      stage: draft.stage,
      status: draft.status,
    });
    setRevision(revision() + 1);
  }

  async function deletePond(pondId: string): Promise<void> {
    await removePond(pondId);
    await refreshCounts();
    setRevision(revision() + 1);
  }

  async function refreshCounts(): Promise<void> {
    const result = await countAll();
    setState('counts', { ...result, schemaVersion: DB_SCHEMA_VERSION });
  }

  function pondsOfSeries(series: string | null): Pond[] {
    if (series === null) return state.ponds;
    return state.ponds.filter((pond) => pond.seriesName === series);
  }

  /** 池列表筛选条件（关键字 + 阶段），池系由 currentSeries 承载 */
  const visiblePonds = createMemo<Pond[]>(() => {
    const current = pondFilters();
    const keyword = current.keyword.trim().toLowerCase();
    return pondsOfSeries(state.currentSeries).filter((pond) => {
      if (current.stage !== 'all' && pond.stage !== current.stage) return false;
      if (keyword === '') return true;
      return (
        pond.code.toLowerCase().includes(keyword) ||
        pond.seriesName.toLowerCase().includes(keyword) ||
        pond.status.toLowerCase().includes(keyword)
      );
    });
  });

  function stageDistribution(): Record<PondStage, number> {
    const result = { 钠盐: 0, 钾盐: 0, 锂盐: 0 } as Record<PondStage, number>;
    state.ponds.forEach((pond) => {
      result[pond.stage] += 1;
    });
    return result;
  }

  return {
    state,
    revision,
    seriesOptions,
    stats,
    statOf,
    pondsOfSeries,
    visiblePonds,
    pondFilters,
    patchFilters,
    resetFilters,
    stageDistribution,
    loadAll,
    setCurrentSeries,
    createPond,
    updatePond,
    deletePond,
    refreshCounts,
  };
}

const store = createRoot(createPondStore);

/** 供页面消费：只读 store 暴露的 Accessor 与 action */
export function usePondStore() {
  return store;
}
