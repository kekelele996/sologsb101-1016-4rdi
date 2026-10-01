/**
 * /ponds 蒸发池与池系台账
 * 新建池、按池系与阶段筛选；卡片回显当期密度与最近观测日期。
 * 消费模型：Pond、Observation；复用组件：<StageTag>、<EmptyPanel>、<FilterBar>、<StatBadge>
 */
import { For, Show, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import { useNavigate } from '@solidjs/router';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import StageTag from '../components/common/StageTag';
import { usePondStore } from '../stores/pondStore';
import { POND_STAGE_OPTIONS, POND_STATUS_OPTIONS, type Pond, type PondDraft, type PondStage } from '../types/pond';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

const DEFAULT_DRAFT: PondDraft = {
  code: '',
  seriesName: '北部一系',
  areaM2: 8000,
  depthCm: 40,
  stage: '钠盐',
  status: '在用',
};

export default function PondList() {
  const store = usePondStore();
  const navigate = useNavigate();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [deletingPond, setDeletingPond] = createSignal<Pond | null>(null);
  const [message, setMessage] = createSignal('');
  const [draft, setDraft] = createStore<PondDraft>({ ...DEFAULT_DRAFT });

  onMount(() => {
    void store.loadAll();
  });

  const openCreate = (): void => {
    setEditingId(null);
    setDraft({ ...DEFAULT_DRAFT, seriesName: store.state.currentSeries ?? '北部一系' });
    setDialogOpen(true);
  };

  const openEdit = (pond: Pond): void => {
    setEditingId(pond.id);
    setDraft({
      code: pond.code,
      seriesName: pond.seriesName,
      areaM2: pond.areaM2,
      depthCm: pond.depthCm,
      stage: pond.stage,
      status: pond.status,
    });
    setDialogOpen(true);
  };

  const submit = async (): Promise<void> => {
    if (draft.code.trim() === '') {
      setMessage('请填写池号');
      return;
    }
    if (editingId() === null) {
      const row = await store.createPond({ ...draft });
      setMessage(`已新建蒸发池「${row.code}」，可继续配置闸门串级走向`);
      setDialogOpen(false);
      navigate('/gates');
    } else {
      await store.updatePond(editingId() as string, { ...draft });
      setMessage('蒸发池信息已更新');
      setDialogOpen(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    const pond = deletingPond();
    if (pond === null) return;
    await store.deletePond(pond.id);
    setDeletingPond(null);
    setMessage(`已删除蒸发池「${pond.code}」及其闸门、观测、化验与走水计划`);
  };

  const stageDistribution = (): Record<PondStage, number> => store.stageDistribution();
  const readyPonds = (): number =>
    store.state.ponds.filter((pond) => store.statOf(pond.id).dischargeReady).length;

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="蒸发池总数" value={store.state.ponds.length} suffix="口" tone="primary" />
        <StatBadge
          label="在用池"
          value={store.state.ponds.filter((pond) => pond.status === '在用').length}
          suffix="口"
          tone="success"
        />
        <StatBadge label="钠盐池" value={stageDistribution()['钠盐']} suffix="口" tone="info" />
        <StatBadge label="钾盐池" value={stageDistribution()['钾盐']} suffix="口" tone="warning" />
        <StatBadge label="锂盐池" value={stageDistribution()['锂盐']} suffix="口" tone="success" />
        <StatBadge
          label="出卤候选池"
          value={readyPonds()}
          suffix="口"
          tone={readyPonds() > 0 ? 'success' : 'default'}
          hint="最近一次离子组分分析判定为「达标」的池"
        />
        <StatBadge label="闸门串级" value={store.state.gates.length} suffix="条" tone="default" size="sm" />
      </div>

      <Show when={message() !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {message()}
        </div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">蒸发池与池系台账</h2>
          <button type="button" class={BTN_PRIMARY} onClick={openCreate}>
            + 新建蒸发池
          </button>
        </header>

        <FilterBar
          keyword={store.pondFilters().keyword}
          onKeyword={(value) => store.patchFilters({ keyword: value })}
          fields={[
            {
              key: 'series',
              label: '池系',
              options: store.seriesOptions(),
            },
            { key: 'stage', label: '阶段', options: [...POND_STAGE_OPTIONS] },
          ]}
          values={{ series: store.state.currentSeries ?? 'all', stage: store.pondFilters().stage }}
          onChange={(key, value) => {
            if (key === 'series') store.setCurrentSeries(value === 'all' ? null : value);
            if (key === 'stage') store.patchFilters({ stage: value as PondStage | 'all' });
          }}
          onReset={() => store.resetFilters()}
          resultText={`命中 ${store.visiblePonds().length} / ${store.state.ponds.length} 口`}
        />

        <Show when={store.state.ready && store.state.ponds.length === 0}>
          <EmptyPanel
            title="还没有蒸发池"
            description="先建立池系与蒸发池（池号、面积、有效水深、阶段），再配置闸门串级走向与卤水日观测。"
            actionText="新建第一口蒸发池"
            onAction={openCreate}
          />
        </Show>

        <Show when={store.state.ponds.length > 0}>
          <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <For each={store.visiblePonds()}>
              {(pond) => {
                const stat = (): ReturnType<typeof store.statOf> => store.statOf(pond.id);
                return (
                  <article class="flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3.5">
                    <div class="flex items-start justify-between gap-2">
                      <div>
                        <p class="text-sm font-semibold text-slate-800">{pond.code}</p>
                        <p class="text-xs text-slate-500">{pond.seriesName}</p>
                      </div>
                      <StageTag stage={pond.stage} status={pond.status} size="sm" />
                    </div>
                    <dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-600">
                      <div>
                        <dt class="text-slate-400">面积</dt>
                        <dd class="tabular-nums">{pond.areaM2.toLocaleString('zh-CN')} ㎡</dd>
                      </div>
                      <div>
                        <dt class="text-slate-400">有效水深</dt>
                        <dd class="tabular-nums">{pond.depthCm} cm</dd>
                      </div>
                      <div>
                        <dt class="text-slate-400">有效体积</dt>
                        <dd class="tabular-nums">{stat().volumeM3.toLocaleString('zh-CN')} m³</dd>
                      </div>
                      <div>
                        <dt class="text-slate-400">观测条数</dt>
                        <dd class="tabular-nums">{stat().observationCount} 条</dd>
                      </div>
                      <div>
                        <dt class="text-slate-400">当期密度</dt>
                        <dd class="tabular-nums font-medium text-brine-700">
                          {stat().currentDensity > 0 ? `${stat().currentDensity} g/cm³` : '无观测'}
                        </dd>
                      </div>
                      <div>
                        <dt class="text-slate-400">最近蒸发量</dt>
                        <dd class="tabular-nums">{stat().lastEvapMm > 0 ? `${stat().lastEvapMm} mm/d` : '—'}</dd>
                      </div>
                      <div>
                        <dt class="text-slate-400">最近观测</dt>
                        <dd>{stat().lastObservationDate === '' ? '—' : stat().lastObservationDate}</dd>
                      </div>
                      <div>
                        <dt class="text-slate-400">串级</dt>
                        <dd>
                          入 {stat().inboundGates} / 出 {stat().outboundGates}
                        </dd>
                      </div>
                    </dl>
                    <div class="flex flex-wrap items-center gap-2 pt-1">
                      <span
                        class={`rounded border px-1.5 py-0.5 text-[11px] ${
                          stat().dischargeReady
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                            : 'border-slate-300 bg-white text-slate-500'
                        }`}
                      >
                        组分判定：{stat().lastVerdict}
                      </span>
                      <span class="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] text-slate-500">
                        走水计划 {stat().scheduleCount} 条
                      </span>
                    </div>
                    <div class="flex flex-wrap gap-2 pt-1">
                      <button class="text-xs text-brine-700 hover:underline" onClick={() => openEdit(pond)}>
                        编辑
                      </button>
                      <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeletingPond(pond)}>
                        删除
                      </button>
                      <button class="text-xs text-slate-600 hover:underline" onClick={() => navigate('/gates')}>
                        配置闸门
                      </button>
                      <button class="text-xs text-slate-600 hover:underline" onClick={() => navigate('/observations')}>
                        录入观测
                      </button>
                    </div>
                  </article>
                );
              }}
            </For>
          </div>

          <Show when={store.visiblePonds().length === 0}>
            <EmptyPanel
              title="没有符合筛选条件的蒸发池"
              description="可以切换池系或阶段筛选条件，或者直接重置筛选。"
              actionText="重置筛选"
              onAction={() => store.resetFilters()}
            />
          </Show>
        </Show>
      </section>

      <AppDialog
        open={dialogOpen()}
        title={editingId() === null ? '新建蒸发池' : '编辑蒸发池'}
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
            <span>池号</span>
            <input class={INPUT} value={draft.code} onInput={(e) => setDraft('code', e.currentTarget.value)} placeholder="如：北-06" />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>所属池系</span>
            <input
              class={INPUT}
              value={draft.seriesName}
              onInput={(e) => setDraft('seriesName', e.currentTarget.value)}
              placeholder="如：北部一系"
              list="series-options"
            />
            <datalist id="series-options">
              <For each={store.seriesOptions()}>{(series) => <option value={series} />}</For>
            </datalist>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>面积（㎡）</span>
            <input
              type="number"
              class={INPUT}
              value={draft.areaM2}
              min="100"
              step="100"
              onInput={(e) => setDraft('areaM2', Number(e.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>有效水深（cm）</span>
            <input
              type="number"
              class={INPUT}
              value={draft.depthCm}
              min="5"
              step="1"
              onInput={(e) => setDraft('depthCm', Number(e.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>蒸发阶段</span>
            <select class={INPUT} value={draft.stage} onChange={(e) => setDraft('stage', e.currentTarget.value as PondStage)}>
              <For each={POND_STAGE_OPTIONS}>{(stage) => <option value={stage}>{stage}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>运行状态</span>
            <select class={INPUT} value={draft.status} onChange={(e) => setDraft('status', e.currentTarget.value as PondDraft['status'])}>
              <For each={POND_STATUS_OPTIONS}>{(status) => <option value={status}>{status}</option>}</For>
            </select>
          </label>
        </div>
        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          保存后该池会进入闸门配置入口；有效体积 = 面积 × 有效水深 ÷ 100 ={' '}
          <span class="tabular-nums font-medium text-slate-700">
            {Math.round(draft.areaM2 * (draft.depthCm / 100) * 10) / 10} m³
          </span>
        </p>
      </AppDialog>

      <AppDialog
        open={deletingPond() !== null}
        title="确认删除蒸发池？"
        width="max-w-lg"
        onClose={() => setDeletingPond(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeletingPond(null)}>
              取消
            </button>
            <button class={BTN_DANGER} onClick={() => void confirmDelete()}>
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除「{deletingPond()?.code}」及其相关的闸门串级、卤水日观测、离子组分分析与走水编排，操作不可恢复。
        </p>
      </AppDialog>
    </div>
  );
}
