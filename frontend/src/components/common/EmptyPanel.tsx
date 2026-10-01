/**
 * <EmptyPanel> 空数据引导与新建入口
 * 被全部列表页消费；池系/池 ID 查不到时也用它兜底，避免白屏。
 */
import { Show } from 'solid-js';
import type { JSX } from 'solid-js';

export interface EmptyPanelProps {
  title: string;
  description?: string;
  actionText?: string;
  onAction?: () => void;
  children?: JSX.Element;
}

export default function EmptyPanel(props: EmptyPanelProps) {
  return (
    <div class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-brine-200 bg-white px-4 py-9 text-center">
      <div class="grid h-12 w-12 place-items-center rounded-full bg-brine-50 text-xl text-brine-600">∅</div>
      <div class="max-w-xl">
        <p class="text-[15px] font-semibold text-slate-800">{props.title}</p>
        <Show when={props.description !== undefined && props.description !== ''}>
          <p class="mt-1.5 text-[13px] leading-relaxed text-slate-500">{props.description}</p>
        </Show>
      </div>
      <div class="flex flex-wrap items-center justify-center gap-2">
        <Show when={props.actionText !== undefined && props.onAction !== undefined}>
          <button
            type="button"
            class="rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700"
            onClick={() => props.onAction?.()}
          >
            + {props.actionText}
          </button>
        </Show>
        {props.children}
      </div>
    </div>
  );
}
