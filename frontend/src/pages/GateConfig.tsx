/**
 * /gates 串级走向与闸门配置
 * 按池系渲染串级拓扑，开度就地编辑；开度调整后重算下游预计进水量。
 * 消费模型：Gate、Pond、Observation；复用组件：<FilterBar>、<StageTag>、<EmptyPanel>、<StatBadge>
 */
import { For, Show, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import StageTag from '../components/common/StageTag';
import { usePondStore } from '../stores/pondStore';
import { GATE_STATE_OPTIONS, type Gate, type GateDraft, type GateState } from '../types/gate';
import { estimateInflowM3, gateFlowAreaM2, stateFromOpening } from '../utils/brine';
import { putGate, removeGate, updateGateOpening } from '../utils/db';
import { nowIso, uuid } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

const DEFAULT_DRAFT: GateDraft = {
  fromPondId: '',
  toPondId: '',
  openingPct: 50,
  widthCm: 120,
  state: '半开',
  note: '',
};

export default function GateConfig() {
  const store = usePondStore();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [deletingGate, setDeletingGate] = createSignal<Gate | null>(null);
  const [message, setMessage] = createSignal('');
  const [draft, setDraft] = createStore<GateDraft>({ ...DEFAULT_DRAFT });

  onMount(() => {
    void store.loadAll();
  });

  const pondOf = (pondId: string) => store.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  /** 上游池最近水位，用于估算过流 */
  const upstreamLevel = (pondId: string): number => {
    const list = store.state.observations
      .filter((row) => row.pondId === pondId)
      .sort((a, b) => a.date.localeCompare(b.date));
    return list.length === 0 ? 40 : list[list.length - 1].levelCm;
  };

  const gatesOfSeries = (): Gate[] => {
    const series = store.state.currentSeries;
    return store.state.gates.filter((gate) => {
      const from = pondOf(gate.fromPondId);
      const to = pondOf(gate.toPondId);
      if (series === null) return true;
      return from?.seriesName === series || to?.seriesName === series;
    });
  };

  const totalInflow = (): number =>
    gatesOfSeries().reduce((acc, gate) => acc + estimateInflowM3(gate, upstreamLevel(gate.fromPondId)), 0);

  /** 开度变化后挂起待重算的未完成计划条数（已出卤历史计划不计） */
  const staleScheduleCount = (): number =>
    store.state.schedules.filter((row) => row.state !== '已出卤' && row.calcStatus === '待重算').length;

  const openCreate = (): void => {
    const ponds = store.pondsOfSeries(store.state.currentSeries);
    setEditingId(null);
    setDraft({
      ...DEFAULT_DRAFT,
      fromPondId: ponds[0]?.id ?? '',
      toPondId: ponds[1]?.id ?? '',
    });
    setDialogOpen(true);
  };

  const openEdit = (gate: Gate): void => {
    setEditingId(gate.id);
    setDraft({
      fromPondId: gate.fromPondId,
      toPondId: gate.toPondId,
      openingPct: gate.openingPct,
      widthCm: gate.widthCm,
      state: gate.state,
      note: gate.note,
    });
    setDialogOpen(true);
  };

  const submit = async (): Promise<void> => {
    if (draft.fromPondId === '' || draft.toPondId === '') {
      setMessage('请选择上游池与下游池');
      return;
    }
    if (draft.fromPondId === draft.toPondId) {
      setMessage('上游池与下游池不能是同一口池');
      return;
    }
    const payload: GateDraft = { ...draft, state: stateFromOpening(draft.openingPct) };
    if (editingId() === null) {
      const stamp = nowIso();
      await putGate({
        id: uuid('gate'),
        ...payload,
        createdAt: stamp,
        updatedAt: stamp,
        revision: 2,
      });
      setMessage(`已新建闸门：${pondLabel(payload.fromPondId)} → ${pondLabel(payload.toPondId)}`);
    } else {
      const existing = store.state.gates.find((gate) => gate.id === editingId());
      if (existing === undefined) return;
      await putGate({ ...existing, ...payload });
      setMessage('闸门配置已更新');
    }
    setDialogOpen(false);
  };

  const confirmDelete = async (): Promise<void> => {
    const gate = deletingGate();
    if (gate === null) return;
    await removeGate(gate.id);
    setDeletingGate(null);
    setMessage('闸门已删除');
  };

  const adjustOpening = async (gate: Gate, openingPct: number): Promise<void> => {
    const clamped = Math.max(0, Math.min(100, Math.round(openingPct)));
    if (clamped === gate.openingPct) return;
    const affected = await updateGateOpening(gate.id, clamped, stateFromOpening(clamped));
    setMessage(
      `已把 ${pondLabel(gate.fromPondId)} → ${pondLabel(gate.toPondId)} 的开度调整为 ${clamped}%` +
        (affected > 0
          ? `；沿串级下游 ${affected} 条走水计划已挂起为待重算（调度员锁过日期的只提示冲突），请到调度台重算`
          : '；当前没有受影响的未完成计划'),
    );
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="闸门总数" value={store.state.gates.length} suffix="条" tone="primary" />
        <StatBadge label="当前池系闸门" value={gatesOfSeries().length} suffix="条" tone="info" />
        <StatBadge
          label="全开闸门"
          value={store.state.gates.filter((gate) => gate.state === '全开').length}
          suffix="条"
          tone="success"
        />
        <StatBadge
          label="关闭闸门"
          value={store.state.gates.filter((gate) => gate.state === '关闭').length}
          suffix="条"
          tone="warning"
        />
        <StatBadge
          label="下游预计进水合计"
          value={Math.round(totalInflow() * 10) / 10}
          suffix="m³/d"
          tone="info"
          hint="按各闸门开度、口宽与上游最近水位用简易堰流公式估算"
        />
        <StatBadge
          label="开度变动挂起计划"
          value={staleScheduleCount()}
          suffix="条"
          tone={staleScheduleCount() > 0 ? 'warning' : 'default'}
          hint="本侧开度一变，沿串级下游受影响的未完成计划自动挂起为待重算；已锁定日期的计划重算时只提示冲突"
        />
      </div>

      <Show when={message() !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {message()}
        </div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">串级走向与闸门配置</h2>
          <button type="button" class={BTN_PRIMARY} onClick={openCreate} disabled={store.state.ponds.length < 2}>
            + 新建闸门
          </button>
        </header>

        <FilterBar
          keyword=""
          onKeyword={() => undefined}
          fields={[{ key: 'series', label: '池系', options: store.seriesOptions() }]}
          values={{ series: store.state.currentSeries ?? 'all' }}
          onChange={(key, value) => {
            if (key === 'series') store.setCurrentSeries(value === 'all' ? null : value);
          }}
          onReset={() => store.setCurrentSeries(store.seriesOptions()[0] ?? null)}
          resultText={`命中 ${gatesOfSeries().length} / ${store.state.gates.length} 条`}
        />

        <Show when={store.state.ready && store.state.gates.length === 0}>
          <EmptyPanel
            title="还没有闸门串级"
            description="新建闸门把上游池与下游池连接起来，配置开度后即可看到下游预计进水量的即时变化。"
            actionText="新建第一条闸门"
            onAction={openCreate}
          />
        </Show>

        <Show when={store.state.gates.length > 0}>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[1100px] border-collapse text-sm">
              <thead>
                <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                  <th class="px-3 py-2">串级走向</th>
                  <th class="px-3 py-2">上游阶段</th>
                  <th class="px-3 py-2">下游阶段</th>
                  <th class="px-3 py-2 w-64">开度（就地编辑）</th>
                  <th class="px-3 py-2">闸门状态</th>
                  <th class="px-3 py-2">过流面积</th>
                  <th class="px-3 py-2">下游预计进水量</th>
                  <th class="px-3 py-2">备注</th>
                  <th class="px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                <For each={gatesOfSeries()}>
                  {(gate) => (
                    <tr class="border-b border-slate-100 align-middle hover:bg-slate-50/60">
                      <td class="px-3 py-2.5">
                        <div class="flex items-center gap-1.5 text-[13px]">
                          <span class="font-medium text-slate-800">{pondLabel(gate.fromPondId)}</span>
                          <span class="text-brine-600">→</span>
                          <span class="font-medium text-slate-800">{pondLabel(gate.toPondId)}</span>
                        </div>
                      </td>
                      <td class="px-3 py-2.5">
                        <StageTag stage={pondOf(gate.fromPondId)?.stage ?? null} size="sm" />
                      </td>
                      <td class="px-3 py-2.5">
                        <StageTag stage={pondOf(gate.toPondId)?.stage ?? null} size="sm" />
                      </td>
                      <td class="px-3 py-2.5">
                        <div class="flex items-center gap-2">
                          <input
                            type="range"
                            min="0"
                            max="100"
                            step="5"
                            value={gate.openingPct}
                            class="h-1.5 flex-1 accent-brine-600"
                            onChange={(event) => void adjustOpening(gate, Number(event.currentTarget.value))}
                          />
                          <input
                            type="number"
                            min="0"
                            max="100"
                            value={gate.openingPct}
                            class="w-16 rounded border border-slate-300 px-1.5 py-1 text-xs tabular-nums outline-none focus:border-brine-500"
                            onChange={(event) => void adjustOpening(gate, Number(event.currentTarget.value))}
                          />
                          <span class="text-xs text-slate-400">%</span>
                        </div>
                      </td>
                      <td class="px-3 py-2.5">
                        <span
                          class={`rounded border px-1.5 py-0.5 text-[11px] ${
                            gate.state === '全开'
                              ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                              : gate.state === '关闭'
                                ? 'border-slate-300 bg-slate-100 text-slate-500'
                                : 'border-amber-300 bg-amber-50 text-amber-700'
                          }`}
                        >
                          {gate.state}
                        </span>
                      </td>
                      <td class="px-3 py-2.5 tabular-nums text-slate-600">{gateFlowAreaM2(gate)} ㎡</td>
                      <td class="px-3 py-2.5 tabular-nums font-medium text-brine-700">
                        {estimateInflowM3(gate, upstreamLevel(gate.fromPondId))} m³/d
                        <span class="ml-1 text-[11px] text-slate-400">
                          （上游水位 {upstreamLevel(gate.fromPondId)} cm）
                        </span>
                      </td>
                      <td class="px-3 py-2.5 text-xs text-slate-500">{gate.note === '' ? '—' : gate.note}</td>
                      <td class="px-3 py-2.5">
                        <div class="flex gap-2">
                          <button class="text-xs text-brine-700 hover:underline" onClick={() => openEdit(gate)}>
                            编辑
                          </button>
                          <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeletingGate(gate)}>
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

        <Show when={store.state.gates.length > 0 && gatesOfSeries().length === 0}>
          <EmptyPanel
            title="当前池系没有闸门"
            description="可以切换池系，或为该池系新建一条串级闸门。"
            actionText="新建闸门"
            onAction={openCreate}
          />
        </Show>
      </section>

      <AppDialog
        open={dialogOpen()}
        title={editingId() === null ? '新建闸门' : '编辑闸门'}
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
            <span>上游池</span>
            <select
              class={INPUT}
              value={draft.fromPondId}
              onChange={(event) => setDraft('fromPondId', event.currentTarget.value)}
            >
              <option value="">请选择</option>
              <For each={store.state.ponds}>
                {(pond) => (
                  <option value={pond.id}>
                    {pond.code} · {pond.seriesName} · {pond.stage}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>下游池</span>
            <select class={INPUT} value={draft.toPondId} onChange={(event) => setDraft('toPondId', event.currentTarget.value)}>
              <option value="">请选择</option>
              <For each={store.state.ponds}>
                {(pond) => (
                  <option value={pond.id}>
                    {pond.code} · {pond.seriesName} · {pond.stage}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>开度（%）</span>
            <input
              type="number"
              min="0"
              max="100"
              class={INPUT}
              value={draft.openingPct}
              onInput={(event) => setDraft('openingPct', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>口宽（cm）</span>
            <input
              type="number"
              min="10"
              max="600"
              class={INPUT}
              value={draft.widthCm}
              onInput={(event) => setDraft('widthCm', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>闸门状态</span>
            <select
              class={INPUT}
              value={draft.state}
              onChange={(event) => setDraft('state', event.currentTarget.value as GateState)}
            >
              <For each={GATE_STATE_OPTIONS}>{(state) => <option value={state}>{state}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>备注</span>
            <input class={INPUT} value={draft.note} onInput={(event) => setDraft('note', event.currentTarget.value)} />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          按开度自动推导的闸门状态为「{stateFromOpening(draft.openingPct)}」；保存时以开度推导结果为准。
        </p>
      </AppDialog>

      <AppDialog
        open={deletingGate() !== null}
        title="确认删除闸门？"
        width="max-w-lg"
        onClose={() => setDeletingGate(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeletingGate(null)}>
              取消
            </button>
            <button class={BTN_DANGER} onClick={() => void confirmDelete()}>
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除串级「{pondLabel(deletingGate()?.fromPondId ?? '')} → {pondLabel(deletingGate()?.toPondId ?? '')}」，
          删除后下游池将失去该进水通道。
        </p>
      </AppDialog>
    </div>
  );
}
