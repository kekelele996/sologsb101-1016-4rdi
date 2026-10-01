/**
 * /observations 卤水日观测录入台
 * 单条录入 + 批量粘贴录入；同池同日仅保留一条（覆盖写入）；蒸发量按经验公式自动估算。
 * 消费模型：Observation、Pond；复用组件：<FilterBar>、<StatBadge>、<EmptyPanel>
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import { useObservationStore, type BatchRow } from '../stores/observationStore';
import { usePondStore } from '../stores/pondStore';
import { useScheduleStore } from '../stores/scheduleStore';
import type { Observation, ObservationDraft } from '../types/observation';
import { estimateEvapMm } from '../utils/brine';
import { db, removeObservation } from '../utils/db';
import { today } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

function emptyDraft(pondId: string): ObservationDraft {
  return { pondId, date: today(), densityGcm3: 1.05, tempC: 28, levelCm: 40, windLevel: 2, evapMm: 0 };
}

export default function ObservationEntry() {
  const observationStore = useObservationStore();
  const pondStore = usePondStore();
  const scheduleStore = useScheduleStore();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [batchOpen, setBatchOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal<Observation | null>(null);
  const [batchText, setBatchText] = createSignal('');
  const [draft, setDraft] = createStore<ObservationDraft>(emptyDraft(''));

  onMount(() => {
    void pondStore.loadAll();
  });

  const pondOf = (pondId: string) => pondStore.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  /** 组合 store 的日期区间筛选 + 池系筛选，供页面消费 */
  const filtered = createMemo<Observation[]>(() => {
    const series = pondStore.state.currentSeries;
    if (series === null) return observationStore.visible();
    const pondIds = new Set(
      pondStore.state.ponds.filter((pond) => pond.seriesName === series).map((pond) => pond.id),
    );
    return observationStore.visible().filter((row) => pondIds.has(row.pondId));
  });

  const previewEvap = createMemo<number>(() =>
    estimateEvapMm(draft.densityGcm3, draft.tempC, draft.levelCm, draft.windLevel),
  );

  const batchPreview = createMemo<BatchRow[]>(() => {
    const rows: BatchRow[] = [];
    batchText()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .forEach((line) => {
        const parts = line.split(/[,\uFF0C\t]+/).map((item) => item.trim());
        if (parts.length < 3) return;
        rows.push({
          pondCode: parts[0],
          date: parts[1] === '' || parts[1] === undefined ? today() : parts[1],
          densityGcm3: Number(parts[2]) || 1.05,
          tempC: Number(parts[3]) || 28,
          levelCm: Number(parts[4]) || 40,
          windLevel: Number(parts[5]) || 2,
        });
      });
    return rows;
  });

  const stats = (): ReturnType<typeof observationStore.stats> => observationStore.stats();

  const openCreate = (): void => {
    const pondId = pondStore.pondsOfSeries(pondStore.state.currentSeries)[0]?.id ?? pondStore.state.ponds[0]?.id ?? '';
    setEditingId(null);
    setDraft(emptyDraft(pondId));
    setDialogOpen(true);
  };

  const openEdit = (row: Observation): void => {
    setEditingId(row.id);
    setDraft({
      pondId: row.pondId,
      date: row.date,
      densityGcm3: row.densityGcm3,
      tempC: row.tempC,
      levelCm: row.levelCm,
      windLevel: row.windLevel,
      evapMm: row.evapMm,
    });
    setDialogOpen(true);
  };

  const submit = async (): Promise<void> => {
    if (draft.pondId === '') {
      observationStore.setLastMessage('请选择蒸发池');
      return;
    }
    if (editingId() === null) {
      await observationStore.saveOne({ ...draft, evapMm: previewEvap() });
    } else {
      const existing = observationStore.rows().find((row) => row.id === editingId());
      if (existing === undefined) return;
      await db.observations.put({
        ...existing,
        pondId: draft.pondId,
        date: draft.date,
        densityGcm3: draft.densityGcm3,
        tempC: draft.tempC,
        levelCm: draft.levelCm,
        windLevel: draft.windLevel,
        evapMm: previewEvap(),
        updatedAt: new Date().toISOString(),
      });
      observationStore.setLastMessage(`已更新 ${draft.date} 的观测记录`);
    }
    setDialogOpen(false);
  };

  const submitBatch = async (): Promise<void> => {
    const rows = batchPreview();
    if (rows.length === 0) {
      observationStore.setLastMessage('没有可解析的行：每行格式为「池号,日期,密度,温度,水位,风力」');
      return;
    }
    await observationStore.batchUpsert(pondStore.state.ponds, rows);
    setBatchOpen(false);
    setBatchText('');
  };

  const confirmDelete = async (): Promise<void> => {
    const row = deleting();
    if (row === null) return;
    await removeObservation(row.id);
    setDeleting(null);
    observationStore.setLastMessage(`已删除 ${row.date} 的观测记录`);
    // 最近观测减少后重算该池计划的预计出卤日期
    await scheduleStore.notifyObservationChanged(row.pondId);
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="观测条数" value={stats().count} suffix="条" tone="primary" />
        <StatBadge label="场次日均蒸发量" value={stats().avgEvapMm} suffix="mm/d" tone="info" />
        <StatBadge label="区间累计蒸发量" value={stats().totalEvapMm} suffix="mm" tone="warning" />
        <StatBadge label="平均密度" value={stats().avgDensity} suffix="g/cm³" tone="success" />
        <StatBadge label="最新观测日期" value={stats().latestDate === '' ? '—' : stats().latestDate} tone="default" />
        <StatBadge label="最新密度" value={stats().latestDensity} suffix="g/cm³" tone="info" />
      </div>

      <Show when={observationStore.lastMessage() !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {observationStore.lastMessage()}
        </div>
      </Show>

      <Show when={observationStore.error() !== ''}>
        <div class="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2 text-sm text-rose-700">
          {observationStore.error()}
        </div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">卤水日观测录入台</h2>
          <div class="flex flex-wrap gap-2">
            <button type="button" class={BTN_GHOST} onClick={() => setBatchOpen(true)} disabled={pondStore.state.ponds.length === 0}>
              批量填写
            </button>
            <button type="button" class={BTN_PRIMARY} onClick={openCreate} disabled={pondStore.state.ponds.length === 0}>
              + 录入观测
            </button>
          </div>
        </header>

        <FilterBar
          keyword={observationStore.filters().keyword}
          onKeyword={(value) => observationStore.patchFilters({ keyword: value })}
          fields={[{ key: 'series', label: '池系', options: pondStore.seriesOptions() }]}
          values={{ series: pondStore.state.currentSeries ?? 'all' }}
          onChange={(key, value) => {
            if (key === 'series') pondStore.setCurrentSeries(value === 'all' ? null : value);
          }}
          onReset={() => {
            observationStore.resetFilters();
            pondStore.setCurrentSeries(pondStore.seriesOptions()[0] ?? null);
          }}
          resultText={`命中 ${filtered().length} / ${observationStore.rows().length} 条`}
        >
          <label class="flex items-center gap-1.5 text-[13px] text-slate-600">
            <span>日期区间</span>
            <input
              type="date"
              class="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
              value={observationStore.filters().from}
              onInput={(event) => observationStore.patchFilters({ from: event.currentTarget.value })}
            />
            <span class="text-slate-400">至</span>
            <input
              type="date"
              class="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
              value={observationStore.filters().to}
              onInput={(event) => observationStore.patchFilters({ to: event.currentTarget.value })}
            />
          </label>
        </FilterBar>

        <Show when={observationStore.rows().length === 0 && !observationStore.loading()}>
          <EmptyPanel
            title="还没有卤水日观测记录"
            description="逐日录入密度、温度、水位与风力，系统会按经验公式估算蒸发量；同池同日只保留一条记录。"
            actionText="录入第一条观测"
            onAction={openCreate}
          />
        </Show>

        <Show when={observationStore.rows().length > 0}>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[980px] border-collapse text-sm">
              <thead>
                <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                  <th class="px-3 py-2">蒸发池</th>
                  <th class="px-3 py-2">观测日期</th>
                  <th class="px-3 py-2 text-right">密度（g/cm³）</th>
                  <th class="px-3 py-2 text-right">温度（℃）</th>
                  <th class="px-3 py-2 text-right">水位（cm）</th>
                  <th class="px-3 py-2 text-right">风力等级</th>
                  <th class="px-3 py-2 text-right">估算蒸发量（mm/d）</th>
                  <th class="px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                <For each={filtered()}>
                  {(row) => (
                    <tr class="border-b border-slate-100 hover:bg-slate-50/60">
                      <td class="px-3 py-2.5">{pondLabel(row.pondId)}</td>
                      <td class="px-3 py-2.5">{row.date}</td>
                      <td class="px-3 py-2.5 text-right tabular-nums">{row.densityGcm3}</td>
                      <td class="px-3 py-2.5 text-right tabular-nums">{row.tempC}</td>
                      <td class="px-3 py-2.5 text-right tabular-nums">{row.levelCm}</td>
                      <td class="px-3 py-2.5 text-right tabular-nums">{row.windLevel} 级</td>
                      <td class="px-3 py-2.5 text-right tabular-nums font-medium text-brine-700">{row.evapMm}</td>
                      <td class="px-3 py-2.5">
                        <div class="flex gap-2">
                          <button class="text-xs text-brine-700 hover:underline" onClick={() => openEdit(row)}>
                            编辑
                          </button>
                          <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeleting(row)}>
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>

        <Show when={observationStore.rows().length > 0 && filtered().length === 0}>
          <EmptyPanel
            title="没有符合筛选条件的观测记录"
            description="可以放宽日期区间或切换池系，或直接重置筛选。"
            actionText="重置筛选"
            onAction={() => observationStore.resetFilters()}
          />
        </Show>
      </section>

      <AppDialog
        open={dialogOpen()}
        title={editingId() === null ? '录入卤水日观测' : '编辑卤水日观测'}
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDialogOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submit()}>
              保存
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>蒸发池</span>
            <select class={INPUT} value={draft.pondId} onChange={(event) => setDraft('pondId', event.currentTarget.value)}>
              <option value="">请选择</option>
              <For each={pondStore.state.ponds}>
                {(pond) => (
                  <option value={pond.id}>
                    {pond.code} · {pond.seriesName} · {pond.stage}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>观测日期</span>
            <input type="date" class={INPUT} value={draft.date} onInput={(event) => setDraft('date', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>密度（g/cm³）</span>
            <input
              type="number"
              step="0.001"
              min="1"
              max="1.4"
              class={INPUT}
              value={draft.densityGcm3}
              onInput={(event) => setDraft('densityGcm3', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>温度（℃）</span>
            <input
              type="number"
              step="0.5"
              class={INPUT}
              value={draft.tempC}
              onInput={(event) => setDraft('tempC', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>水位（cm）</span>
            <input
              type="number"
              step="1"
              class={INPUT}
              value={draft.levelCm}
              onInput={(event) => setDraft('levelCm', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>风力等级（0–8）</span>
            <input
              type="number"
              min="0"
              max="8"
              step="1"
              class={INPUT}
              value={draft.windLevel}
              onInput={(event) => setDraft('windLevel', Number(event.currentTarget.value))}
            />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-brine-50 px-3 py-2 text-xs leading-relaxed text-brine-800">
          按经验公式估算的蒸发量为 <span class="tabular-nums font-semibold">{previewEvap()} mm/d</span>；
          同一蒸发池与同一日期只会保留一条记录，重复保存将覆盖原记录。
        </p>
      </AppDialog>

      <AppDialog
        open={batchOpen()}
        title="批量填写卤水日观测"
        onClose={() => setBatchOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setBatchOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitBatch()} disabled={batchPreview().length === 0}>
              写入 {batchPreview().length} 条
            </button>
          </>
        }
      >
        <p class="mb-2 text-xs leading-relaxed text-slate-500">
          每行一条，格式为「池号,日期,密度,温度,水位,风力」，以 <span class="font-mono">#</span> 开头的行会被忽略。
          示例：<span class="font-mono">北-01,2026-09-28,1.112,27,38,3</span>
        </p>
        <textarea
          rows="8"
          class="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-brine-500"
          placeholder={'北-01,2026-09-28,1.112,27,38,3\n北-02,2026-09-28,1.172,28,35,2'}
          value={batchText()}
          onInput={(event) => setBatchText(event.currentTarget.value)}
        />
        <Show when={batchPreview().length > 0}>
          <div class="mt-2 max-h-40 overflow-y-auto rounded-md border border-slate-200">
            <table class="w-full text-xs">
              <thead class="bg-slate-50 text-slate-500">
                <tr>
                  <th class="px-2 py-1 text-left">池号</th>
                  <th class="px-2 py-1 text-left">日期</th>
                  <th class="px-2 py-1 text-right">密度</th>
                  <th class="px-2 py-1 text-right">温度</th>
                  <th class="px-2 py-1 text-right">水位</th>
                  <th class="px-2 py-1 text-right">风力</th>
                </tr>
              </thead>
              <tbody>
                <For each={batchPreview()}>
                  {(row) => (
                    <tr class="border-t border-slate-100">
                      <td class="px-2 py-1">{row.pondCode}</td>
                      <td class="px-2 py-1">{row.date}</td>
                      <td class="px-2 py-1 text-right tabular-nums">{row.densityGcm3}</td>
                      <td class="px-2 py-1 text-right tabular-nums">{row.tempC}</td>
                      <td class="px-2 py-1 text-right tabular-nums">{row.levelCm}</td>
                      <td class="px-2 py-1 text-right tabular-nums">{row.windLevel}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </AppDialog>

      <AppDialog
        open={deleting() !== null}
        title="确认删除观测记录？"
        width="max-w-lg"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeleting(null)}>
              取消
            </button>
            <button class={BTN_DANGER} onClick={() => void confirmDelete()}>
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除「{pondLabel(deleting()?.pondId ?? '')}」在 {deleting()?.date} 的观测记录，删除后该日的蒸发量统计会同步变化。
        </p>
      </AppDialog>
    </div>
  );
}
