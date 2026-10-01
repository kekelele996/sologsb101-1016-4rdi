/**
 * <FilterBar> 关键字 + 池系 / 日期区间多选过滤并同步 URL query
 * 被 /observations、/assays、/schedules 三页共用；筛选条件同步到 URL query，结果集由 createMemo 派生。
 */
import { For, Show, createEffect, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import { useSearchParams } from '@solidjs/router';

export interface FilterField {
  /** 同时作为 URL query 参数名 */
  key: string;
  label: string;
  options: string[];
  optionLabels?: Record<string, string>;
}

export interface FilterBarProps {
  keyword: string;
  onKeyword: (value: string) => void;
  fields?: FilterField[];
  /** 当前值；'all' 表示不过滤 */
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onReset: () => void;
  resultText?: string;
  children?: JSX.Element;
}

export default function FilterBar(props: FilterBarProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  let lastSerialized = '';

  // 首次挂载：从 URL query 回灌筛选条件（支持把带筛选的链接直接分享出去）
  onMount(() => {
    const query = searchParams as Record<string, string | string[] | undefined>;
    const q = query.q;
    if (typeof q === 'string') props.onKeyword(q);
    (props.fields ?? []).forEach((field) => {
      const value = query[field.key];
      if (typeof value === 'string') props.onChange(field.key, value);
    });
    lastSerialized = JSON.stringify({ q: props.keyword, values: props.values });
  });

  // 筛选条件变化后写回 URL query（值未变化时不重复写入，避免路由抖动）
  createEffect(() => {
    const payload = JSON.stringify({ q: props.keyword, values: props.values });
    if (payload === lastSerialized) return;
    lastSerialized = payload;
    const query: Record<string, string> = {};
    if (props.keyword.trim() !== '') query.q = props.keyword.trim();
    Object.entries(props.values).forEach(([key, value]) => {
      if (value !== '' && value !== 'all') query[key] = value;
    });
    setSearchParams(query, { replace: true });
  });

  const optionLabel = (field: FilterField, option: string): string => field.optionLabels?.[option] ?? option;

  return (
    <div class="mb-3.5 flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50/70 px-3.5 py-3">
      <input
        type="text"
        value={props.keyword}
        placeholder="输入关键字筛选"
        class="w-52 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400"
        onInput={(event) => props.onKeyword(event.currentTarget.value)}
      />

      <For each={props.fields ?? []}>
        {(field) => (
          <label class="flex items-center gap-1.5 text-[13px] text-slate-600">
            <span>{field.label}</span>
            <select
              class="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-brine-500"
              value={props.values[field.key] ?? 'all'}
              onChange={(event) => props.onChange(field.key, event.currentTarget.value)}
            >
              <option value="all">全部{field.label}</option>
              <For each={field.options}>
                {(option) => <option value={option}>{optionLabel(field, option)}</option>}
              </For>
            </select>
          </label>
        )}
      </For>

      <button
        type="button"
        class="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100"
        onClick={() => props.onReset()}
      >
        重置筛选
      </button>

      <Show when={props.resultText !== undefined && props.resultText !== ''}>
        <span class="rounded-full bg-brine-50 px-2.5 py-0.5 text-xs text-brine-700">{props.resultText}</span>
      </Show>

      {props.children}
    </div>
  );
}
