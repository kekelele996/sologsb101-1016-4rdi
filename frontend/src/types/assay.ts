/**
 * 离子组分分析（Assay）
 * 记录 Li⁺ / K⁺ / Mg²⁺ / Na⁺ 浓度并给出达标判定，达标的池自动进入出卤候选。
 */

/** 达标判定：未达标 / 接近 / 达标 */
export type AssayVerdict = '未达标' | '接近' | '达标'

export const ASSAY_VERDICT_OPTIONS: AssayVerdict[] = ['未达标', '接近', '达标']

export interface Assay {
  id: string
  /** 所属蒸发池 */
  pondId: string
  /** 取样日期 YYYY-MM-DD */
  date: string
  /** Li⁺（g/L） */
  liGpl: number
  /** K⁺（g/L） */
  kGpl: number
  /** Mg²⁺（g/L） */
  mgGpl: number
  /** Na⁺（g/L） */
  naGpl: number
  /** 化验室 */
  labName: string
  /** 达标判定（默认自动判定，可人工覆盖） */
  verdict: AssayVerdict
  /** 判定是否被人工覆盖 */
  verdictManual: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑离子组分分析的表单草稿 */
export interface AssayDraft {
  pondId: string
  date: string
  liGpl: number
  kGpl: number
  mgGpl: number
  naGpl: number
  labName: string
  verdict: AssayVerdict
  verdictManual: boolean
}
