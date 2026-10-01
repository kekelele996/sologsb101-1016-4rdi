/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbbrinepond
 * - v1：建立全部表与 pondId+date 复合索引
 * - v2：新增 evapMm 字段并写入升级迁移逻辑，旧记录自动补齐默认值
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { DataSide, Schedule, ScheduleCalcStatus, ScheduleState } from '../types/schedule';
import { estimateEvapMm } from './brine';
import { affectedPondIdsByGate, downstreamPondIds, type ForecastSuccess } from './forecast';
import { nowIso } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbbrinepond';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class BrinePondDatabase extends Dexie {
  ponds!: Table<Pond, string>;
  gates!: Table<Gate, string>;
  observations!: Table<Observation, string>;
  assays!: Table<Assay, string>;
  schedules!: Table<Schedule, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：建立全部表与 pondId+date 复合索引 ----------
    this.version(1).stores({
      ponds: 'id, code, seriesName, stage, status, createdAt',
      gates: 'id, fromPondId, toPondId, state',
      observations: 'id, pondId, date, [pondId+date], densityGcm3',
      assays: 'id, pondId, date, [pondId+date], verdict',
      schedules: 'id, pondId, planDate, state, orderIndex',
    });

    // ---------- v2：新增 evapMm 字段，并为旧记录补齐默认值 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('ponds'),
          tx.table('gates'),
          tx.table('observations'),
          tx.table('assays'),
          tx.table('schedules'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：卤水观测新增 evapMm，旧记录按密度/温度/水位/风力经验公式补齐
        await tx.table('observations').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.evapMm === 'number' && Number.isFinite(row.evapMm)) return;
          row.evapMm = estimateEvapMm(
            typeof row.densityGcm3 === 'number' ? row.densityGcm3 : 1.02,
            typeof row.tempC === 'number' ? row.tempC : 25,
            typeof row.levelCm === 'number' ? row.levelCm : 40,
            typeof row.windLevel === 'number' ? row.windLevel : 2,
          );
        });
        // 迁移 3：化验记录补齐人工覆盖标记
        await tx.table('assays').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.verdictManual !== 'boolean') row.verdictManual = false;
        });
        // 迁移 4：走水编排补齐排序序号（按计划日期兜底生成）
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.orderIndex !== 'number') {
            const date = typeof row.planDate === 'string' ? row.planDate : '2026-01-01';
            row.orderIndex = Number(date.replace(/-/g, '')) || 1;
          }
        });
      });

    // ---------- v3：走水计划接入串级推算（预计出卤日期 / 可用水量 / 重算状态 / 日期锁定 / 开度对账） ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex, calcStatus, calcSide',
      })
      .upgrade(async (tx) => {
        // 老计划补齐串级推算字段：默认未锁日期、待重算，由调度台按侧统一重算
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.dateLocked !== 'boolean') row.dateLocked = false;
          if (typeof row.forecastDate !== 'string') row.forecastDate = '';
          if (typeof row.availableWaterM3 !== 'number') row.availableWaterM3 = 0;
          if (row.calcStatus !== '已算好' && row.calcStatus !== '重算失败') row.calcStatus = '待重算';
          if (typeof row.calcSide !== 'string') row.calcSide = '';
          if (typeof row.calcError !== 'string') row.calcError = '';
          if (typeof row.calculatedAt !== 'string') row.calculatedAt = '';
          if (typeof row.basisGateOpenings !== 'object' || row.basisGateOpenings === null) row.basisGateOpenings = {};
          if (typeof row.mismatchConfirmedAt !== 'string') row.mismatchConfirmedAt = '';
        });
      });
  }
}

export const db = new BrinePondDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.ponds.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/* -------------------------------- 蒸发池 -------------------------------- */

export async function listPonds(): Promise<Pond[]> {
  const rows = await db.ponds.toArray();
  return rows.sort((a, b) => a.seriesName.localeCompare(b.seriesName, 'zh-Hans-CN') || a.code.localeCompare(b.code));
}

export async function putPond(row: Pond): Promise<void> {
  await db.transaction('rw', db.ponds, db.schedules, async () => {
    const previous = await db.ponds.get(row.id);
    await db.ponds.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
    // 面积 / 水深变化会改变池容上限（可用水量随之变化），本池未完成计划待重算
    if (
      previous !== undefined &&
      (previous.areaM2 !== row.areaM2 || previous.depthCm !== row.depthCm)
    ) {
      await markSchedulesStaleByPonds([row.id]);
    }
  });
}

