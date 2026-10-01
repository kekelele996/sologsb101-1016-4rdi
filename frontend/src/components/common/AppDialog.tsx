/**
 * <AppDialog> 轻量弹层（Tailwind 手写）
 * 供各页面的新增 / 编辑表单与二次确认复用，保持 Solid 项目零 UI 组件库依赖。
 */
import { Show } from 'solid-js';
import type { JSX } from 'solid-js';

export interface AppDialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: JSX.Element;
  footer?: JSX.Element;
  /** Tailwind max-width 类，默认 max-w-2xl */
  width?: string;
}

export default function AppDialog(props: AppDialogProps) {
  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-8">
        <div class={`w-full ${props.width ?? 'max-w-2xl'} rounded-xl bg-white shadow-2xl`}>
          <div class="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <h3 class="text-sm font-semibold text-slate-800">{props.title}</h3>
            <button
              type="button"
              class="rounded px-2 text-lg leading-none text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
              onClick={() => props.onClose()}
              aria-label="关闭"
            >
              ×
            </button>
          </div>
          <div class="max-h-[70vh] overflow-y-auto px-4 py-4">{props.children}</div>
          <Show when={props.footer !== undefined}>
            <div class="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-4 py-3">{props.footer}</div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
