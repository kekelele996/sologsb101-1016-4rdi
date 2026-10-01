/**
 * /schedules 走水与出卤编排
 * 按日期排序、拖拽调整走水先后顺序、逐条推进状态；出卤完成回写池阶段与实际密度。
 * 计划日期与闸门串级、卤水日观测打通：按池系串级走向与最近观测重算每条计划的
 * 预计出卤日期与可用水量；开度或观测变化后受影响计划标「待重算」，手工锁过日期
 * 的计划保住原日期、只提示冲突。
 * 消费模型：Schedule、Gate、Assay、Observation；复用组件：<FilterBar>、<EmptyPanel>、<StatBadge>
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { A } from '@solidjs/router';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import StageTag from '../components/common/StageTag';
import { usePondStore } from '../stores/pondStore';
import { useScheduleStore } from '../stores/scheduleStore';
import { SCHEDULE_STATE_OPTIONS, type Schedule, type ScheduleDraft, type ScheduleState } from '../types/schedule';
import { effectiveVerdict } from '../utils/brine';
import { findOpeningMismatches } from '../utils/scheduleCalc';
import { today } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

const STATE_STYLE: Record<ScheduleState, string> = {
  待排: 'border-slate-300 bg-slate-100 text-slate-600',
  已排: 'border-sky-300 bg-sky-50 text-sky-700',
  走水中: 'border-amber-300 bg-amber-50 text-amber-700',
  已出卤: 'border-emerald-300 bg-emerald-50 text-emerald-700',
};

function emptyDraft(pondId: string, orderIndex: number): ScheduleDraft {
  return {
    pondId,
    planDate: today(),
    targetDensity: 1.15,
    volumeM3: 800,
    operator: '',
    state: '待排',
    orderIndex,
    lockedDate: false,
  };
}

export default function ScheduleBoard() {
  const pondStore = usePondStore();
  const scheduleStore = useScheduleStore();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal<Schedule | null>(null);
  const [dragOverId, setDragOverId] = createSignal<string | null>(null);
  const [draft, setDraft] = createStore<ScheduleDraft>(emptyDraft('', 1));

  onMount(() => {
    void pondStore.loadAll();
  });

  const pondOf = (pondId: string) => pondStore.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  const ordered = createMemo<Schedule[]>(() =>
    [...scheduleStore.state.rows].sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate)),
  );

  const filtered = createMemo<Schedule[]>(() => {
    const current = scheduleStore.filters();
    const series = pondStore.state.currentSeries;
    const keyword = current.keyword.trim().toLowerCase();
    return ordered().filter((row) => {
      const pond = pondOf(row.pondId);
      if (series !== null && pond?.seriesName !== series) return false;
      if (current.state !== 'all' && row.state !== current.state) return false;
      if (keyword === '') return true;
      return (
        pondLabel(row.pondId).toLowerCase().includes(keyword) ||
        row.operator.toLowerCase().includes(keyword) ||
        row.planDate.includes(keyword)
      );
    });
  });

  const stats = createMemo(() => {
    const list = ordered();
    return {
      total: list.length,
      pending: list.filter((row) => row.state === '待排').length,
      running: list.filter((row) => row.state === '走水中').length,
      done: list.filter((row) => row.state === '已出卤').length,
      volume: Math.round(list.reduce((acc, row) => acc + row.volumeM3, 0) * 10) / 10,
      donePct: list.length === 0 ? 0 : Math.round((list.filter((row) => row.state === '已出卤').length / list.length) * 1000) / 10,
    };
  });

  /** 待重算计划条数（闸门开度或观测变化后等待重算） */
  const staleCount = createMemo(() => ordered().filter((row) => row.recalcState === '待重算' && row.state !== '已出卤').length);

  /** 计划快照开度与闸门工实际开度不一致的条数（按池号核对） */
  const mismatchCount = createMemo(
    () => findOpeningMismatches(ordered(), pondStore.state.gates, pondStore.state.ponds).length,
  );

  const openCreate = (): void => {
    const pondId = pondStore.pondsOfSeries(pondStore.state.currentSeries)[0]?.id ?? pondStore.state.ponds[0]?.id ?? '';
    setEditingId(null);
    setDraft(emptyDraft(pondId, ordered().length + 1));
    setDialogOpen(true);
  };

  const openEdit = (row: Schedule): void => {
    setEditingId(row.id);
    setDraft({
      pondId: row.pondId,
      planDate: row.planDate,
      targetDensity: row.targetDensity,
      volumeM3: row.volumeM3,
      operator: row.operator,
      state: row.state,
      orderIndex: row.orderIndex,
      lockedDate: row.lockedDate,
    });
    setDialogOpen(true);
  };

  const submit = async (): Promise<void> => {
    if (draft.pondId === '') {
      scheduleStore.setMessage('请选择蒸发池');
      return;
    }
    if (editingId() === null) {
      const row = await scheduleStore.createSchedule({ ...draft });
      scheduleStore.setMessage(`已新建走水计划：${row.planDate}，目标密度 ${row.targetDensity} g/cm³`);
    } else {
      await scheduleStore.updateSchedule(editingId() as string, { ...draft });
    }
    setDialogOpen(false);
  };

  const confirmDelete = async (): Promise<void> => {
    const row = deleting();
    if (row === null) return;
    await scheduleStore.deleteSchedule(row.id);
    setDeleting(null);
  };

  const handleDrop = async (targetId: string): Promise<void> => {
    const fromId = scheduleStore.draggingId();
    setDragOverId(null);
    scheduleStore.setDraggingId(null);
    if (fromId === null || fromId === targetId) return;
    await scheduleStore.moveBefore(fromId, targetId);
  };

  const nextStateLabel = (state: ScheduleState): string => {
    if (state === '待排') return '标记已排';
    if (state === '已排') return '开始走水';
    if (state === '走水中') return '完成出卤';
    return '已出卤';
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="走水计划" value={stats().total} suffix="条" tone="primary" />
        <StatBadge label="待排" value={stats().pending} suffix="条" tone="default" />
        <StatBadge label="走水中" value={stats().running} suffix="条" tone="warning" />
        <StatBadge label="已出卤" value={stats().done} suffix="条" tone="success" />
        <StatBadge label="计划总量" value={stats().volume} suffix="m³" tone="info" />
        <StatBadge label="出卤完成率" value={`${stats().donePct}%`} percent={stats().donePct} tone="success" />
        <Show when={staleCount() > 0}>
          <StatBadge label="待重算" value={staleCount()} suffix="条" tone="warning" hint="闸门开度或观测变化后，等待按串级走向重算预计出卤日期" />
        </Show>
      </div>

      <Show when={scheduleStore.state.lastMessage !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {scheduleStore.state.lastMessage}
        </div>
      </Show>

      <Show when={mismatchCount() > 0}>
        <div class="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2 text-sm text-amber-800">
          <span>
            有 {mismatchCount()} 条计划的进水闸门开度与闸门工记录的实际开度不一致，计划仍按旧开度排期。
          </span>
          <A href="/gates" class="ml-auto rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs text-amber-700 transition hover:bg-amber-100">
            前往闸门配置按池号核对 →
          </A>
        </div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">走水与出卤编排</h2>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class={BTN_GHOST}
              disabled={scheduleStore.recalculating()}
              onClick={() => void scheduleStore.recalcAll(true)}
            >
              {scheduleStore.recalculating() ? '重算中…' : '重算预计'}
            </button>
            <button type="button" class={BTN_PRIMARY} onClick={openCreate} disabled={pondStore.state.ponds.length === 0}>
              + 新建走水计划
            </button>
          </div>
        </header>

        <FilterBar
          keyword={scheduleStore.filters().keyword}
          onKeyword={(value) => scheduleStore.patchFilters({ keyword: value })}
          fields={[
            { key: 'series', label: '池系', options: pondStore.seriesOptions() },
            { key: 'state', label: '状态', options: [...SCHEDULE_STATE_OPTIONS] },
          ]}
          values={{ series: pondStore.state.currentSeries ?? 'all', state: scheduleStore.filters().state }}
          onChange={(key, value) => {
            if (key === 'series') pondStore.setCurrentSeries(value === 'all' ? null : value);
            if (key === 'state') scheduleStore.patchFilters({ state: value as ScheduleState | 'all' });
          }}
          onReset={() => {
            scheduleStore.resetFilters();
            pondStore.setCurrentSeries(pondStore.seriesOptions()[0] ?? null);
          }}
          resultText={`命中 ${filtered().length} / ${ordered().length} 条`}
        />

        <Show when={ordered().length === 0}>
          <EmptyPanel
            title="还没有走水编排"
            description="为蒸发池编排走水日期、目标密度与计划量，拖拽列表可以调整走水先后顺序，逐条推进到「已出卤」会自动回写池阶段。"
            actionText="新建第一条走水计划"
            onAction={openCreate}
          />
        </Show>

        <Show when={ordered().length > 0}>
          <ul class="space-y-2">
            <For each={filtered()}>
              {(row, index) => (
                <li
                  draggable={true}
                  class={`flex flex-wrap items-center gap-3 rounded-lg border bg-white px-3.5 py-3 transition ${
                    dragOverId() === row.id ? 'border-brine-500 ring-1 ring-brine-400' : 'border-slate-200'
                  }`}
                  onDragStart={() => scheduleStore.setDraggingId(row.id)}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragOverId(row.id);
                  }}
                  onDragLeave={() => setDragOverId(null)}
                  onDrop={(event) => {
                    event.preventDefault();
                    void handleDrop(row.id);
                  }}
                >
                  <span class="grid h-7 w-7 shrink-0 cursor-grab place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-500">
                    {index() + 1}
                  </span>
                  <span class="cursor-grab text-slate-300" title="按住拖拽调整顺序">
                    ⠿
                  </span>
                  <div class="min-w-[180px] flex-1">
                    <p class="flex flex-wrap items-center gap-1.5 text-sm font-medium text-slate-800">
                      {pondLabel(row.pondId)}
                      <Show when={row.lockedDate}>
                        <span
                          class="rounded border border-slate-300 bg-slate-100 px-1 py-0.5 text-[10px] text-slate-500"
                          title="调度员已锁定计划日期：重算保住原日期，只提示冲突"
                        >
                          🔒 已锁日期
                        </span>
                      </Show>
                      <Show when={row.state !== '已出卤' && row.recalcState === '待重算'}>
                        <span class="rounded border border-amber-300 bg-amber-50 px-1 py-0.5 text-[10px] text-amber-700">
                          待重算
                        </span>
                      </Show>
                    </p>
                    <p class="text-xs text-slate-500">
                      计划日期 {row.planDate} · 调度员 {row.operator === '' ? '未填写' : row.operator}
                    </p>
                  </div>
                  <div class="flex items-center gap-2">
                    <StageTag stage={pondOf(row.pondId)?.stage ?? null} size="sm" />
                  </div>
                  <div class="text-xs text-slate-600">
                    <p>
                      目标密度 <span class="tabular-nums font-medium text-slate-800">{row.targetDensity}</span> g/cm³
                    </p>
                    <p>
                      当前密度{' '}
                      <span class="tabular-nums font-medium text-brine-700">
                        {pondStore.statOf(row.pondId).currentDensity || '—'}
                      </span>
                    </p>
                  </div>
                  <div class="text-xs text-slate-600">
                    <p>
                      计划量 <span class="tabular-nums font-medium text-slate-800">{row.volumeM3}</span> m³
                    </p>
                    <p>
                      组分判定{' '}
                      <span class="font-medium text-slate-800">
                        {(() => {
                          const list = pondStore.state.assays
                            .filter((item) => item.pondId === row.pondId)
                            .sort((a, b) => a.date.localeCompare(b.date));
                          return list.length === 0 ? '未化验' : effectiveVerdict(list[list.length - 1]);
                        })()}
                      </span>
                    </p>
                  </div>
                  <div class="text-xs text-slate-600">
                    <p>
                      预计出卤{' '}
                      <span class="tabular-nums font-medium text-brine-700">
                        {row.state === '已出卤'
                          ? '已出卤'
                          : row.recalcState === '待重算'
                            ? '待重算'
                            : row.expectedDate || '—'}
                      </span>
                    </p>
                    <p>
                      可用水量{' '}
                      <span class="tabular-nums font-medium text-slate-800">
                        {row.state === '已出卤'
                          ? '—'
                          : row.recalcState === '待重算'
                            ? '待重算'
                            : `${row.availableVolumeM3} m³`}
                      </span>
                    </p>
                  </div>
                  <span class={`rounded border px-2 py-0.5 text-[11px] ${STATE_STYLE[row.state]}`}>{row.state}</span>
                  <Show when={row.conflict && row.conflictNote !== ''}>
                    <div class="w-full rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
                      ⚠ {row.conflictNote}
                    </div>
                  </Show>
                  <div class="flex flex-wrap items-center gap-2">
                    <button
                      class="rounded-md border border-brine-300 bg-brine-50 px-2.5 py-1 text-xs text-brine-700 transition hover:bg-brine-100 disabled:opacity-50"
                      disabled={row.state === '已出卤'}
                      onClick={async () => {
                        const next = await scheduleStore.advance(row.id);
                        if (next === null) scheduleStore.setMessage('该计划已处于「已出卤」状态');
                      }}
                    >
                      {nextStateLabel(row.state)}
                    </button>
                    <button class="text-xs text-brine-700 hover:underline" onClick={() => openEdit(row)}>
                      编辑
                    </button>
                    <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeleting(row)}>
                      删除
                    </button>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <Show when={ordered().length > 0 && filtered().length === 0}>
          <EmptyPanel
            title="没有符合筛选条件的走水计划"
            description="可以切换池系或状态筛选条件，或直接重置筛选。"
            actionText="重置筛选"
            onAction={() => scheduleStore.resetFilters()}
          />
        </Show>
      </section>

      <AppDialog
        open={dialogOpen()}
        title={editingId() === null ? '新建走水计划' : '编辑走水计划'}
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
            <span>计划走水日期</span>
            <input
              type="date"
              class={INPUT}
              value={draft.planDate}
              disabled={draft.lockedDate}
              onInput={(event) => setDraft('planDate', event.currentTarget.value)}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>目标密度（g/cm³）</span>
            <input
              type="number"
              step="0.001"
              class={INPUT}
              value={draft.targetDensity}
              onInput={(event) => setDraft('targetDensity', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计划量（m³）</span>
            <input
              type="number"
              step="10"
              class={INPUT}
              value={draft.volumeM3}
              onInput={(event) => setDraft('volumeM3', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>调度员</span>
            <input class={INPUT} value={draft.operator} onInput={(event) => setDraft('operator', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>走水状态</span>
            <select class={INPUT} value={draft.state} onChange={(event) => setDraft('state', event.currentTarget.value as ScheduleState)}>
              <For each={SCHEDULE_STATE_OPTIONS}>{(state) => <option value={state}>{state}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>排序序号（越小越先走水）</span>
            <input
              type="number"
              min="1"
              step="1"
              class={INPUT}
              value={draft.orderIndex}
              onInput={(event) => setDraft('orderIndex', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex items-center gap-2 text-[13px] text-slate-600 sm:col-span-2">
            <input
              type="checkbox"
              class="h-4 w-4 accent-brine-600"
              checked={draft.lockedDate}
              onChange={(event) => setDraft('lockedDate', event.currentTarget.checked)}
            />
            <span>
              手工锁定计划日期：重算预计出卤日期时保住该日期不被改写，仅在预计日期与计划日期冲突时给出提示。
            </span>
          </label>
        </div>
        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          预计出卤日期与可用水量按池系串级走向、闸门开度与最近观测自动重算；闸门开度或日观测变化后，受影响的计划会标记为「待重算」。
          状态推进到「已出卤」时，会把该池推进到下一蒸发阶段，并把最新一次观测的密度回写为当前实际密度。
        </p>
      </AppDialog>

      <AppDialog
        open={deleting() !== null}
        title="确认删除走水计划？"
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
          将删除「{pondLabel(deleting()?.pondId ?? '')}」在 {deleting()?.planDate} 的走水计划。
        </p>
      </AppDialog>
    </div>
  );
}