/** 删除蒸发池，并级联清理相关闸门、观测、化验与走水计划 */
export async function removePond(id: string): Promise<void> {
  await db.transaction('rw', db.ponds, db.gates, db.observations, db.assays, db.schedules, async () => {
    const gates = await db.gates.toArray();
    const related = gates.filter((gate) => gate.fromPondId === id || gate.toPondId === id).map((gate) => gate.id);
    if (related.length > 0) await db.gates.bulkDelete(related);
    await db.observations.where('pondId').equals(id).delete();
    await db.assays.where('pondId').equals(id).delete();
    await db.schedules.where('pondId').equals(id).delete();
    await db.ponds.delete(id);
  });
}

/* -------------------------------- 闸门 -------------------------------- */

export async function listGates(): Promise<Gate[]> {
  return db.gates.toArray();
}

/**
 * 新建 / 保存闸门。
 * 闸门走向（上/下游池）或开度变化会影响整段下游池，相关走水计划标成待重算；
 * 已出卤的历史计划不再变动，调度员手工锁过日期的计划只标记、不改日期。
 */
export async function putGate(row: Gate): Promise<void> {
  await db.transaction('rw', db.gates, db.schedules, async () => {
    const previous = await db.gates.get(row.id);
    await db.gates.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
    const allGates = await db.gates.toArray();
    const affected = new Set<string>(affectedPondIdsByGate(row, allGates));
    if (previous !== undefined) {
      affectedPondIdsByGate(previous, allGates).forEach((id) => affected.add(id));
    }
    await markSchedulesStaleByPonds([...affected]);
  });
}

/**
 * 就地调整开度：同步推导闸门状态，并把开度变化沿串级传播——
 * 受影响池的未完成计划标成待重算，返回受影响计划条数。
 */
export async function updateGateOpening(id: string, openingPct: number, state: Gate['state']): Promise<number> {
  const stamp = nowIso();
  return db.transaction('rw', db.gates, db.schedules, async () => {
    const updated = await db.gates.update(id, { openingPct, state, updatedAt: stamp });
    if (updated === 0) return 0;
    const [gate, gates] = await Promise.all([db.gates.get(id), db.gates.toArray()]);
    if (gate === undefined) return 0;
    // 开度变化影响本闸上游池本身（外排能力）与沿串级的全部下游池（进水量）
    const pondIds = Array.from(new Set([gate.fromPondId, ...downstreamPondIds(gate.fromPondId, gates)]));
    return markSchedulesStaleByPonds(pondIds, stamp);
  });
}

/** 删除闸门：走向断开后，原下游链路上的未完成计划标成待重算 */
export async function removeGate(id: string): Promise<void> {
  await db.transaction('rw', db.gates, db.schedules, async () => {
    const gate = await db.gates.get(id);
    if (gate !== undefined) {
      const others = (await db.gates.toArray()).filter((item) => item.id !== id);
      const pondIds = affectedPondIdsByGate(gate, others);
      await markSchedulesStaleByPonds(pondIds);
    }
    await db.gates.delete(id);
  });
}

/* ------------------------------ 卤水日观测 ------------------------------ */

