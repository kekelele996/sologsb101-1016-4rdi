/**
 * <StatBadge> 池数 / 观测条数 / 达标占比徽标
 * 被 /observations、/assays、/export 消费。
 */
import { Show } from 'solid-js';
import type { JSX } from 'solid-js';

export type StatTone = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export interface StatBadgeProps {
  label: string;
  value: string | number;
  /** 数值后缀，如「口」「条」「%」 */
  suffix?: string;
  /** 占比（0–100），传入后渲染进度条 */
  percent?: number;
  tone?: StatTone;
  hint?: string;
  size?: 'sm' | 'md';
  icon?: JSX.Element;
}

const TONE: Record<StatTone, { border: string; text: string; bar: string }> = {
  default: { border: 'border-l-slate-400', text: 'text-slate-600', bar: 'bg-slate-400' },
  primary: { border: 'border-l-brine-600', text: 'text-brine-700', bar: 'bg-brine-600' },
  success: { border: 'border-l-emerald-500', text: 'text-emerald-700', bar: 'bg-emerald-500' },
  warning: { border: 'border-l-amber-500', text: 'text-amber-700', bar: 'bg-amber-500' },
  danger: { border: 'border-l-rose-500', text: 'text-rose-700', bar: 'bg-rose-500' },
  info: { border: 'border-l-sky-500', text: 'text-sky-700', bar: 'bg-sky-500' },
};

export default function StatBadge(props: StatBadgeProps) {
  const tone = (): { border: string; text: string; bar: string } => TONE[props.tone ?? 'default'];
  const clamped = (): number => Math.max(0, Math.min(100, Math.round((props.percent ?? 0) * 10) / 10));

  return (
    <div
      title={props.hint}
      class={`flex flex-col gap-1.5 rounded-lg border border-slate-200 border-l-4 bg-white ${
        tone().border
      } ${props.size === 'sm' ? 'min-w-[104px] px-2.5 py-2' : 'min-w-[140px] px-3.5 py-3'}`}
    >
      <div class={`flex items-center gap-1.5 text-[13px] ${tone().text}`}>
        <Show when={props.icon !== undefined}>{props.icon}</Show>
        <span>{props.label}</span>
      </div>
      <div class="flex items-baseline gap-1">
        <span class={`font-bold tabular-nums text-slate-800 ${props.size === 'sm' ? 'text-lg' : 'text-2xl'}`}>
          {props.value}
        </span>
        <Show when={props.suffix !== undefined && props.suffix !== ''}>
          <span class="text-xs text-slate-500">{props.suffix}</span>
        </Show>
      </div>
      <Show when={props.percent !== undefined}>
        <div class="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div class={`h-full rounded-full ${tone().bar}`} style={{ width: `${clamped()}%` }} />
        </div>
      </Show>
    </div>
  );
}
