/**
 * 闸门（Gate）
 * 连接上游池与下游池的串级通道，开度决定下游预计进水量。
 */

/** 闸门状态：关闭 / 半开 / 全开 */
export type GateState = '关闭' | '半开' | '全开'

export const GATE_STATE_OPTIONS: GateState[] = ['关闭', '半开', '全开']

export interface Gate {
  id: string
  /** 上游池 */
  fromPondId: string
  /** 下游池 */
  toPondId: string
  /** 开度（%） */
  openingPct: number
  /** 口宽（cm） */
  widthCm: number
  /** 闸门状态 */
  state: GateState
  /** 备注 */
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑闸门的表单草稿 */
export interface GateDraft {
  fromPondId: string
  toPondId: string
  openingPct: number
  widthCm: number
  state: GateState
  note: string
}
