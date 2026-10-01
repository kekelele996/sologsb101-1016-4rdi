/**
 * /assays 离子组分分析录入与达标判定
 * 录入 Li⁺ / K⁺ / Mg²⁺ / Na⁺，自动判定达标并允许人工覆盖；按池与日期区间叠加组分曲线。
 * 消费模型：Assay、Pond、Observation；复用组件：<StageTag>、<StatBadge>、<FilterBar>、<EmptyPanel>
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { liveQuery } from 'dexie';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import StageTag from '../components/common/StageTag';
import { usePondStore } from '../stores/pondStore';
import {
  ASSAY_VERDICT_OPTIONS,
  type Assay,
  type AssayDraft,
  type AssayVerdict,
} from '../types/assay';
import { ASSAY_THRESHOLD, autoVerdict, effectiveVerdict, ionEquivalent } from '../utils/brine';
import { db, putAssay, removeAssay } from '../utils/db';
import { nowIso, today, uuid } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

const VERDICT_STYLE: Record<AssayVerdict, string> = {
  达标: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  接近: 'border-amber-300 bg-amber-50 text-amber-700',
  未达标: 'border-slate-300 bg-slate-100 text-slate-500',
};

function emptyDraft(pondId: string): AssayDraft {
  return {
    pondId,
    date: today(),
    liGpl: 0.5,
    kGpl: 12,
    mgGpl: 20,
    naGpl: 50,
    labName: '盐湖中心化验室',
    verdict: '未达标',
    verdictManual: false,
  };
}

export default function AssayEntry() {
  const pondStore = usePondStore();

  const [rows, setRows] = createSignal<Assay[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal<Assay | null>(null);
  const [message, setMessage] = createSignal('');
  const [keyword, setKeyword] = createSignal('');
  const [from, setFrom] = createSignal('');
  const [to, setTo] = createSignal('');
  const [curvePondId, setCurvePondId] = createSignal('');
  const [draft, setDraft] = createStore<AssayDraft>(emptyDraft(''));

  onMount(() => {
    void pondStore.loadAll();
    const subscription = liveQuery(async () => {
      const list = await db.assays.toArray();
      return list.sort((a, b) => a.date.localeCompare(b.date));
    }).subscribe({
      next: (list) => {
        setRows(list);
        setLoading(false);
      },
      error: (err: unknown) => {
        setMessage(err instanceof Error ? err.message : '读取化验数据失败');
        setLoading(false);
      },
    });
    onCleanup(() => {
      subscription.unsubscribe();
    });
  });

  const pondOf = (pondId: string) => pondStore.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  const filtered = createMemo<Assay[]>(() => {
    const series = pondStore.state.currentSeries;
    const key = keyword().trim().toLowerCase();
    return rows().filter((row) => {
      const pond = pondOf(row.pondId);
      if (series !== null && pond?.seriesName !== series) return false;
      if (from() !== '' && row.date < from()) return false;
      if (to() !== '' && row.date > to()) return false;
      if (key === '') return true;
      return (
        pondLabel(row.pondId).toLowerCase().includes(key) ||
        row.labName.toLowerCase().includes(key) ||
        row.date.includes(key)
      );
    });
  });

  const stats = createMemo(() => {
    const list = filtered();
    const pass = list.filter((row) => effectiveVerdict(row) === '达标').length;
    const near = list.filter((row) => effectiveVerdict(row) === '接近').length;
    const fail = list.filter((row) => effectiveVerdict(row) === '未达标').length;
    const readyPonds = new Set(list.filter((row) => effectiveVerdict(row) === '达标').map((row) => row.pondId)).size;
    return {
      total: list.length,
      pass,
      near,
      fail,
      readyPonds,
      passPct: list.length === 0 ? 0 : Math.round((pass / list.length) * 1000) / 10,
    };
  });

  const previewVerdict = createMemo<AssayVerdict>(() => autoVerdict(draft.liGpl, draft.kGpl));

  /** 组分曲线：按池与日期区间叠加 Li⁺ 与 K⁺ 折线 */
  const curve = createMemo(() => {
    const pondId = curvePondId();
    const list = rows()
      .filter((row) => row.pondId === pondId)
      .filter((row) => (from() === '' || row.date >= from()) && (to() === '' || row.date <= to()))
      .sort((a, b) => a.date.localeCompare(b.date));
    const width = 660;
    const height = 200;
    const padX = 44;
    const padY = 18;
    if (list.length === 0) {
      return { list, width, height, liPath: '', kPath: '', labels: [] as Array<{ x: number; text: string }>, maxLi: 1, maxK: 1, stepX: 0 };
    }
    const maxLi = Math.max(ASSAY_THRESHOLD.liPass * 1.4, ...list.map((row) => row.liGpl));
    const maxK = Math.max(ASSAY_THRESHOLD.kPass * 1.3, ...list.map((row) => row.kGpl));
    const stepX = list.length === 1 ? 0 : (width - padX * 2) / (list.length - 1);
    const x = (index: number): number => padX + stepX * index;
    const yLi = (value: number): number => height - padY - (value / maxLi) * (height - padY * 2);
    const yK = (value: number): number => height - padY - (value / maxK) * (height - padY * 2);
    const liPath = list.map((row, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${yLi(row.liGpl)}`).join(' ');
    const kPath = list.map((row, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${yK(row.kGpl)}`).join(' ');
    const labels = list.map((row, index) => ({ x: x(index), text: row.date.slice(5) }));
    return { list, width, height, liPath, kPath, labels, maxLi, maxK, stepX };
  });

  const openCreate = (): void => {
    const pondId =
      curvePondId() !== ''
        ? curvePondId()
        : (pondStore.pondsOfSeries(pondStore.state.currentSeries)[0]?.id ?? pondStore.state.ponds[0]?.id ?? '');
    setEditingId(null);
    setDraft(emptyDraft(pondId));
    setDialogOpen(true);
  };

  const openEdit = (row: Assay): void => {
    setEditingId(row.id);
    setDraft({
      pondId: row.pondId,
      date: row.date,
      liGpl: row.liGpl,
      kGpl: row.kGpl,
      mgGpl: row.mgGpl,
      naGpl: row.naGpl,
      labName: row.labName,
      verdict: row.verdict,
      verdictManual: row.verdictManual,
    });
    setDialogOpen(true);
  };

  const submit = async (): Promise<void> => {
    if (draft.pondId === '') {
      setMessage('请选择蒸发池');
      return;
    }
    const payload: Omit<Assay, 'createdAt' | 'updatedAt' | 'revision'> = {
      id: editingId() ?? uuid('assay'),
      pondId: draft.pondId,
      date: draft.date,
      liGpl: draft.liGpl,
      kGpl: draft.kGpl,
      mgGpl: draft.mgGpl,
      naGpl: draft.naGpl,
      labName: draft.labName.trim() || '未填写化验室',
      verdict: draft.verdictManual ? draft.verdict : previewVerdict(),
      verdictManual: draft.verdictManual,
    };
    if (editingId() === null) {
      const stamp = nowIso();
      await putAssay({ ...payload, createdAt: stamp, updatedAt: stamp, revision: 2 });
      setMessage(
        payload.verdict === '达标'
          ? `已录入 ${pondLabel(payload.pondId)} 的化验记录，判定达标，该池进入出卤候选`
          : `已录入 ${pondLabel(payload.pondId)} 的化验记录，判定为「${payload.verdict}」`,
      );
    } else {
      const existing = rows().find((row) => row.id === editingId());
      if (existing === undefined) return;
      await putAssay({ ...existing, ...payload });
      setMessage('化验记录已更新');
    }
    setDialogOpen(false);
  };

  const confirmDelete = async (): Promise<void> => {
    const row = deleting();
    if (row === null) return;
    await removeAssay(row.id);
    setDeleting(null);
    setMessage('化验记录已删除');
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="化验记录" value={stats().total} suffix="条" tone="primary" />
        <StatBadge label="达标" value={stats().pass} suffix="条" tone="success" />
        <StatBadge label="接近" value={stats().near} suffix="条" tone="warning" />
        <StatBadge label="未达标" value={stats().fail} suffix="条" tone="default" />
        <StatBadge label="达标占比" value={`${stats().passPct}%`} percent={stats().passPct} tone="success" />
        <StatBadge
          label="出卤候选池"
          value={stats().readyPonds}
          suffix="口"
          tone={stats().readyPonds > 0 ? 'success' : 'default'}
          hint="区间内存在达标化验记录的池数量"
        />
      </div>

      <Show when={message() !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">{message()}</div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">离子组分分析录入与达标判定</h2>
          <button type="button" class={BTN_PRIMARY} onClick={openCreate} disabled={pondStore.state.ponds.length === 0}>
            + 录入化验
          </button>
        </header>

        <FilterBar
          keyword={keyword()}
          onKeyword={setKeyword}
          fields={[{ key: 'series', label: '池系', options: pondStore.seriesOptions() }]}
          values={{ series: pondStore.state.currentSeries ?? 'all' }}
          onChange={(key, value) => {
            if (key === 'series') pondStore.setCurrentSeries(value === 'all' ? null : value);
          }}
          onReset={() => {
            setKeyword('');
            setFrom('');
            setTo('');
            pondStore.setCurrentSeries(pondStore.seriesOptions()[0] ?? null);
          }}
          resultText={`命中 ${filtered().length} / ${rows().length} 条`}
        >
          <label class="flex items-center gap-1.5 text-[13px] text-slate-600">
            <span>日期区间</span>
            <input
              type="date"
              class="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
              value={from()}
              onInput={(event) => setFrom(event.currentTarget.value)}
            />
            <span class="text-slate-400">至</span>
            <input
              type="date"
              class="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
              value={to()}
              onInput={(event) => setTo(event.currentTarget.value)}
            />
          </label>
        </FilterBar>

        <Show when={rows().length === 0 && !loading()}>
          <EmptyPanel
            title="还没有离子组分分析记录"
            description="录入 Li⁺ / K⁺ / Mg²⁺ / Na⁺ 浓度，系统按阈值自动判定达标情况，判定达标的池会自动进入出卤候选。"
            actionText="录入第一条化验"
            onAction={openCreate}
          />
        </Show>

        <Show when={rows().length > 0}>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[1080px] border-collapse text-sm">
              <thead>
                <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                  <th class="px-3 py-2">蒸发池</th>
                  <th class="px-3 py-2">阶段</th>
                  <th class="px-3 py-2">取样日期</th>
                  <th class="px-3 py-2 text-right">Li⁺（g/L）</th>
                  <th class="px-3 py-2 text-right">K⁺（g/L）</th>
                  <th class="px-3 py-2 text-right">Mg²⁺（g/L）</th>
                  <th class="px-3 py-2 text-right">Na⁺（g/L）</th>
                  <th class="px-3 py-2 text-right">当量合计（meq/L）</th>
                  <th class="px-3 py-2">化验室</th>
                  <th class="px-3 py-2">判定</th>
                  <th class="px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                <For each={filtered()}>
                  {(row) => {
                    const verdict = (): AssayVerdict => effectiveVerdict(row);
                    return (
                      <tr class="border-b border-slate-100 hover:bg-slate-50/60">
                        <td class="px-3 py-2.5">{pondLabel(row.pondId)}</td>
                        <td class="px-3 py-2.5">
                          <StageTag stage={pondOf(row.pondId)?.stage ?? null} size="sm" />
                        </td>
                        <td class="px-3 py-2.5">{row.date}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums">{row.liGpl}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums">{row.kGpl}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums">{row.mgGpl}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums">{row.naGpl}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums">
                          {ionEquivalent(row.liGpl, row.kGpl, row.mgGpl, row.naGpl)}
                        </td>
                        <td class="px-3 py-2.5 text-xs text-slate-500">{row.labName}</td>
                        <td class="px-3 py-2.5">
                          <span class={`rounded border px-1.5 py-0.5 text-[11px] ${VERDICT_STYLE[verdict()]}`}>
                            {verdict()}
                            {row.verdictManual ? ' · 人工' : ''}
                          </span>
                        </td>
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
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </Show>

        <Show when={filtered().length === 0 && rows().length > 0}>
          <EmptyPanel
            title="没有符合筛选条件的化验记录"
            description="可以放宽日期区间或切换池系，或直接重置筛选。"
            actionText="重置筛选"
            onAction={() => {
              setKeyword('');
              setFrom('');
              setTo('');
            }}
          />
        </Show>
      </section>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">组分曲线（Li⁺ / K⁺）</h2>
          <label class="flex items-center gap-1.5 text-[13px] text-slate-600">
            <span>蒸发池</span>
            <select
              class="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
              value={curvePondId()}
              onChange={(event) => setCurvePondId(event.currentTarget.value)}
            >
              <option value="">请选择池</option>
              <For each={pondStore.state.ponds}>
                {(pond) => (
                  <option value={pond.id}>
                    {pond.code} · {pond.seriesName}
                  </option>
                )}
              </For>
            </select>
          </label>
        </header>

        <Show
          when={curve().list.length > 0}
          fallback={
            <EmptyPanel
              title="暂无可绘制的组分数据"
              description="先选择一口有化验记录的蒸发池，或先在表格中录入化验记录。"
            />
          }
        >
          <div class="overflow-x-auto">
            <svg width={curve().width} height={curve().height} class="min-w-[660px]">
              <line
                x1="40"
                y1={curve().height - 18}
                x2={curve().width - 12}
                y2={curve().height - 18}
                stroke="#cbd5e1"
                stroke-width="1"
              />
              <line x1="40" y1="10" x2="40" y2={curve().height - 18} stroke="#cbd5e1" stroke-width="1" />
              <path d={curve().liPath} fill="none" stroke="#1e6f89" stroke-width="2.5" />
              <path d={curve().kPath} fill="none" stroke="#cf9a30" stroke-width="2.5" stroke-dasharray="6 4" />
              <For each={curve().list}>
                {(row, index) => (
                  <g>
                    <circle
                      cx={44 + (curve().list.length === 1 ? 0 : ((curve().width - 88) / (curve().list.length - 1)) * index())}
                      cy={curve().height - 18 - (row.liGpl / Math.max(1.4, ...curve().list.map((item) => item.liGpl))) * (curve().height - 36)}
                      r="3.5"
                      fill="#1e6f89"
                    />
                    <text
                      x={44 + (curve().list.length === 1 ? 0 : ((curve().width - 88) / (curve().list.length - 1)) * index())}
                      y={curve().height - 4}
                      text-anchor="middle"
                      font-size="10"
                      fill="#94a3b8"
                    >
                      {row.date.slice(5)}
                    </text>
                  </g>
                )}
              </For>
            </svg>
          </div>
          <div class="mt-2 flex flex-wrap gap-4 text-xs text-slate-500">
            <span class="flex items-center gap-1">
              <i class="inline-block h-0.5 w-5 bg-brine-600" /> Li⁺（g/L）
            </span>
            <span class="flex items-center gap-1">
              <i class="inline-block h-0.5 w-5 bg-salt-500" /> K⁺（g/L）
            </span>
            <span>
              达标阈值：Li⁺ ≥ {ASSAY_THRESHOLD.liPass} g/L 且 K⁺ ≥ {ASSAY_THRESHOLD.kPass} g/L
            </span>
          </div>
        </Show>
      </section>

      <AppDialog
        open={dialogOpen()}
        title={editingId() === null ? '录入离子组分分析' : '编辑离子组分分析'}
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
            <span>取样日期</span>
            <input type="date" class={INPUT} value={draft.date} onInput={(event) => setDraft('date', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>Li⁺（g/L）</span>
            <input
              type="number"
              step="0.01"
              class={INPUT}
              value={draft.liGpl}
              onInput={(event) => setDraft('liGpl', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>K⁺（g/L）</span>
            <input
              type="number"
              step="0.1"
              class={INPUT}
              value={draft.kGpl}
              onInput={(event) => setDraft('kGpl', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>Mg²⁺（g/L）</span>
            <input
              type="number"
              step="0.1"
              class={INPUT}
              value={draft.mgGpl}
              onInput={(event) => setDraft('mgGpl', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>Na⁺（g/L）</span>
            <input
              type="number"
              step="0.1"
              class={INPUT}
              value={draft.naGpl}
              onInput={(event) => setDraft('naGpl', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>化验室</span>
            <input class={INPUT} value={draft.labName} onInput={(event) => setDraft('labName', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>判定方式</span>
            <span class="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                checked={draft.verdictManual}
                onChange={(event) => setDraft('verdictManual', event.currentTarget.checked)}
              />
              <span class="text-slate-500">人工覆盖自动判定</span>
            </span>
          </label>
          <Show when={draft.verdictManual}>
            <label class="flex flex-col gap-1 text-[13px] text-slate-600 sm:col-span-2">
              <span>人工判定结果</span>
              <select
                class={INPUT}
                value={draft.verdict}
                onChange={(event) => setDraft('verdict', event.currentTarget.value as AssayVerdict)}
              >
                <For each={ASSAY_VERDICT_OPTIONS}>{(verdict) => <option value={verdict}>{verdict}</option>}</For>
              </select>
            </label>
          </Show>
        </div>
        <p class="mt-3 rounded-md bg-brine-50 px-3 py-2 text-xs leading-relaxed text-brine-800">
          自动判定结果为「{previewVerdict()}」；当量合计{' '}
          <span class="tabular-nums font-semibold">
            {ionEquivalent(draft.liGpl, draft.kGpl, draft.mgGpl, draft.naGpl)} meq/L
          </span>
          。判定达标的池会自动进入出卤候选。
        </p>
      </AppDialog>

      <AppDialog
        open={deleting() !== null}
        title="确认删除化验记录？"
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
          将删除「{pondLabel(deleting()?.pondId ?? '')}」在 {deleting()?.date} 的化验记录，删除后该池可能不再属于出卤候选。
        </p>
      </AppDialog>
    </div>
  );
}
