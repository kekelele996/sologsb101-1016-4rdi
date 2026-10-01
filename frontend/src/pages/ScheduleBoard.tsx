/**
 * /schedules 走水与出卤编排
 * 调度台按池系串级走向与最近卤水日观测算出每条计划的预计出卤日期与可用水量：
 * - 闸门开度 / 观测变化后受影响计划标成「待重算」，支持按责任侧重试，算好的不再生成；
 * - 调度员手工锁过日期的计划保住原日期，仅在预计日期不一致时提示冲突；
 * - 闸门工记录的开度允许与计划短时不一样，按池号列出对账确认。
 * 消费模型：Schedule、Gate、Assay、Observation；复用组件：<FilterBar>、<EmptyPanel>、<StatBadge>
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import StageTag from '../components/common/StageTag';
import { usePondStore } from '../stores/pondStore';
import { useScheduleStore } from '../stores/scheduleStore';
import {
  SCHEDULE_STATE_OPTIONS,
  type Schedule,
  type ScheduleCalcStatus,
  type ScheduleDraft,
  type ScheduleState,
} from '../types/schedule';
import { effectiveVerdict } from '../utils/brine';
import { dateConflict, forecastSchedule, openingMismatch } from '../utils/forecast';
import { today } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-50';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

const STATE_STYLE: Record<ScheduleState, string> = {
  待排: 'border-slate-300 bg-slate-100 text-slate-600',
  已排: 'border-sky-300 bg-sky-50 text-sky-700',
  走水中: 'border-amber-300 bg-amber-50 text-amber-700',
  已出卤: 'border-emerald-300 bg-emerald-50 text-emerald-700',
};

const CALC_STYLE: Record<ScheduleCalcStatus, string> = {
  已算好: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  待重算: 'border-amber-400 bg-amber-50 text-amber-800',
  重算失败: 'border-rose-300 bg-rose-50 text-rose-700',
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
    dateLocked: false,
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
  const pondCode = (pondId: string): string => pondOf(pondId)?.code ?? '（池已删除）';
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  const ordered = createMemo<Schedule[]>(() =>
    [...scheduleStore.state.rows].sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate)),
  );

  const activeRows = createMemo<Schedule[]>(() => ordered().filter((row) => row.state !== '已出卤'));

  /** 待重算/失败计划按责任侧分桶，供按侧重试 */
  const recalcBuckets = createMemo<{ stale: Schedule[]; gateSide: Schedule[]; dispatchSide: Schedule[] }>(() => {
    const stale = activeRows().filter((row) => row.calcStatus !== '已算好');
    return {
      stale,
      gateSide: stale.filter((row) => row.calcStatus === '重算失败' && row.calcSide === '闸门侧'),
      dispatchSide: stale.filter((row) => row.calcStatus === '重算失败' && row.calcSide === '调度侧'),
    };
  });

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

  /**
   * 待重算计划的「新日期」预览：用当前串级与最近观测即时推算，不落库。
   * 闸门工调小开度后，调度台不用先点重算就能看到新预计日期与可用水量。
   */
  const previewOf = (row: Schedule): ReturnType<typeof forecastSchedule> | null => {
    if (row.state === '已出卤' || row.calcStatus === '已算好') return null;
    return forecastSchedule(row, pondStore.state.ponds, pondStore.state.gates, pondStore.state.observations);
  };

  const previewOkOf = (row: Schedule): Extract<ReturnType<typeof forecastSchedule>, { ok: true }> | null => {
    const preview = previewOf(row);
    return preview !== null && preview.ok ? preview : null;
  };

  /** 开度对账：计划依据的闸门开度 vs 闸门工当前记录，按池号分组确认 */
  const mismatchGroups = createMemo<Array<{ pondId: string; pondCode: string; items: Array<{ schedule: Schedule; gateIds: string[] }> }>>(() => {
    const map = new Map<string, { schedule: Schedule; gateIds: string[] }[]>();
    activeRows().forEach((schedule) => {
      const { mismatch, changedGateIds } = openingMismatch(schedule, pondStore.state.gates, (gateId) => {
        const gate = pondStore.state.gates.find((item) => item.id === gateId);
        return gate?.updatedAt;
      });
      if (!mismatch) return;
      const list = map.get(schedule.pondId) ?? [];
      list.push({ schedule, gateIds: changedGateIds });
      map.set(schedule.pondId, list);
    });
    return Array.from(map.entries()).map(([pondId, items]) => ({ pondId, pondCode: pondCode(pondId), items }));
  });

  const conflictRows = createMemo<Schedule[]>(() => activeRows().filter((row) => dateConflict(row)));

  const stats = createMemo(() => {
    const list = ordered();
    return {
      total: list.length,
      pending: list.filter((row) => row.state === '待排').length,
      running: list.filter((row) => row.state === '走水中').length,
      done: list.filter((row) => row.state === '已出卤').length,
      stale: recalcBuckets().stale.length,
      mismatch: mismatchGroups().reduce((acc, group) => acc + group.items.length, 0),
      conflict: conflictRows().length,
      volume: Math.round(list.reduce((acc, row) => acc + row.volumeM3, 0) * 10) / 10,
      available: Math.round(activeRows().reduce((acc, row) => acc + row.availableWaterM3, 0) * 10) / 10,
      donePct: list.length === 0 ? 0 : Math.round((list.filter((row) => row.state === '已出卤').length / list.length) * 1000) / 10,
    };
  });

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
      dateLocked: row.dateLocked,
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

  /** 串级推算依据闸门明细，用于对账行展示 */
  const gateText = (gateIds: string[]): string =>
    gateIds
      .map((gateId) => {
        const gate = pondStore.state.gates.find((item) => item.id === gateId);
        if (gate === undefined) return '已删除闸门';
        return `${pondCode(gate.fromPondId)}→${pondCode(gate.toPondId)}`;
      })
      .join('、');

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="走水计划" value={stats().total} suffix="条" tone="primary" />
        <StatBadge label="待排" value={stats().pending} suffix="条" tone="default" />
        <StatBadge label="走水中" value={stats().running} suffix="条" tone="warning" />
        <StatBadge label="已出卤" value={stats().done} suffix="条" tone="success" />
        <StatBadge
          label="待重算 / 失败"
          value={stats().stale}
          suffix="条"
          tone={stats().stale > 0 ? 'warning' : 'success'}
          hint="闸门开度或卤水日观测变化后挂起；按责任侧重试，已算好的计划不再生成"
        />
        <StatBadge label="日期冲突（锁定）" value={stats().conflict} suffix="条" tone={stats().conflict > 0 ? 'warning' : 'success'} />
        <StatBadge label="开度待对账" value={stats().mismatch} suffix="条" tone={stats().mismatch > 0 ? 'warning' : 'default'} />
        <StatBadge label="计划总量" value={stats().volume} suffix="m³" tone="info" />
        <StatBadge label="预计可用水量合计" value={stats().available} suffix="m³" tone="info" />
      </div>

      <Show when={scheduleStore.state.lastMessage !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {scheduleStore.state.lastMessage}
        </div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">走水与出卤编排</h2>
          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              class={BTN_GHOST}
              disabled={recalcBuckets().stale.length === 0 || scheduleStore.recalculating() !== null}
              onClick={() => void scheduleStore.recalculateStale('闸门侧')}
              title="只重试闸门侧失败的计划（缺闸门 / 闸门全关）"
            >
              闸门侧重试{recalcBuckets().gateSide.length > 0 ? `（${recalcBuckets().gateSide.length}）` : ''}
            </button>
            <button
              type="button"
              class={BTN_GHOST}
              disabled={recalcBuckets().stale.length === 0 || scheduleStore.recalculating() !== null}
              onClick={() => void scheduleStore.recalculateStale('调度侧')}
              title="只重试调度侧失败的计划（缺观测 / 密度无增长 / 池缺失）"
            >
              调度侧重试{recalcBuckets().dispatchSide.length > 0 ? `（${recalcBuckets().dispatchSide.length}）` : ''}
            </button>
            <button
              type="button"
              class={BTN_PRIMARY}
              disabled={recalcBuckets().stale.length === 0 || scheduleStore.recalculating() !== null}
              onClick={() => void scheduleStore.recalculateStale('all')}
            >
              {scheduleStore.recalculating() !== null ? '重算中…' : `重算待处理计划（${recalcBuckets().stale.length}）`}
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

        {/* 日期冲突：手工锁过日期的计划保住原日期，只在这里集中提示 */}
        <Show when={conflictRows().length > 0}>
          <div class="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-[13px] text-amber-900">
            <p class="font-medium">锁定日期与串级预计出卤日期冲突（原日期已保住，不会自动改动）：</p>
            <ul class="mt-1 list-inside list-disc space-y-0.5">
              <For each={conflictRows()}>
                {(row) => (
                  <li>
                    {pondLabel(row.pondId)}：锁定 {row.planDate}，预计 {row.forecastDate || '—'}
                    （{row.calcStatus === '已算好' ? '' : `重算状态：${row.calcStatus}；`}
                    可用水量 {row.availableWaterM3 || '—'} m³）
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>

        {/* 开度对账：闸门工记录的开度允许与计划短时不一样，按池号列出来确认 */}
        <Show when={mismatchGroups().length > 0}>
          <div class="mt-3 rounded-lg border border-slate-300 bg-slate-50 px-3.5 py-2.5 text-[13px] text-slate-700">
            <p class="font-medium text-slate-800">闸门开度与计划依据不一致（两边各自管本侧数据，按池号确认后不再提示）：</p>
            <div class="mt-1.5 space-y-1.5">
              <For each={mismatchGroups()}>
                {(group) => (
                  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5">
                    <span class="rounded bg-slate-800 px-1.5 py-0.5 text-[11px] font-medium text-white">{group.pondCode}</span>
                    <For each={group.items}>
                      {(item) => (
                        <span class="text-xs text-slate-600">
                          计划 {item.schedule.planDate}：闸门 {gateText(item.gateIds)} 开度已调整
                        </span>
                      )}
                    </For>
                    <For each={group.items}>
                      {(item) => (
                        <button
                          class="ml-auto rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-100"
                          onClick={() => void scheduleStore.confirmMismatch(item.schedule.id)}
                        >
                          确认 {item.schedule.planDate}
                        </button>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={ordered().length === 0}>
          <EmptyPanel
            title="还没有走水编排"
            description="为蒸发池编排走水日期、目标密度与计划量；调度台会按串级走向与最近观测算出预计出卤日期和可用水量，闸门开度调整后受影响计划自动挂起重算。"
            actionText="新建第一条走水计划"
            onAction={openCreate}
          />
        </Show>

        <Show when={ordered().length > 0}>
          <ul class="mt-3 space-y-2">
            <For each={filtered()}>
              {(row, index) => {
                const previewOk = () => previewOkOf(row);
                const locked = () => row.dateLocked;
                const conflict = () => dateConflict(row);
                const mismatch = () =>
                  openingMismatch(row, pondStore.state.gates, (gateId) => {
                    const gate = pondStore.state.gates.find((item) => item.id === gateId);
                    return gate?.updatedAt;
                  });
                return (
                  <li
                    draggable={row.state !== '已出卤'}
                    class={`flex flex-wrap items-center gap-3 rounded-lg border bg-white px-3.5 py-3 transition ${
                      dragOverId() === row.id ? 'border-brine-500 ring-1 ring-brine-400' : 'border-slate-200'
                    } ${row.state === '已出卤' ? 'opacity-75' : ''}`}
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
                    <div class="min-w-[190px] flex-1">
                      <p class="text-sm font-medium text-slate-800">{pondLabel(row.pondId)}</p>
                      <p class="text-xs text-slate-500">
                        计划日期 <span class={locked() ? 'font-medium text-amber-700' : ''}>{row.planDate}</span>
                        {locked() ? '（已锁定）' : ''} · 调度员 {row.operator === '' ? '未填写' : row.operator}
                      </p>
                      <Show when={conflict()}>
                        <p class="text-xs font-medium text-amber-700">日期冲突：预计 {row.forecastDate}，原锁定日期保留</p>
                      </Show>
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
                    <div class="min-w-[150px] text-xs text-slate-600">
                      <p>
                        预计出卤{' '}
                        <span class="tabular-nums font-medium text-slate-800">
                          {row.forecastDate !== '' ? row.forecastDate : previewOk()?.forecastDate ?? '—'}
                        </span>
                      </p>
                      <p>
                        可用水量{' '}
                        <span class="tabular-nums font-medium text-brine-700">
                          {row.availableWaterM3 > 0
                            ? `${row.availableWaterM3} m³`
                            : previewOk() !== null
                              ? `${previewOk()?.availableWaterM3} m³（待重算预览）`
                              : '—'}
                        </span>
                      </p>
                      <Show when={previewOk() !== null && row.calcStatus !== '已算好'}>
                        <p class="text-[11px] text-amber-700">重算后新日期：{previewOk()?.forecastDate}</p>
                      </Show>
                      <Show when={previewOk() === null && row.calcStatus !== '已算好'}>
                        <p class="text-[11px] text-rose-600">
                          {row.calcStatus === '重算失败' ? row.calcError : '当前数据仍无法推算'}
                        </p>
                      </Show>
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
                      <Show when={mismatch().mismatch}>
                        <p class="text-[11px] font-medium text-amber-700">开度待确认：{gateText(mismatch().changedGateIds)}</p>
                      </Show>
                    </div>
                    <div class="flex flex-col items-stretch gap-1">
                      <span class={`rounded border px-2 py-0.5 text-center text-[11px] ${STATE_STYLE[row.state]}`}>{row.state}</span>
                      <span class={`rounded border px-2 py-0.5 text-center text-[11px] ${CALC_STYLE[row.calcStatus]}`}>
                        {row.calcStatus}
                        {row.calcStatus === '重算失败' && row.calcSide !== '' ? ` · ${row.calcSide}` : ''}
                      </span>
                    </div>
                    <Show when={row.calcStatus === '重算失败'}>
                      <p class="max-w-[180px] text-[11px] leading-snug text-rose-600" title={row.calcError}>
                        {row.calcError}
                      </p>
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
                      <button
                        class="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
                        disabled={row.state === '已出卤' || row.calcStatus === '已算好'}
                        title="只重算这一条；成功后日期与可用水量立即更新"
                        onClick={() => void scheduleStore.recalculateOne(row.id)}
                      >
                        重算
                      </button>
                      <button
                        class={`rounded-md border px-2.5 py-1 text-xs transition disabled:opacity-50 ${
                          locked()
                            ? 'border-amber-400 bg-amber-50 text-amber-800 hover:bg-amber-100'
                            : 'border-slate-300 text-slate-600 hover:bg-slate-100'
                        }`}
                        disabled={row.state === '已出卤'}
                        title={locked() ? '解除锁定：下次重算对齐预计日期' : '锁定计划日期：重算不改日期，只提示冲突'}
                        onClick={() => void scheduleStore.toggleDateLock(row.id, !locked())}
                      >
                        {locked() ? '解锁日期' : '锁定日期'}
                      </button>
                      <button class="text-xs text-brine-700 hover:underline" onClick={() => openEdit(row)}>
                        编辑
                      </button>
                      <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeleting(row)}>
                        删除
                      </button>
                    </div>
                  </li>
                );
              }}
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
              保存并重算
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
            <input type="date" class={INPUT} value={draft.planDate} onInput={(event) => setDraft('planDate', event.currentTarget.value)} />
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
          <label class="flex cursor-pointer items-end gap-2 pb-1.5 text-[13px] text-slate-700">
            <input
              type="checkbox"
              class="h-4 w-4 accent-brine-600"
              checked={draft.dateLocked}
              onChange={(event) => setDraft('dateLocked', event.currentTarget.checked)}
            />
            <span>锁定计划日期（重算保住此日期，只提示冲突）</span>
          </label>
        </div>
        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          保存后按池系串级走向与最近观测重算预计出卤日期、可用水量：未锁日期会对齐预计日期；锁定日期只在冲突时提示。
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
