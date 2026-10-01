/**
 * 晒程串级推算引擎（纯函数，不读写 IndexedDB）
 *
 * 把三块数据接起来：闸门串级走向（Gate/Pond）× 卤水日观测（Observation）
 * × 走水编排（Schedule），为每条计划算出：
 * - 预计出卤日期：按最近观测的密度增速外推到目标密度所需天数；
 * - 可用水量：沿串级到达本池的日进水量 × 到达目标密度天数。
 *
 * 失败原因固定分两个责任侧，调度台据此按侧重试：
 * - 闸门侧：串级上缺闸门 / 闸门全关，问题由闸门工处理；
 * - 调度侧：池缺失 / 没有观测 / 密度无增长，问题由调度侧补数据。
 */
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Pond } from '../types/pond';
import type { DataSide, Schedule } from '../types/schedule';
import { addDays, daysBetween } from './id';
import { estimateInflowM3, pondVolumeM3 } from './brine';

/** 进水稀释对密度增速的折减系数：进水量相当于 1 倍池容时，浓缩天数拉长 40% */
const INFLOW_DILUTION_FACTOR = 0.4;

/** 重算失败的结构化结果 */
export interface ForecastFailure {
  ok: false;
  /** 责任侧：按侧批量重试时用 */
  side: DataSide;
  reason: string;
}

/** 重算成功的结构化结果 */
export interface ForecastSuccess {
  ok: true;
  /** 预计出卤日期 YYYY-MM-DD */
  forecastDate: string;
  /** 预计可用水量（m³） */
  availableWaterM3: number;
  /** 到达目标密度还需天数（向上取整，当天为 0） */
  daysToTarget: number;
  /** 日进水量合计（m³/d），沿串级所有上游通道求和 */
  dailyInflowM3: number;
  /** 推算所用闸门开度快照 gateId -> openingPct */
  basisGateOpenings: Record<string, number>;
  /** 参考的最近观测日期 */
  basisObservationDate: string;
  /** 参考的当期密度（g/cm³） */
  basisDensity: number;
}

export type ForecastResult = ForecastFailure | ForecastSuccess;

/** 沿闸门收集某池的全部直接上游池（防环，缺失池不阻断收集） */
export function upstreamPondIds(pondId: string, gates: Gate[]): string[] {
  const visited = new Set<string>([pondId]);
  const result: string[] = [];
  const queue = [pondId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const gate of gates) {
      if (gate.toPondId !== current || visited.has(gate.fromPondId)) continue;
      visited.add(gate.fromPondId);
      result.push(gate.fromPondId);
      queue.push(gate.fromPondId);
    }
  }
  return result;
}

/**
 * 沿串级收集受某池（或某闸门）影响的全部下游池（含自身）。
 * 闸门开度一变，这些池的走水计划都要标成待重算。
 */
export function downstreamPondIds(pondId: string, gates: Gate[]): string[] {
  const visited = new Set<string>([pondId]);
  const queue = [pondId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const gate of gates) {
      if (gate.fromPondId !== current || visited.has(gate.toPondId)) continue;
      visited.add(gate.toPondId);
      queue.push(gate.toPondId);
    }
  }
  return Array.from(visited);
}

/** 一条闸门连接影响的下游池集合（闸门新建/删除/改线时用） */
export function affectedPondIdsByGate(gate: Pick<Gate, 'fromPondId' | 'toPondId'>, gates: Gate[]): string[] {
  const set = new Set<string>();
  downstreamPondIds(gate.fromPondId, gates).forEach((id) => set.add(id));
  downstreamPondIds(gate.toPondId, gates).forEach((id) => set.add(id));
  return Array.from(set);
}

/**
 * 日进水量合计（m³/d）：沿串级把所有直接进入本池、且未关闭的闸门过流求和。
 * 上游水位取该上游池最近一次观测，缺观测时按 40 cm 经验水位兜底。
 */
export function inflowToPond(pondId: string, _ponds: Pond[], gates: Gate[], observations: Observation[]): number {
  return gates
    .filter((gate) => gate.toPondId === pondId)
    .reduce((acc, gate) => {
      const upstreamObs = observations
        .filter((row) => row.pondId === gate.fromPondId)
        .sort((a, b) => a.date.localeCompare(b.date));
      const level = upstreamObs.length === 0 ? 40 : upstreamObs[upstreamObs.length - 1].levelCm;
      return acc + estimateInflowM3(gate, level);
    }, 0);
}

/** 收集推算依据的直接上游闸门开度快照 */
export function basisOpeningsForPond(pondId: string, gates: Gate[]): Record<string, number> {
  const result: Record<string, number> = {};
  gates
    .filter((gate) => gate.toPondId === pondId)
    .forEach((gate) => {
      result[gate.id] = gate.openingPct;
    });
  return result;
}

