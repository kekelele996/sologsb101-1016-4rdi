/**
 * 卤水日观测（Observation）
 * 同池同日仅保留一条；evapMm 由密度、温度、水位与风力经验公式估算。
 */
export interface Observation {
  id: string
  /** 所属蒸发池 */
  pondId: string
  /** 观测日期 YYYY-MM-DD */
  date: string
  /** 密度（g/cm³） */
  densityGcm3: number
  /** 温度（℃） */
  tempC: number
  /** 水位（cm） */
  levelCm: number
  /** 风力等级（0–8） */
  windLevel: number
  /** 估算蒸发量（mm/d）——v2 新增字段，旧记录在升级迁移中自动补齐 */
  evapMm: number
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑卤水日观测的表单草稿 */
export interface ObservationDraft {
  pondId: string
  date: string
  densityGcm3: number
  tempC: number
  levelCm: number
  windLevel: number
  evapMm: number
}