export async function listObservations(): Promise<Observation[]> {
  const rows = await db.observations.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listObservationsByPond(pondId: string): Promise<Observation[]> {
  const rows = await db.observations.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 写入卤水日观测：同池同日仅保留一条（存在即覆盖原记录）。
 * evapMm 若未显式给出，则按经验公式自动估算。
 * 最近观测一变，本池（及沿串级的下游池）的预计出卤日期与可用水量随之变化，
 * 相关未完成计划标成待重算。
 */
export async function upsertObservation(row: Observation): Promise<Observation> {
  const evapMm =
    Number.isFinite(row.evapMm) && row.evapMm > 0
      ? row.evapMm
      : estimateEvapMm(row.densityGcm3, row.tempC, row.levelCm, row.windLevel);
  return db.transaction('rw', db.observations, db.schedules, db.gates, async () => {
    const existing = await db.observations.where('[pondId+date]').equals([row.pondId, row.date]).first();
    const next: Observation = {
      ...row,
      id: existing === undefined ? row.id : existing.id,
      evapMm,
      createdAt: existing === undefined ? row.createdAt : existing.createdAt,
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    };
    await db.observations.put(next);
    const gates = await db.gates.toArray();
    // 本池密度变化直接影响本池出卤；本池水位变化还会影响经本池下泄的下游进水量
    await markSchedulesStaleByPonds(downstreamPondIds(row.pondId, gates));
    return next;
  });
}

export async function removeObservation(id: string): Promise<void> {
  await db.observations.delete(id);
}

/* ------------------------------ 离子组分分析 ------------------------------ */

export async function listAssays(): Promise<Assay[]> {
  const rows = await db.assays.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listAssaysByPond(pondId: string): Promise<Assay[]> {
  const rows = await db.assays.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function putAssay(row: Assay): Promise<void> {
  await db.assays.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeAssay(id: string): Promise<void> {
  await db.assays.delete(id);
}

/* ------------------------------ 走水编排 ------------------------------ */

export async function listSchedules(): Promise<Schedule[]> {
  const rows = await db.schedules.toArray();
  return rows.sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate));
}

/** 重算字段缺省补齐，兼容旧存档 / 外部导入的 v2 结构 */
export function normalizeSchedule(row: Partial<Schedule> & Pick<Schedule, 'id' | 'pondId'>): Schedule {
  return {
    planDate: row.planDate ?? '2026-01-01',
    targetDensity: row.targetDensity ?? 0,
    volumeM3: row.volumeM3 ?? 0,
    operator: row.operator ?? '',
    state: row.state ?? '待排',
    orderIndex: row.orderIndex ?? 1,
    dateLocked: row.dateLocked ?? false,
    forecastDate: row.forecastDate ?? '',
    availableWaterM3: row.availableWaterM3 ?? 0,
    calcStatus: row.calcStatus ?? '待重算',
    calcSide: (row.calcSide ?? '') as DataSide | '',
    calcError: row.calcError ?? '',
    calculatedAt: row.calculatedAt ?? '',
    basisGateOpenings: row.basisGateOpenings ?? {},
    mismatchConfirmedAt: row.mismatchConfirmedAt ?? '',
    createdAt: row.createdAt ?? nowIso(),
    updatedAt: row.updatedAt ?? nowIso(),
    revision: row.revision ?? ROW_REVISION,
    ...row,
  } as Schedule;
}

export async function putSchedule(row: Schedule): Promise<void> {
  await db.schedules.put({ ...normalizeSchedule(row), updatedAt: nowIso(), revision: ROW_REVISION });
}

/**
 * 把给定池集合上的未完成计划标成待重算。
 * - 已出卤（已完成）的历史计划不动；
 * - 手工锁定日期的计划同样标记，重算时保住 planDate、只提示冲突；
 * - 清空上轮失败原因与开度确认标记（闸门又动过，旧确认失效）。
 * 返回被标记的计划条数。
 */
export async function markSchedulesStaleByPonds(pondIds: string[], stamp = nowIso()): Promise<number> {
  if (pondIds.length === 0) return 0;
  const rows = await db.schedules.where('pondId').anyOf(pondIds).toArray();
  const targets = rows.filter((row) => row.state !== '已出卤' && row.calcStatus !== '待重算');
  await Promise.all(
    targets.map((row) =>
      db.schedules.update(row.id, {
        calcStatus: '待重算' as ScheduleCalcStatus,
        calcSide: '',
        calcError: '',
        mismatchConfirmedAt: '',
        updatedAt: stamp,
      }),
    ),
  );
  return targets.length;
}

/** 保存一次成功重算：锁定日期的计划保住 planDate，只刷新预计日期与可用水量 */
export async function applyScheduleForecast(
  scheduleId: string,
  forecast: ForecastSuccess,
  options: { dateLocked: boolean; planDate?: string },
): Promise<void> {
  const patch: Partial<Schedule> = {
    forecastDate: forecast.forecastDate,
    availableWaterM3: forecast.availableWaterM3,
    calcStatus: '已算好',
    calcSide: '',
    calcError: '',
    calculatedAt: nowIso(),
    basisGateOpenings: forecast.basisGateOpenings,
    mismatchConfirmedAt: '',
  };
  if (options.dateLocked) {
    // 手工锁过日期：原日期不动，只记录新的预计日期供冲突提示
  } else if (options.planDate !== undefined) {
    patch.planDate = options.planDate;
  }
  await db.schedules.update(scheduleId, patch);
}

/** 保存一次失败重算：记录责任侧与原因，已算好的日期/水量字段原样保留 */
export async function applyScheduleFailure(scheduleId: string, side: DataSide, reason: string): Promise<void> {
  await db.schedules.update(scheduleId, {
    calcStatus: '重算失败',
    calcSide: side,
    calcError: reason,
    updatedAt: nowIso(),
  });
}

/** 手工锁定 / 解锁计划日期（解锁本身不改任何日期） */
export async function setScheduleDateLocked(scheduleId: string, dateLocked: boolean): Promise<void> {
  await db.schedules.update(scheduleId, { dateLocked, updatedAt: nowIso() });
}

/** 确认本计划与闸门开度记录的短时不一致：按池号对账后不再提示，闸门再动会重新挂起 */
export async function confirmScheduleMismatch(scheduleId: string, stamp = nowIso()): Promise<void> {
  await db.schedules.update(scheduleId, { mismatchConfirmedAt: stamp, updatedAt: stamp });
}

export async function removeSchedule(id: string): Promise<void> {
  await db.schedules.delete(id);
}

/** 按给定 id 顺序重写排序序号（拖拽排序后调用） */
export async function reorderSchedules(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.schedules, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.schedules.update(orderedIds[index], { orderIndex: index + 1, updatedAt: nowIso() });
    }
  });
}

