/**
 * 应用外壳：顶部品牌栏 + 左侧导航 + 内容区 + 页脚
 * 同时负责初始化本地数据库与全局 store 的数据订阅。
 */
import { For, Show, onMount } from 'solid-js';
import { A, type RouteSectionProps } from '@solidjs/router';
import { NAV_ITEMS } from './router';
import { usePondStore } from './stores/pondStore';
import { useObservationStore } from './stores/observationStore';
import { useScheduleStore } from './stores/scheduleStore';

export default function App(props: RouteSectionProps) {
  const pondStore = usePondStore();
  const observationStore = useObservationStore();
  const scheduleStore = useScheduleStore();

  onMount(() => {
    void pondStore.loadAll();
  });

  const counts = () => ({
    ponds: pondStore.state.counts.ponds ?? 0,
    gates: pondStore.state.counts.gates ?? 0,
    observations: pondStore.state.counts.observations ?? 0,
    assays: pondStore.state.counts.assays ?? 0,
    schedules: pondStore.state.counts.schedules ?? 0,
  });

  const currentSeries = () => pondStore.state.currentSeries ?? '全部池系';

  return (
    <div class="min-h-screen bg-slate-50">
      <header class="flex flex-wrap items-center justify-between gap-4 bg-brine-800 px-5 py-3 text-white">
        <div class="flex items-center gap-3">
          <span class="grid h-10 w-10 place-items-center rounded-lg border border-white/30 bg-white/10 text-lg font-bold">
            盐
          </span>
          <div>
            <h1 class="text-base font-semibold tracking-wide">盐湖蒸发池卤水晒程编排台</h1>
            <p class="text-xs text-white/70">gbbrinepond · 串级走水 · 日观测 · 组分判定 · 出卤编排</p>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span class="rounded-full bg-white/15 px-2.5 py-1">当前池系：{currentSeries()}</span>
          <span class="rounded-full bg-white/15 px-2.5 py-1">池 {counts().ponds} 口</span>
          <span class="rounded-full bg-white/15 px-2.5 py-1">闸门 {counts().gates} 条</span>
          <span class="rounded-full bg-white/15 px-2.5 py-1">观测 {counts().observations} 条</span>
          <span class="rounded-full bg-white/15 px-2.5 py-1">化验 {counts().assays} 条</span>
          <span class="rounded-full bg-white/15 px-2.5 py-1">走水 {counts().schedules} 条</span>
        </div>
      </header>

      <div class="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-4 py-5 lg:flex-row">
        <nav class="lg:w-56 lg:shrink-0">
          <ul class="flex flex-wrap gap-2 lg:flex-col lg:gap-1.5">
            <For each={NAV_ITEMS}>
              {(item) => (
                <li class="lg:w-full">
                  <A
                    href={item.path}
                    class="flex flex-col rounded-lg border border-transparent px-3 py-2 text-sm text-slate-600 transition hover:bg-white hover:text-brine-700"
                    activeClass="!border-brine-200 !bg-white font-semibold text-brine-700 shadow-sm"
                  >
                    <span>{item.label}</span>
                    <span class="text-[11px] font-normal text-slate-400">{item.hint}</span>
                  </A>
                </li>
              )}
            </For>
          </ul>

          <div class="mt-4 hidden rounded-lg border border-slate-200 bg-white p-3 text-xs leading-relaxed text-slate-500 lg:block">
            <p class="mb-1 font-semibold text-slate-700">数据存储</p>
            <p>库名 gbbrinepond（IndexedDB / Dexie），结构版本 v2。</p>
            <p class="mt-1">v1 建表与 pondId+date 复合索引；v2 新增 evapMm 并迁移旧记录。</p>
          </div>
        </nav>

        <main class="min-w-0 flex-1">
          <Show when={pondStore.state.error !== ''}>
            <div class="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2 text-sm text-rose-700">
              本地数据库错误：{pondStore.state.error}
            </div>
          </Show>
          {props.children}
        </main>
      </div>

      <footer class="flex flex-wrap items-center justify-between gap-2 px-5 pb-6 pt-2 text-xs text-slate-400">
        <span>数据仅存于本浏览器（IndexedDB 库名 gbbrinepond / localStorage），不上传任何服务器。</span>
        <span>
          观测 {observationStore.stats().count} 条 · 走水 {scheduleStore.state.rows.length} 条 · 结构版本 v
          {pondStore.state.counts.schemaVersion ?? '-'}
        </span>
      </footer>
    </div>
  );
}
