/**
 * 走水计划串级重算工具（纯函数）
 * 把闸门串级（Gate）、卤水日观测（Observation）与走水编排（Schedule）接起来：
 * - 沿串级走向求闸门开度变化的下游影响范围
 * - 按最近观测的密度增速外推到达目标密度的天数，给出预计出卤日期
 * - 按上游来水与蒸发耗水估算可用水量
 * - 快照计划开度，与闸门工记录的实际开度按池号核对
 * 纯函数不读写数据库，重算的持久化编排在 scheduleStore 中。
 */
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Pond } from '../types/pond';
import type { OpeningSnapshotItem, Schedule } from '../types/schedule';
import { estimateInflowM3, pondVolumeM3, round1, round3 } from './brine';
import { addDays, daysBetween } from './id';

/** 观测不足、无法外推密度增速时的兜底增速（g/cm³/天） */
export const FALLBACK_DENSITY_RATE = 0.002;

/** 来水稀释指数上限：闸门全开时净增速最多被稀释到观测增速的 15% */
const MAX_DILUTION = 0.85;
const MIN_NET_RATE_FACTOR = 0.15;

/** 线性回归斜率（最小二乘），单位 g/cm³/天；观测不足时返回兜底增速 */
export function densityRatePerDay(observations: Observation[]): number {
  const list = observations
    .filter((row) => row.densityGcm3 > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (list.length < 2) return FALLBACK_DENSITY_RATE;
  const firstDate = new Date(`${list[0].date}T00:00:00`).getTime();
  const points = list.map((row) => ({
    x: (new Date(`${row.date}T00:00:00`).getTime() - firstDate) / 86400000,
    y: row.densityGcm3,
  }));
  const n = points.length;
  const sumX = points.reduce((acc, p) => acc + p.x, 0);
  const sumY = points.reduce((acc, p) => acc + p.y, 0);
  const sumXY = points.reduce((acc, p) => acc + p.x * p.y, 0);
  const sumXX = points.reduce((acc, p) => acc + p.x * p.x, 0);
  const denominator = n * sumXX - sumX * sumX;
  if (denominator <= 0) return FALLBACK_DENSITY_RATE;
  const slope = (n * sumXY - sumX * sumY) / denominator;
  if (!Number.isFinite(slope) || slope <= 0) return FALLBACK_DENSITY_RATE;
  return round3(slope);
}

/** 某池的最近一条观测 */
export function latestObservationOf(observations: Observation[], pondId: string): Observation | null {
  const list = observations
    .filter((row) => row.pondId === pondId)
    .sort((a, b) => a.date.localeCompare(b.date));
  return list.length === 0 ? null : list[list.length - 1];
}

/** 闸门工视角：某池上游所有进水闸门的预计进水合计（m³/d） */
export function inflowOfPond(
  pondId: string,
  gates: Gate[],
  observations: Observation[],
): number {
  return round1(
    gates
      .filter((gate) => gate.toPondId === pondId)
      .reduce((acc, gate) => {
        const upstream = latestObservationOf(observations, gate.fromPondId);
        const levelCm = upstream === null ? 40 : upstream.levelCm;
        return acc + estimateInflowM3(gate, levelCm);
      }, 0),
  );
}

/**
 * 沿串级走向求下游影响范围：从某池出发，经出闸闸门向下游逐池传递。
 * 用于「上游开度一变，受影响的计划标成待重算」。
 */
export function downstreamPondIds(sourcePondId: string, gates: Gate[]): Set<string> {
  const affected = new Set<string>();
  const queue: string[] = [sourcePondId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    gates
      .filter((gate) => gate.fromPondId === current)
      .forEach((gate) => {
        if (!affected.has(gate.toPondId)) {
          affected.add(gate.toPondId);
          queue.push(gate.toPondId);
        }
      });
  }
  return affected;
}

/** 串级拓扑序：上游池（进水闸少、来水靠上游）排在前面，同层按池号稳定排序 */
export function cascadeRank(pondId: string, gates: Gate[]): number {
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOf = (id: string): number => {
    if (memo.has(id)) return memo.get(id) as number;
    if (visiting.has(id)) return 0; // 异常环路兜底，避免死循环
    visiting.add(id);
    const inbound = gates.filter((gate) => gate.toPondId === id);
    const rank = inbound.length === 0 ? 0 : 1 + Math.max(...inbound.map((gate) => rankOf(gate.fromPondId)));
    visiting.delete(id);
    memo.set(id, rank);
    return rank;
  };
  return rankOf(pondId);
}

/** 按串级走向排序池 id：上游优先，同级按池号 */
export function sortPondsByCascade(pondIds: string[], gates: Gate[]): string[] {
  return [...pondIds].sort((a, b) => {
    const ra = cascadeRank(a, gates);
    const rb = cascadeRank(b, gates);
    return ra - rb || a.localeCompare(b, 'zh-Hans-CN');
  });
}

export interface RecalcContext {
  ponds: Pond[];
  gates: Gate[];
  observations: Observation[];
}

export interface RecalcOutcome {
  expectedDate: string;
  availableVolumeM3: number;
  openingSnapshot: OpeningSnapshotItem[];
  conflict: boolean;
  conflictNote: string;
}

/**
 * 重算单条走水计划。
 * 预计出卤日期：以最近观测密度为起点，按密度增速外推到达目标密度的天数，
 * 并按上游来水的稀释作用折减净增速（开度越小、来水越少，浓缩越快）。
 * 可用水量：当前蓄水 + 预计来水 − 蒸发耗水，封顶不超过池体有效容积。
 */
export function recalcSchedule(row: Schedule, ctx: RecalcContext): RecalcOutcome {
  const pond = ctx.ponds.find((item) => item.id === row.pondId);
  const pondObs = ctx.observations
    .filter((item) => item.pondId === row.pondId)
    .sort((a, b) => a.date.localeCompare(b.date));
  const latest = pondObs.length > 0 ? pondObs[pondObs.length - 1] : null;

  const openingSnapshot: OpeningSnapshotItem[] = ctx.gates
    .filter((gate) => gate.toPondId === row.pondId)
    .map((gate) => ({ gateId: gate.id, fromPondId: gate.fromPondId, toPondId: gate.toPondId, openingPct: gate.openingPct }));

  const capacityM3 = pond === undefined ? 0 : pondVolumeM3(pond.areaM2, pond.depthCm);
  const fallbackLevelCm = pond === undefined ? 40 : pond.depthCm;
  const levelCm = latest === null ? fallbackLevelCm : latest.levelCm;
  const storedM3 = pond === undefined ? 0 : pondVolumeM3(pond.areaM2, levelCm);

  const inflowM3 = inflowOfPond(row.pondId, ctx.gates, ctx.observations);
  const evapMm = latest === null ? 0 : latest.evapMm;
  const evapM3 = pond === undefined ? 0 : (pond.areaM2 * (evapMm / 1000));

  let expectedDate = '';
  let availableVolumeM3 = storedM3;

  if (latest !== null && pond !== undefined) {
    const rate = densityRatePerDay(pondObs);
    // 来水稀释：日来水占（日来水 + 日蒸发）的比例越高，净浓缩越慢
    const dilution = evapM3 + inflowM3 > 0 ? Math.min(MAX_DILUTION, inflowM3 / (inflowM3 + evapM3)) : 0;
    const netRate = rate * (MIN_NET_RATE_FACTOR + (1 - MIN_NET_RATE_FACTOR) * (1 - dilution));
    const gap = row.targetDensity - latest.densityGcm3;
    const daysToTarget = gap <= 0 ? 0 : Math.ceil(gap / netRate);
    expectedDate = addDays(latest.date, daysToTarget);
    const projected = storedM3 + inflowM3 * daysToTarget - evapM3 * daysToTarget;
    availableVolumeM3 = Math.round(Math.max(0, Math.min(capacityM3, projected)) * 10) / 10;
  }

  let conflict = false;
  let conflictNote = '';
  if (row.lockedDate && expectedDate !== '') {
    const diff = daysBetween(row.planDate, expectedDate);
    if (diff !== 0) {
      conflict = true;
      const rel = diff > 0 ? '晚于' : '早于';
      conflictNote = `预计出卤 ${expectedDate}，${rel}计划日期 ${row.planDate} 共 ${Math.abs(diff)} 天；已锁定计划日期，按原日期执行`;
    }
  }

  return { expectedDate, availableVolumeM3: round1(availableVolumeM3), openingSnapshot, conflict, conflictNote };
}

/** 计划开度与闸门工实际开度的核对差异（按池号列出） */
export interface OpeningMismatch {
  pondId: string;
  pondCode: string;
  gateId: string;
  gateLabel: string;
  planOpeningPct: number;
  actualOpeningPct: number;
}

/**
 * 列出开度对不上的闸门：计划快照开度 ≠ 闸门工当前记录开度。
 * 两边各自管好本侧数据，差异按池号列出供确认，不互相覆盖。
 */
export function findOpeningMismatches(
  schedules: Schedule[],
  gates: Gate[],
  ponds: Pond[],
): OpeningMismatch[] {
  const result: OpeningMismatch[] = [];
  const seen = new Set<string>();
  schedules.forEach((row) => {
    if (row.state === '已出卤') return;
    row.openingSnapshot.forEach((snap) => {
      const gate = gates.find((item) => item.id === snap.gateId);
      if (gate === undefined) return;
      if (gate.openingPct === snap.openingPct) return;
      const key = `${row.pondId}:${gate.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      const pond = ponds.find((item) => item.id === row.pondId);
      const fromPond = ponds.find((item) => item.id === gate.fromPondId);
      result.push({
        pondId: row.pondId,
        pondCode: pond?.code ?? '（池已删除）',
        gateId: gate.id,
        gateLabel: `${fromPond?.code ?? '?'} → ${pond?.code ?? '?'}`,
        planOpeningPct: snap.openingPct,
        actualOpeningPct: gate.openingPct,
      });
    });
  });
  return result.sort((a, b) => a.pondCode.localeCompare(b.pondCode, 'zh-Hans-CN'));
}
