/**
 * 走水编排（Schedule）
 * 按日期排序的走水与出卤计划，可通过拖拽调整先后顺序。
 * 计划日期与可用水量由「闸门串级走向 + 卤水日观测」推算：
 * - 闸门开度 / 观测变化后受影响计划标记为「待重算」；
 * - 调度员手工锁定日期的计划重算不改日期，只提示冲突；
 * - 重算失败按责任侧（闸门侧 / 调度侧）重试。
 */

/** 走水状态：待排 / 已排 / 走水中 / 已出卤 */
export type ScheduleState = '待排' | '已排' | '走水中' | '已出卤'

export const SCHEDULE_STATE_OPTIONS: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/** 状态推进顺序 */
export const SCHEDULE_STATE_FLOW: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/** 重算状态：已算好 / 待重算 / 重算失败 */
export type ScheduleCalcStatus = '已算好' | '待重算' | '重算失败'

export const SCHEDULE_CALC_STATUS_OPTIONS: ScheduleCalcStatus[] = ['已算好', '待重算', '重算失败']

/** 数据责任侧：闸门侧（闸门工管开度） / 调度侧（调度台管计划与观测依据） */
export type DataSide = '闸门侧' | '调度侧'

export const DATA_SIDE_OPTIONS: DataSide[] = ['闸门侧', '调度侧']

export interface Schedule {
  id: string
  /** 所属蒸发池 */
  pondId: string
  /** 计划走水日期 YYYY-MM-DD（未锁定时重算会改写为预计出卤日期） */
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
  /** 调度员手工锁定日期：锁定后任何重算都保住 planDate，只提示与预计日期冲突 */
  dateLocked: boolean
  /** 预计出卤日期 YYYY-MM-DD（按最近观测日期外推） */
  forecastDate: string
  /** 预计可用水量（m³，按串级进水量 × 到达目标密度天数估算） */
  availableWaterM3: number
  /** 重算状态 */
  calcStatus: ScheduleCalcStatus
  /** 最近一次重算失败的责任侧（成功后为空串），失败后按侧批量重试 */
  calcSide: DataSide | ''
  /** 最近一次重算失败原因 */
  calcError: string
  /** 最近一次成功重算时间 ISO */
  calculatedAt: string
  /** 上次成功重算时参考的闸门开度快照：gateId -> openingPct（闸门工记录允许短时不一致） */
  basisGateOpenings: Record<string, number>
  /** 开度不一致已确认时间 ISO（闸门再次调整后自动失效，空串表示未确认） */
  mismatchConfirmedAt: string
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
  /** 新建/编辑时是否手工锁定计划日期 */
  dateLocked: boolean
}
