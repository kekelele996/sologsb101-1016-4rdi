/**
 * 卤水计算工具
 * - 密度—温度修正
 * - 蒸发量经验公式与密度增速
 * - 离子当量换算与达标判定
 * - 池体积与闸门过流估算
 */
import type { Assay, AssayVerdict } from '../types/assay';
import type { Gate } from '../types/gate';

/** 保留 1 位小数 */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 保留 3 位小数 */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 参考温度（℃） */
export const REFERENCE_TEMP_C = 25;

/** 卤水密度温度修正系数（1/℃），温度升高密度下降 */
export const DENSITY_TEMP_COEFF = 0.00035;

/**
 * 密度—温度修正：把实测密度折算到 25 ℃ 参考温度下的密度。
 * density(25) = density(t) + coeff × (t - 25)
 */
export function correctDensity(densityGcm3: number, tempC: number): number {
  return round3(densityGcm3 + DENSITY_TEMP_COEFF * (tempC - REFERENCE_TEMP_C));
}

/** 蒸发量经验公式基准值（mm/d） */
export const EVAP_BASE_MM = 5.5;

/**
 * 蒸发量经验估算（mm/d）
 * 温度越高、风力越大蒸发越强；卤水密度越高、水活度越低蒸发越弱。
 */
export function estimateEvapMm(
  densityGcm3: number,
  tempC: number,
  levelCm: number,
  windLevel: number,
): number {
  if (!Number.isFinite(densityGcm3) || densityGcm3 <= 0) return 0;
  const tempFactor = 1 + Math.max(0, tempC - 10) * 0.022;
  const windFactor = 1 + Math.max(0, windLevel) * 0.06;
  const brineFactor = Math.max(0.15, Math.min(1.2, 1 - (densityGcm3 - 1.02) * 0.9));
  // 水位低于 10 cm 时按比例折减，避免浅池出现不合理的大蒸发量
  const levelFactor = levelCm >= 10 ? 1 : Math.max(0.3, levelCm / 10);
  return round1(EVAP_BASE_MM * tempFactor * windFactor * brineFactor * levelFactor);
}

/** 密度增速（g/cm³/天） */
export function densityGrowthRate(previousDensity: number, currentDensity: number, days: number): number {
  if (days <= 0) return 0;
  return round3((currentDensity - previousDensity) / days);
}

/** 池体有效体积（m³）= 面积 × 有效水深 */
export function pondVolumeM3(areaM2: number, depthCm: number): number {
  return Math.round(areaM2 * (depthCm / 100) * 10) / 10;
}

/** 闸门过流面积（㎡）= 口宽(m) × 开度对应水深(m) */
export function gateFlowAreaM2(gate: Pick<Gate, 'widthCm' | 'openingPct'>): number {
  const widthM = gate.widthCm / 100;
  const openM = (gate.openingPct / 100) * 0.6;
  return Math.round(widthM * openM * 100) / 100;
}

/**
 * 下游预计进水量（m³/d）
 * 由过流面积、上游水位与开度共同决定，作为开度调整后的即时反馈。
 */
export function estimateInflowM3(
  gate: Pick<Gate, 'widthCm' | 'openingPct' | 'state'>,
  upstreamLevelCm: number,
): number {
  if (gate.state === '关闭' || gate.openingPct <= 0) return 0;
  const area = gateFlowAreaM2(gate);
  const headM = Math.max(0.05, upstreamLevelCm / 100);
  // 简易堰流公式系数，仅用于量级估算
  const flow = 1.7 * area * Math.sqrt(headM) * (gate.openingPct / 100) * 86400 / 10;
  return Math.round(flow * 10) / 10;
}

/** 按开度推导闸门状态 */
export function stateFromOpening(openingPct: number): Gate['state'] {
  if (openingPct <= 0) return '关闭';
  if (openingPct >= 95) return '全开';
  return '半开';
}

/** 离子当量换算（meq/L）：Li⁺=6.94, K⁺=39.10, Mg²⁺=12.15, Na⁺=23.00 */
export function ionEquivalent(liGpl: number, kGpl: number, mgGpl: number, naGpl: number): number {
  const li = liGpl / 6.94;
  const k = kGpl / 39.1;
  const mg = (mgGpl / 12.15) * 2;
  const na = naGpl / 23;
  return round1(li + k + mg + na);
}

/** 出卤达标阈值：Li⁺ 与 K⁺ 双指标 */
export const ASSAY_THRESHOLD = {
  liPass: 1.0,
  liNear: 0.6,
  kPass: 20,
  kNear: 12,
} as const;

/** 自动达标判定：Li⁺ 与 K⁺ 均达标为「达标」，任一项接近为「接近」，否则「未达标」 */
export function autoVerdict(liGpl: number, kGpl: number): AssayVerdict {
  const liPass = liGpl >= ASSAY_THRESHOLD.liPass;
  const kPass = kGpl >= ASSAY_THRESHOLD.kPass;
  if (liPass && kPass) return '达标';
  const liNear = liGpl >= ASSAY_THRESHOLD.liNear;
  const kNear = kGpl >= ASSAY_THRESHOLD.kNear;
  if ((liPass || liNear) && (kPass || kNear)) return '接近';
  return '未达标';
}

/** 取化验记录的实际判定（人工覆盖优先） */
export function effectiveVerdict(assay: Pick<Assay, 'verdict' | 'verdictManual' | 'liGpl' | 'kGpl'>): AssayVerdict {
  if (assay.verdictManual) return assay.verdict;
  return autoVerdict(assay.liGpl, assay.kGpl);
}

/** 密度是否达到目标（用于判断走水是否可以出卤） */
export function densityReached(currentDensity: number, targetDensity: number): boolean {
  return currentDensity >= targetDensity;
}