/**
 * 为单条走水计划做串级推算。
 *
 * 物理量级的经验模型（仅用于调度估算）：
 * 1. 密度增速 =（末次密度 − 首次密度）/ 观测跨度天数；
 * 2. 进水会稀释卤水，按「日进水量 / 池有效体积」对浓缩天数做折减；
 * 3. 预计出卤日期 = 最近观测日期 + 到达目标密度天数；
 * 4. 可用水量 = 日进水量 × 到达天数（不超过池有效体积，源头池按池容兜底）。
 */
export function forecastSchedule(
  schedule: Pick<Schedule, 'pondId' | 'targetDensity'>,
  ponds: Pond[],
  gates: Gate[],
  observations: Observation[],
): ForecastResult {
  const pond = ponds.find((item) => item.id === schedule.pondId);
  if (pond === undefined) {
    return { ok: false, side: '调度侧', reason: '找不到对应蒸发池，无法确认串级走向' };
  }

  const pondObs = observations
    .filter((row) => row.pondId === schedule.pondId)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (pondObs.length === 0) {
    return { ok: false, side: '调度侧', reason: `${pond.code} 还没有卤水日观测，无法推算密度增速` };
  }

  const first = pondObs[0];
  const latest = pondObs[pondObs.length - 1];
  const spanDays = daysBetween(first.date, latest.date);
  if (pondObs.length < 2 || spanDays <= 0) {
    return {
      ok: false,
      side: '调度侧',
      reason: `${pond.code} 只有单日观测（${latest.date}），至少需要跨两天的两条观测才能推算增速`,
    };
  }

  const growthPerDay = (latest.densityGcm3 - first.densityGcm3) / spanDays;
  if (!(growthPerDay > 0)) {
    return {
      ok: false,
      side: '调度侧',
      reason: `${pond.code} 密度没有上升（${first.densityGcm3} → ${latest.densityGcm3}），无法外推出卤日期`,
    };
  }

  const basisGates = gates.filter((gate) => gate.toPondId === schedule.pondId);
  if (basisGates.length > 0 && basisGates.every((gate) => gate.state === '关闭' || gate.openingPct <= 0)) {
    return { ok: false, side: '闸门侧', reason: `${pond.code} 的上游闸门全部关闭，没有进水量` };
  }

  const dailyInflow = inflowToPond(schedule.pondId, ponds, gates, observations);
  const volumeM3 = pondVolumeM3(pond.areaM2, pond.depthCm);
  // 进水越多、相对于池容的稀释越强，到达目标密度的天数相应拉长
  const dilution = basisGates.length === 0 ? 0 : Math.min(1.2, (dailyInflow / Math.max(1, volumeM3)) * INFLOW_DILUTION_FACTOR);

  const remaining = schedule.targetDensity - latest.densityGcm3;
  const baseDays = remaining <= 0 ? 0 : remaining / growthPerDay;
  const daysToTarget = Math.max(0, Math.ceil(baseDays * (1 + dilution) - 1e-9));
  const forecastDate = addDays(latest.date, daysToTarget);

  const rawWater = dailyInflow * daysToTarget;
  // 源头池（无上游闸门）没有串级进水记录，可用水量按池有效体积兜底
  const availableWaterM3 =
    basisGates.length === 0
      ? volumeM3
      : Math.round(Math.max(0, Math.min(volumeM3, rawWater)) * 10) / 10;

  return {
    ok: true,
    forecastDate,
    availableWaterM3,
    daysToTarget,
    dailyInflowM3: Math.round(dailyInflow * 10) / 10,
    basisGateOpenings: basisOpeningsForPond(schedule.pondId, gates),
    basisObservationDate: latest.date,
    basisDensity: latest.densityGcm3,
  };
}

/** 闸门开度是否与计划重算时的依据不一致（闸门侧记录允许短时不一样） */
export function openingMismatch(
  schedule: Pick<Schedule, 'basisGateOpenings' | 'mismatchConfirmedAt'>,
  gates: Gate[],
  gateUpdatedAtFor?: (gateId: string) => string | undefined,
): { mismatch: boolean; changedGateIds: string[] } {
  const changedGateIds: string[] = [];
  for (const gate of gates) {
    if (!Object.prototype.hasOwnProperty.call(schedule.basisGateOpenings, gate.id)) continue;
    const basis = schedule.basisGateOpenings[gate.id];
    if (basis !== gate.openingPct) {
      const confirmedAt = schedule.mismatchConfirmedAt;
      const updatedAt = gateUpdatedAtFor?.(gate.id);
      // 确认时间晚于闸门最近一次调整，视为本轮不一致已确认，不再列出
      if (confirmedAt !== '' && updatedAt !== undefined && confirmedAt >= updatedAt) continue;
      changedGateIds.push(gate.id);
    }
  }
  return { mismatch: changedGateIds.length > 0, changedGateIds };
}

/** 手工锁定日期的计划，预计日期与计划日期不一致即为冲突（只提示，不改日期） */
export function dateConflict(schedule: Pick<Schedule, 'dateLocked' | 'planDate' | 'forecastDate' | 'calcStatus'>): boolean {
  return schedule.dateLocked && schedule.calcStatus === '已算好' && schedule.forecastDate !== '' && schedule.forecastDate !== schedule.planDate;
}
