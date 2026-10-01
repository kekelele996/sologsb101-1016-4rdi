/**
 * 蒸发池（Pond）
 * 盐田内的一口蒸发池，按池系组织，按阶段（钠盐 / 钾盐 / 锂盐）推进卤水晒程。
 */

/** 蒸发阶段：钠盐 / 钾盐 / 锂盐 */
export type PondStage = '钠盐' | '钾盐' | '锂盐'

/** 运行状态：在用 / 停用 / 清池中 */
export type PondStatus = '在用' | '停用' | '清池中'

export const POND_STAGE_OPTIONS: PondStage[] = ['钠盐', '钾盐', '锂盐']
export const POND_STATUS_OPTIONS: PondStatus[] = ['在用', '停用', '清池中']

export interface Pond {
  id: string
  /** 池号 */
  code: string
  /** 所属池系 */
  seriesName: string
  /** 面积（㎡） */
  areaM2: number
  /** 有效水深（cm） */
  depthCm: number
  /** 蒸发阶段 */
  stage: PondStage
  /** 运行状态 */
  status: PondStatus
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑蒸发池的表单草稿 */
export interface PondDraft {
  code: string
  seriesName: string
  areaM2: number
  depthCm: number
  stage: PondStage
  status: PondStatus
}
