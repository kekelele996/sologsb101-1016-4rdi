/**
 * <StageTag> 蒸发阶段标签
 * 按 钠盐 / 钾盐 / 锂盐 渲染底色与图标，被 /ponds、/gates、/assays 消费。
 */
import { Show } from 'solid-js';
import type { PondStage, PondStatus } from '../../types/pond';

export interface StageTagProps {
  stage: PondStage | null;
  /** 可选：同时展示运行状态 */
  status?: PondStatus | null;
  size?: 'sm' | 'md';
}

const STAGE_STYLE: Record<PondStage, string> = {
  钠盐: 'bg-sky-50 text-sky-700 border-sky-300',
  钾盐: 'bg-amber-50 text-amber-700 border-amber-300',
  锂盐: 'bg-emerald-50 text-emerald-700 border-emerald-300',
};

const STAGE_ICON: Record<PondStage, string> = {
  钠盐: 'Na',
  钾盐: 'K',
  锂盐: 'Li',
};

const STAGE_HINT: Record<PondStage, string> = {
  钠盐: '钠盐蒸发阶段：以蒸发浓缩为主，密度目标 1.05–1.12 g/cm³',
  钾盐: '钾盐蒸发阶段：钾盐开始析出，密度目标 1.12–1.18 g/cm³',
  锂盐: '锂盐蒸发阶段：锂富集阶段，密度目标 ≥ 1.20 g/cm³',
};

const STATUS_STYLE: Record<PondStatus, string> = {
  在用: 'bg-emerald-50 text-emerald-700 border-emerald-300',
  停用: 'bg-slate-100 text-slate-600 border-slate-300',
  清池中: 'bg-rose-50 text-rose-700 border-rose-300',
};

export default function StageTag(props: StageTagProps) {
  const sizeClass = (): string => (props.size === 'sm' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-xs');

  return (
    <span class="inline-flex items-center gap-1">
      <Show
        when={props.stage !== null}
        fallback={
          <span class={`inline-flex items-center rounded border border-slate-300 bg-slate-50 text-slate-500 ${sizeClass()}`}>
            未分阶段
          </span>
        }
      >
        <span
          title={STAGE_HINT[props.stage as PondStage]}
          class={`inline-flex items-center gap-1 rounded border font-medium ${STAGE_STYLE[props.stage as PondStage]} ${sizeClass()}`}
        >
          <span class="rounded bg-white/70 px-1 font-mono text-[10px] leading-4">{STAGE_ICON[props.stage as PondStage]}</span>
          {props.stage}
        </span>
      </Show>
      <Show when={props.status !== undefined && props.status !== null}>
        <span class={`inline-flex items-center rounded border ${STATUS_STYLE[props.status as PondStatus]} ${sizeClass()}`}>
          {props.status}
        </span>
      </Show>
    </span>
  );
}
