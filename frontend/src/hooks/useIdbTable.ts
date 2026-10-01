/**
 * Dexie 单表增删改查 + liveQuery 响应式订阅封装（Solid 版）
 * 返回 Solid Accessor，页面只读 accessor，禁止把跨页状态留在组件内部 signal 中。
 */
import { createSignal, onCleanup, type Accessor } from 'solid-js';
import { liveQuery, type Table } from 'dexie';
import { ROW_REVISION } from '../utils/db';
import { nowIso, uuid } from '../utils/id';

/** 所有持久化实体共有的行结构 */
export interface IdbRow {
  id: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新增记录入参：id / 时间戳 / 修订号由封装层补齐 */
export type NewRow<T extends IdbRow> = Omit<T, 'id' | 'createdAt' | 'updatedAt' | 'revision'> & {
  id?: string;
};

export interface UseIdbTableOptions<T extends IdbRow> {
  /** 是否按 updatedAt 倒序，默认 true */
  sortByUpdatedAt?: boolean;
  onChange?: (rows: T[]) => void;
}

export interface UseIdbTableResult<T extends IdbRow> {
  rows: Accessor<T[]>;
  loading: Accessor<boolean>;
  /** 是否已完成首次载入：用于区分「数据为空」与「尚未读取」 */
  ready: Accessor<boolean>;
  error: Accessor<string>;
  refresh: () => Promise<void>;
  getById: (id: string) => Promise<T | undefined>;
  create: (payload: NewRow<T>, idPrefix?: string) => Promise<T>;
  update: (id: string, patch: Partial<T>) => Promise<void>;
  upsert: (row: T) => Promise<void>;
  remove: (id: string) => Promise<void>;
  bulkPut: (rows: T[]) => Promise<void>;
  clear: () => Promise<void>;
}

export function useIdbTable<T extends IdbRow>(
  table: Table<T, string>,
  options: UseIdbTableOptions<T> = {},
): UseIdbTableResult<T> {
  const { sortByUpdatedAt = true, onChange } = options;

  const [rows, setRows] = createSignal<T[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [ready, setReady] = createSignal(false);
  const [error, setError] = createSignal('');

  const applySort = (list: T[]): T[] => {
    if (!sortByUpdatedAt) return [...list];
    return [...list].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  };

  const subscription = liveQuery(async () => applySort(await table.toArray())).subscribe({
    next: (list) => {
      setRows(list as T[]);
      setReady(true);
      setLoading(false);
      setError('');
      onChange?.(list as T[]);
    },
    error: (err: unknown) => {
      setError(err instanceof Error ? err.message : '订阅本地数据失败');
      setLoading(false);
    },
  });

  onCleanup(() => {
    subscription.unsubscribe();
  });

  const refresh = async (): Promise<void> => {
    setLoading(true);
    try {
      const list = applySort(await table.toArray());
      setRows(list);
      setReady(true);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取本地数据失败');
    } finally {
      setLoading(false);
    }
  };

  const create = async (payload: NewRow<T>, idPrefix = 'row'): Promise<T> => {
    const stamp = nowIso();
    const record = {
      ...(payload as object),
      id: payload.id ?? uuid(idPrefix),
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    } as T;
    await table.put(record);
    return record;
  };

  const update = async (id: string, patch: Partial<T>): Promise<void> => {
    await table.update(id, { ...patch, updatedAt: nowIso() } as never);
  };

  const upsert = async (row: T): Promise<void> => {
    await table.put({ ...row, updatedAt: nowIso() });
  };

  const remove = async (id: string): Promise<void> => {
    await table.delete(id);
  };

  const bulkPut = async (list: T[]): Promise<void> => {
    await table.bulkPut(list);
  };

  const clear = async (): Promise<void> => {
    await table.clear();
  };

  return {
    rows,
    loading,
    ready,
    error,
    refresh,
    getById: (id: string) => table.get(id),
    create,
    update,
    upsert,
    remove,
    bulkPut,
    clear,
  };
}
