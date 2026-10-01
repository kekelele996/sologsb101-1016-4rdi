/**
 * 蒸发量与密度增速派生 hook
 * 按池与日期区间计算蒸发量与密度增速，返回 Solid Accessor 供页面订阅。
 */
import { createMemo, createSignal, onCleanup, type Accessor } from 'solid-js';
import { liveQuery } from 'dexie';
import type { Observation } from '../types/observation';
import { db, initDatabase } from '../utils/db';
import { correctDensity, densityGrowthRate, round1, round3 } from '../utils/brine';
import { daysBetween } from '../utils/id';

/** 单个观测点的派生数据 */
export interface EvaporationPoint {
  observationId: string;
  date: string;
  densityGcm3: number;
  /** 折算到 25 ℃ 的密度 */
  correctedDensity: number;
  tempC: number;
  levelCm: number;
  windLevel: number;
  evapMm: number;
}

/** 某口池在给定日期区间内的蒸发与浓缩汇总 */
export interface EvaporationSummary {
  pondId: string;
  points: EvaporationPoint[];
  /** 区间累计蒸发量（mm） */
  totalEvapMm: number;
  /** 区间日均蒸发量（mm/d） */
  avgEvapMm: number;
  /** 密度增速（g/cm³/天） */
  densityRatePerDay: number;
  /** 最近实测密度 */
  latestDensity: number;
  /** 最近修正密度 */
  latestCorrectedDensity: number;
  /** 按当前增速外推 horizonDays 天后的预计密度 */
  forecastDensity: number;
  /** 观测跨度天数 */
  spanDays: number;
}

export interface UseEvaporationOptions {
  from?: Accessor<string>;
  to?: Accessor<string>;
  /** 外推天数，默认 10 天 */
  horizonDays?: number;
}

export interface UseEvaporationResult {
  summary: Accessor<EvaporationSummary>;
  loading: Accessor<boolean>;
  error: Accessor<string>;
}

function emptySummary(pondId: string, horizonDays: number): EvaporationSummary {
  void horizonDays;
  return {
    pondId,
    points: [],
    totalEvapMm: 0,
    avgEvapMm: 0,
    densityRatePerDay: 0,
    latestDensity: 0,
    latestCorrectedDensity: 0,
    forecastDensity: 0,
    spanDays: 0,
  };
}

/** 纯函数：由观测记录派生蒸发与浓缩汇总 */
export function buildEvaporationSummary(
  pondId: string,
  observations: Observation[],
  from: string,
  to: string,
  horizonDays: number,
): EvaporationSummary {
  if (pondId === '') return emptySummary('', horizonDays);
  const list = observations
    .filter((row) => row.pondId === pondId)
    .filter((row) => (from === '' || row.date >= from) && (to === '' || row.date <= to))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (list.length === 0) return emptySummary(pondId, horizonDays);

  const points: EvaporationPoint[] = list.map((row) => ({
    observationId: row.id,
    date: row.date,
    densityGcm3: row.densityGcm3,
    correctedDensity: correctDensity(row.densityGcm3, row.tempC),
    tempC: row.tempC,
    levelCm: row.levelCm,
    windLevel: row.windLevel,
    evapMm: row.evapMm,
  }));

  const first = list[0];
  const last = list[list.length - 1];
  const spanDays = Math.max(0, daysBetween(first.date, last.date));
  const totalEvapMm = round1(list.reduce((acc, row) => acc + row.evapMm, 0));
  const avgEvapMm = round1(totalEvapMm / list.length);
  const densityRatePerDay = densityGrowthRate(first.densityGcm3, last.densityGcm3, spanDays);
  const forecastDays = spanDays > 0 ? spanDays + horizonDays : horizonDays;

  return {
    pondId,
    points,
    totalEvapMm,
    avgEvapMm,
    densityRatePerDay,
    latestDensity: last.densityGcm3,
    latestCorrectedDensity: correctDensity(last.densityGcm3, last.tempC),
    forecastDensity: round3(last.densityGcm3 + densityRatePerDay * Math.max(0, forecastDays - spanDays)),
    spanDays,
  };
}

/**
 * 订阅全部卤水日观测，按池与日期区间派生蒸发量与密度增速。
 */
export function useEvaporation(
  pondId: Accessor<string | null>,
  options: UseEvaporationOptions = {},
): UseEvaporationResult {
  const horizonDays = options.horizonDays ?? 10;
  const [observations, setObservations] = createSignal<Observation[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');

  const subscription = liveQuery(async () => {
    await initDatabase();
    return db.observations.toArray();
  }).subscribe({
    next: (list) => {
      setObservations(list);
      setLoading(false);
      setError('');
    },
    error: (err: unknown) => {
      setError(err instanceof Error ? err.message : '读取蒸发量数据失败');
      setLoading(false);
    },
  });

  onCleanup(() => {
    subscription.unsubscribe();
  });

  const summary = createMemo<EvaporationSummary>(() =>
    buildEvaporationSummary(
      pondId() ?? '',
      observations(),
      options.from === undefined ? '' : options.from(),
      options.to === undefined ? '' : options.to(),
      horizonDays,
    ),
  );

  return { summary, loading, error };
}
