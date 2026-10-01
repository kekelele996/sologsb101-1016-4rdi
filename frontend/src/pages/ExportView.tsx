/**
 * /export 晒程进度汇总与 JSON 结构版本导入导出
 * 消费全部模型；复用组件：<StatBadge>、<EmptyPanel>
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import StatBadge from '../components/common/StatBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import StageTag from '../components/common/StageTag';
import { usePondStore } from '../stores/pondStore';
import { DB_NAME, DB_SCHEMA_VERSION, exportSnapshot, importSnapshot, resetDatabase } from '../utils/db';
import { buildBriefingText, copyText, exportProgressCsvFile, exportSnapshotJson, parseSnapshot } from '../utils/export';
import { effectiveVerdict } from '../utils/brine';

const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

export default function ExportView() {
  const store = usePondStore();
  const [message, setMessage] = createSignal('');
  const [resetOpen, setResetOpen] = createSignal(false);

  onMount(() => {
    void store.loadAll();
  });

  const summary = createMemo(() => {
    const ponds = store.state.ponds;
    const observations = store.state.observations;
    const assays = store.state.assays;
    const schedules = store.state.schedules;
    const passCount = assays.filter((row) => effectiveVerdict(row) === '达标').length;
    const done = schedules.filter((row) => row.state === '已出卤').length;
    const readyPonds = new Set(assays.filter((row) => effectiveVerdict(row) === '达标').map((row) => row.pondId)).size;
    return {
      ponds: ponds.length,
      observations: observations.length,
      assays: assays.length,
      gates: store.state.gates.length,
      schedules: schedules.length,
      passCount,
      passPct: assays.length === 0 ? 0 : Math.round((passCount / assays.length) * 1000) / 10,
      donePct: schedules.length === 0 ? 0 : Math.round((done / schedules.length) * 1000) / 10,
      readyPonds,
    };
  });

  const handleExportJson = async (): Promise<void> => {
    const snapshot = await exportSnapshot();
    const filename = exportSnapshotJson(snapshot);
    setMessage(`已导出整库存档 ${filename}`);
  };

  const handleExportCsv = (): void => {
    const filename = exportProgressCsvFile(
      store.state.ponds,
      store.state.observations,
      store.state.assays,
      store.state.schedules,
    );
    setMessage(`已导出晒程进度汇总 ${filename}`);
  };

  const handleCopyBriefing = async (): Promise<void> => {
    const text = buildBriefingText(
      store.state.ponds,
      store.state.observations,
      store.state.assays,
      store.state.schedules,
    );
    const ok = await copyText(text);
    setMessage(ok ? '晒程调度通报已复制到剪贴板' : '当前浏览器不支持剪贴板写入，请手动复制');
  };

  const handleFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    const text = await file.text();
    const result = parseSnapshot(text);
    if (!result.ok || result.snapshot === null) {
      setMessage(`导入失败：${result.message}`);
      return;
    }
    await importSnapshot(result.snapshot);
    await store.loadAll();
    setMessage(`导入成功：${result.message}`);
  };

  const handleReset = async (): Promise<void> => {
    await resetDatabase();
    await store.loadAll();
    setResetOpen(false);
    setMessage('已重置为演示数据');
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="蒸发池" value={summary().ponds} suffix="口" tone="primary" />
        <StatBadge label="闸门串级" value={summary().gates} suffix="条" tone="info" />
        <StatBadge label="观测条数" value={summary().observations} suffix="条" tone="info" />
        <StatBadge label="化验条数" value={summary().assays} suffix="条" tone="default" />
        <StatBadge
          label="达标占比"
          value={`${summary().passPct}%`}
          percent={summary().passPct}
          tone="success"
          hint="区间内判定为「达标」的化验记录占比"
        />
        <StatBadge label="出卤候选池" value={summary().readyPonds} suffix="口" tone="success" />
        <StatBadge label="出卤完成率" value={`${summary().donePct}%`} percent={summary().donePct} tone="primary" />
        <StatBadge
          label="数据结构版本"
          value={`v${DB_SCHEMA_VERSION}`}
          suffix={`· ${DB_NAME}`}
          tone="default"
          hint="IndexedDB 库名与结构版本；v1 建表与 pondId+date 复合索引，v2 新增 evapMm 并迁移旧记录"
        />
      </div>

      <Show when={message() !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">{message()}</div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">晒程进度汇总与结构版本</h2>
          <div class="flex flex-wrap gap-2">
            <button class={BTN_GHOST} onClick={() => void handleExportJson()}>
              导出 JSON 存档
            </button>
            <button class={BTN_GHOST} onClick={handleExportCsv}>
              导出 CSV 汇总
            </button>
            <button class={BTN_GHOST} onClick={() => void handleCopyBriefing()}>
              复制调度通报
            </button>
            <label class={`${BTN_GHOST} cursor-pointer`}>
              导入 JSON 存档
              <input
                type="file"
                accept=".json"
                class="hidden"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  void handleFile(file);
                  event.currentTarget.value = '';
                }}
              />
            </label>
            <button class={BTN_DANGER} onClick={() => setResetOpen(true)}>
              重置演示数据
            </button>
          </div>
        </header>

        <Show
          when={store.state.ponds.length > 0}
          fallback={
            <EmptyPanel
              title="还没有可汇总的蒸发池"
              description="先在 /ponds 建立蒸发池并录入卤水日观测与组分分析，这里会自动汇总各池的晒程进度。"
            />
          }
        >
          <div class="overflow-x-auto">
            <table class="w-full min-w-[1120px] border-collapse text-sm">
              <thead>
                <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                  <th class="px-3 py-2">池号</th>
                  <th class="px-3 py-2">池系 / 阶段</th>
                  <th class="px-3 py-2 text-right">面积（㎡）</th>
                  <th class="px-3 py-2 text-right">有效体积（m³）</th>
                  <th class="px-3 py-2 text-right">观测条数</th>
                  <th class="px-3 py-2 text-right">当期密度</th>
                  <th class="px-3 py-2 text-right">最近蒸发量</th>
                  <th class="px-3 py-2">最近组分判定</th>
                  <th class="px-3 py-2 text-right">走水计划</th>
                  <th class="px-3 py-2 text-right">已出卤</th>
                  <th class="px-3 py-2 text-right">进度</th>
                </tr>
              </thead>
              <tbody>
                <For each={store.state.ponds}>
                  {(pond) => {
                    const stat = (): ReturnType<typeof store.statOf> => store.statOf(pond.id);
                    const done = (): number =>
                      store.state.schedules.filter((row) => row.pondId === pond.id && row.state === '已出卤').length;
                    const pct = (): number =>
                      stat().scheduleCount === 0 ? 0 : Math.round((done() / stat().scheduleCount) * 1000) / 10;
                    return (
                      <tr class="border-b border-slate-100 hover:bg-slate-50/60">
                        <td class="px-3 py-2.5 font-medium text-slate-800">{pond.code}</td>
                        <td class="px-3 py-2.5">
                          <div class="flex items-center gap-2">
                            <span class="text-xs text-slate-500">{pond.seriesName}</span>
                            <StageTag stage={pond.stage} status={pond.status} size="sm" />
                          </div>
                        </td>
                        <td class="px-3 py-2.5 text-right tabular-nums">{pond.areaM2.toLocaleString('zh-CN')}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums">{stat().volumeM3.toLocaleString('zh-CN')}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums">{stat().observationCount}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums text-brine-700">
                          {stat().currentDensity > 0 ? `${stat().currentDensity} g/cm³` : '—'}
                        </td>
                        <td class="px-3 py-2.5 text-right tabular-nums">
                          {stat().lastEvapMm > 0 ? `${stat().lastEvapMm} mm/d` : '—'}
                        </td>
                        <td class="px-3 py-2.5 text-xs">{stat().lastVerdict}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums">{stat().scheduleCount}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums">{done()}</td>
                        <td class="px-3 py-2.5">
                          <div class="flex items-center justify-end gap-2">
                            <div class="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100">
                              <div class="h-full rounded-full bg-brine-600" style={{ width: `${pct()}%` }} />
                            </div>
                            <span class="w-12 text-right text-xs tabular-nums text-slate-600">{pct()}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </section>

      <Show when={resetOpen()}>
        <div class="fixed inset-0 z-40 flex items-start justify-center bg-slate-900/40 p-8">
          <div class="w-full max-w-lg rounded-xl bg-white shadow-2xl">
            <div class="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-800">确认重置本地数据？</div>
            <div class="px-4 py-4 text-sm leading-relaxed text-slate-600">
              全部蒸发池、闸门串级、卤水日观测、离子组分分析与走水编排都会被清空，并重新灌入演示数据。
            </div>
            <div class="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
              <button class={BTN_GHOST} onClick={() => setResetOpen(false)}>
                取消
              </button>
              <button class={BTN_DANGER} onClick={() => void handleReset()}>
                确认重置
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