/**
 * 出卤完成回写：把蒸发池推进到下一阶段，并把最新一次观测的密度对齐到实际密度。
 */
export async function applyDischarge(scheduleId: string, actualDensity: number): Promise<void> {
  await db.transaction('rw', db.ponds, db.schedules, db.observations, async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule) return;
    await db.schedules.update(scheduleId, { state: '已出卤', updatedAt: nowIso() });
    const pond = await db.ponds.get(schedule.pondId);
    if (!pond) return;
    const nextStage: Pond['stage'] = pond.stage === '钠盐' ? '钾盐' : pond.stage === '钾盐' ? '锂盐' : '锂盐';
    await db.ponds.update(pond.id, { stage: nextStage, updatedAt: nowIso() });
    const list = await db.observations.where('pondId').equals(pond.id).toArray();
    if (list.length === 0) return;
    const latest = list.reduce((acc, item) => (item.date > acc.date ? item : acc));
    const density = actualDensity > 0 ? actualDensity : latest.densityGcm3;
    await db.observations.update(latest.id, {
      densityGcm3: density,
      evapMm: estimateEvapMm(density, latest.tempC, latest.levelCm, latest.windLevel),
      updatedAt: nowIso(),
    });
  });
}

/** 推进走水状态 */
export async function advanceScheduleState(scheduleId: string, next: ScheduleState, actualDensity: number): Promise<void> {
  if (next === '已出卤') {
    await applyDischarge(scheduleId, actualDensity);
    return;
  }
  await db.schedules.update(scheduleId, { state: next, updatedAt: nowIso() });
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  ponds: Pond[];
  gates: Gate[];
  observations: Observation[];
  assays: Assay[];
  schedules: Schedule[];
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [ponds, gates, observations, assays, schedules] = await Promise.all([
    db.ponds.toArray(),
    db.gates.toArray(),
    db.observations.toArray(),
    db.assays.toArray(),
    db.schedules.toArray(),
  ]);
  return { name: DB_NAME, schemaVersion: DB_SCHEMA_VERSION, exportedAt: nowIso(), ponds, gates, observations, assays, schedules };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', db.ponds, db.gates, db.observations, db.assays, db.schedules, async () => {
    await Promise.all([
      db.ponds.clear(),
      db.gates.clear(),
      db.observations.clear(),
      db.assays.clear(),
      db.schedules.clear(),
    ]);
    await db.ponds.bulkPut(snapshot.ponds.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.gates.bulkPut(snapshot.gates.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.observations.bulkPut(snapshot.observations.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.assays.bulkPut(snapshot.assays.map((row) => ({ ...row, revision: ROW_REVISION })));
    // 兼容 v2 存档：补齐串级推算字段后，未算过的计划统一挂起为待重算
    await db.schedules.bulkPut(
      snapshot.schedules.map((row) => {
        const normalized = normalizeSchedule(row);
        return {
          ...normalized,
          calcStatus: normalized.calculatedAt === '' && normalized.forecastDate === '' ? '待重算' : normalized.calcStatus,
          revision: ROW_REVISION,
        };
      }),
    );
  });
}

export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', db.ponds, db.gates, db.observations, db.assays, db.schedules, async () => {
    await Promise.all([
      db.ponds.clear(),
      db.gates.clear(),
      db.observations.clear(),
      db.assays.clear(),
      db.schedules.clear(),
    ]);
  });
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [ponds, gates, observations, assays, schedules] = await Promise.all([
    db.ponds.count(),
    db.gates.count(),
    db.observations.count(),
    db.assays.count(),
    db.schedules.count(),
  ]);
  return { ponds, gates, observations, assays, schedules };
}
