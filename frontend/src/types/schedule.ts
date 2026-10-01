/**
 * 走水编排（Schedule）
 * 按日期排序的走水与出卤计划，可通过拖拽调整先后顺序。
 * 计划日期不再是孤立字段：调度台按池系串级走向与最近观测重算
 * 每条计划的预计出卤日期与可用水量；闸门开度或日观测变化后，
 * 受影响的计划标记为「待重算」并给出新日期，调度员手工锁过日期的
 * 计划保住原日期、只提示冲突。
 */

/** 走水状态：待排 / 已排 / 走水中 / 已出卤 */
export type ScheduleState = '待排' | '已排' | '走水中' | '已出卤'

export const SCHEDULE_STATE_OPTIONS: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/** 状态推进顺序 */
export const SCHEDULE_STATE_FLOW: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/** 重算状态：待重算 / 已算好（重算中途失败后按侧重试，只重算待重算的计划） */
export type RecalcState = '待重算' | '已算好'

export const RECALC_STATE_OPTIONS: RecalcState[] = ['待重算', '已算好']

/** 计划重算时快照的闸门开度（用于与闸门工记录的实际开度按池号核对） */
export interface OpeningSnapshotItem {
  gateId: string
  /** 上游池 */
  fromPondId: string
  /** 下游池（即计划所属池） */
  toPondId: string
  /** 重算时的开度（%） */
  openingPct: number
}

export interface Schedule {
  id: string
  /** 所属蒸发池 */
  pondId: string
  /** 计划走水日期 YYYY-MM-DD */
  planDate: string
  /** 目标密度（g/cm³） */
  targetDensity: number
  /** 计划量（m³） */
  volumeM3: number
  /** 调度员 */
  operator: string
  /** 走水状态 */
  state: ScheduleState
  /** 手工拖拽后的排序序号，越小越先走水 */
  orderIndex: number
  /** 调度员手工锁过日期：重算时保住 planDate，只提示冲突 */
  lockedDate: boolean
  /** 重算状态：待重算 / 已算好 */
  recalcState: RecalcState
  /** 按池系串级走向与最近观测外推的预计出卤日期 YYYY-MM-DD */
  expectedDate: string
  /** 预计出卤时的可用水量（m³）：当前蓄水 + 预计来水 − 蒸发耗水 */
  availableVolumeM3: number
  /** 最近一次重算时快照的各上游闸门开度 */
  openingSnapshot: OpeningSnapshotItem[]
  /** 锁日期时：预计出卤日期与计划日期是否冲突 */
  conflict: boolean
  /** 冲突说明（如「预计出卤 2026-09-26，早于计划日期 6 天」） */
  conflictNote: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑走水编排的表单草稿 */
export interface ScheduleDraft {
  pondId: string
  planDate: string
  targetDensity: number
  volumeM3: number
  operator: string
  state: ScheduleState
  orderIndex: number
  /** 手工锁定计划日期（重算时保住原日期） */
  lockedDate: boolean
}
