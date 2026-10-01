# 盐湖蒸发池卤水晒程编排台（sologsb101-1016）

面向盐湖提锂 / 提钾车间的晒程调度员：把盐田内每口蒸发池的卤水走向按串级关系编排，
逐日跟踪密度、温度与离子组分变化，估算蒸发量，编排走水与出卤时点。

**纯前端单页应用**：无后端、无数据库服务、无 API 调用，数据全部保存在浏览器本地（IndexedDB），
容器完全无状态、不挂载任何数据卷。

---

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动后访问：**http://localhost:22816**

常用命令：

```bash
docker compose ps                  # 查看容器状态
docker compose logs -f frontend    # 查看 nginx 日志
docker compose down                # 停止并移除容器
docker compose up -d --build       # 改完代码后重新构建
```

> 端口可通过 `.env` 里的 `FRONTEND_PORT` 覆盖；容器名与镜像名前缀由 `COMPOSE_PROJECT_NAME` 控制。
> `docker-compose.yml` 顶层已写 `name: gbbrinepond` 兜底，因此在任意目录名（含中文）下
> `docker compose config --quiet` 都不会报错。

---

## 二、技术栈

| 分层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | SolidJS 1.9 | 细粒度响应式，无虚拟 DOM |
| 语言 | TypeScript 5 | `strict` 模式，`tsc --noEmit` 零错误 |
| 构建 | Vite 6 | 开发端口与宿主端口一致（22816） |
| 路由 | @solidjs/router 0.15 | `Router root={App}` 布局路由，全部路径支持深链刷新 |
| 状态管理 | Solid 原生能力 | `createStore`（pondStore / scheduleStore）+ `createSignal`（observationStore），**不使用 Pinia / Zustand** |
| UI | Tailwind CSS 3.4 | 全部界面手写 Tailwind，**不使用 Element Plus / Ant Design / Vue / React** |
| 本地持久化 | Dexie 4（IndexedDB） | 库名 `gbbrinepond`，`v1 → v2` 新增 `evapMm` 并迁移旧记录，`v2 → v3` 走水计划接入串级重算（锁日期 / 待重算标记 / 预计出卤日期 / 可用水量 / 开度快照） |
| 容器 | node:20-alpine → nginx:alpine | 多阶段构建，`chmod -R a+rX` 规避静态资源 403 |

---

## 三、目录结构

```
sologsb101-1016/
├── README.md
├── docker-compose.yml          # name: gbbrinepond，不写 version 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html; + gzip
    ├── .dockerignore
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── tailwind.config.js
    ├── postcss.config.js
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── index.tsx           # 入口：render + 初始化数据库
        ├── App.tsx             # 外壳：品牌栏 + 侧边导航 + 内容区（Router root 布局）
        ├── styles/main.css     # @tailwind 指令 + 全局样式
        ├── types/              # pond.ts gate.ts observation.ts assay.ts schedule.ts
        ├── stores/             # pondStore.ts observationStore.ts scheduleStore.ts
        ├── components/common/  # StageTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx AppDialog.tsx
        ├── hooks/              # useEvaporation.ts useIdbTable.ts
        ├── pages/              # 6 个模块页面
        ├── router/index.tsx    # AppRouter + ROUTES 常量 + NAV_ITEMS
        └── utils/              # brine.ts db.ts export.ts seed.ts id.ts scheduleCalc.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/ponds` | `pages/PondList.tsx` | 蒸发池与池系台账：新建/编辑/级联删除、按池系与阶段筛选，卡片回显当期密度与最近观测日期 |
| `/gates` | `pages/GateConfig.tsx` | 串级走向与闸门配置：拓扑列表 + 开度就地编辑（滑块/数字），开度变化后下游受影响计划自动标记「待重算」；计划快照开度与实际开度按池号列出核对 |
| `/observations` | `pages/ObservationEntry.tsx` | 卤水日观测录入台：单条 + 批量粘贴录入，同池同日覆盖写入，蒸发量按经验公式自动估算；保存后重算本池计划预计出卤日期 |
| `/assays` | `pages/AssayEntry.tsx` | 离子组分分析：Li⁺/K⁺/Mg²⁺/Na⁺ 录入、自动达标判定（可人工覆盖）、SVG 组分曲线 |
| `/schedules` | `pages/ScheduleBoard.tsx` | 走水与出卤编排：按日期排序、HTML5 拖拽调整先后顺序、逐条推进状态、出卤回写池阶段；按池系串级走向与最近观测重算每条计划的**预计出卤日期与可用水量**，开度/观测变化后受影响计划标「待重算」，手工锁过日期的计划保住原日期、只提示冲突 |
| `/export` | `pages/ExportView.tsx` | 晒程进度汇总、JSON 结构版本查看与导入导出、CSV 汇总、重置演示数据 |

`/` 重定向到 `/ponds`，未匹配路径统一回落到 `/ponds`。
**全部路由支持直接深链**：把 `http://localhost:22816/schedules` 或 `http://localhost:22816/assays` 直接粘贴到地址栏刷新即可打开；
筛选条件还会同步到 URL query，带筛选的链接可以直接分享。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbbrinepond`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`
  * `db.version(1)`：建立全部表与 **`pondId+date` 复合索引**（`observations`、`assays`）；
  * `db.version(2)`：**新增 `evapMm` 字段**并写入真实升级迁移逻辑 ——
    `.upgrade()` 里对 `observations` 逐行检查，缺失或非法时按密度/温度/水位/风力用经验公式回填默认值；
    同时补齐 `revision` / `createdAt` / `updatedAt`、`assays.verdictManual`、`schedules.orderIndex`。
  * `db.version(3)`：**走水计划接入串级重算** —— `schedules` 新增 `lockedDate`（手工锁日期）、
    `recalcState`（待重算/已算好）、`expectedDate`（预计出卤日期）、`availableVolumeM3`（可用水量）、
    `openingSnapshot`（重算时开度快照）、`conflict` / `conflictNote`（锁日期冲突提示），
    旧记录统一补默认并标记为「待重算」；`schedules` 索引新增 `recalcState`。
* **表结构**：

  | 表 | 主键 | 主要索引 |
  | --- | --- | --- |
  | `ponds` | id | code, seriesName, stage, status, createdAt, updatedAt |
  | `gates` | id | fromPondId, toPondId, state, openingPct |
  | `observations` | id | pondId, date, **[pondId+date]**, densityGcm3, evapMm |
  | `assays` | id | pondId, date, **[pondId+date]**, verdict, verdictManual |
  | `schedules` | id | pondId, planDate, state, recalcState, orderIndex |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `ponds` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **蒸发池 → 闸门串级 / 卤水日观测 → 离子组分分析 → 走水编排** 三层互相引用：
  * 5 口蒸发池跨 2 个池系（北部一系 / 南部二系），覆盖钠盐 / 钾盐 / 锂盐三个阶段；
  * 4 条闸门串级（北-01→北-02→北-03、南-04→南-05、跨池系备用闸），1 条关闭用于验证开度联动；
  * 16 条卤水日观测（每池 2–4 条，密度随日期递增，`evapMm` 由经验公式生成）；
  * 6 条离子组分分析（覆盖达标 / 接近 / 未达标，其中 1 条为人工覆盖判定）；
  * 5 条走水编排（覆盖待排 / 已排 / 走水中 / 已出卤四种状态）。
  * 固定 id 如 `pond-north-01`、`pond-south-04` 可直接用于验证与二次开发。
* **其他本地数据**：`localStorage` 仅保存「最近选中的池系」这一界面偏好，不存业务数据。
* 删除蒸发池会**级联清理**相关闸门（上下游任一为该池）、观测、化验与走水编排（同一 Dexie 事务内完成）。

---

## 六、本地开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:22816
```

其他命令：

```bash
npm run build        # tsc --noEmit && vite build（零错误）
npm run typecheck    # 仅做 TypeScript 类型检查
npm run preview      # 预览 dist 产物
```

---

## 七、核心业务规则（`src/utils/brine.ts`）

* **密度—温度修正**：`density(25) = density(t) + 0.00035 × (t − 25)`，统一折算到 25 ℃ 便于横向比较。
* **蒸发量经验公式**：温度、风力越大蒸发越强，卤水密度越高蒸发越弱，水位低于 10 cm 时按比例折减：
  `evapMm = 5.5 × tempFactor × windFactor × brineFactor × levelFactor`。
* **密度增速**：`(末次密度 − 首次密度) / 天数`，并按当前增速外推预计密度。
* **达标判定阈值**：Li⁺ ≥ 1.0 g/L 且 K⁺ ≥ 20 g/L 为「达标」；任一项落在接近区间（Li⁺ ≥ 0.6、K⁺ ≥ 12）为「接近」，其余「未达标」。
  判定达标的池自动进入**出卤候选**；人工覆盖只改写判定标注，原始化验数值保持不变。
* **闸门过流估算**：`1.7 × 过流面积 × √水头 × 开度`，用于开度调整后的下游进水量即时反馈；开度变化会同步推导闸门状态（关闭 / 半开 / 全开）。
* **串级重算（`src/utils/scheduleCalc.ts` + `scheduleStore`）**：把闸门串级、卤水日观测与走水编排三块接起来。
  * **影响范围**：闸门开度（或配置）变化后，沿出闸闸门向下游逐池传递（`downstreamPondIds`），受影响池的未出卤计划标记为「待重算」；日观测保存/删除后本池计划同样标记。
  * **预计出卤日期**：以最近观测密度为起点，按密度增速（最小二乘线性回归，观测不足时兜底 0.002 g/cm³/d）外推到达目标密度的天数；来水按 `日来水/(日来水+日蒸发)` 稀释指数折减净增速 —— 上游开度调小→来水减少→稀释减弱→浓缩加快→预计日期提前。
  * **可用水量**：`当前蓄水 + 预计来水 − 蒸发耗水`，封顶不超过池体有效容积；当前蓄水由面积 × 最近水位估算。
  * **锁日期**：调度员手工锁定 `planDate` 后，重算只写 `expectedDate` 等派生字段，不改写计划日期；预计日期与计划日期不一致时置 `conflict` 并给出 `conflictNote`，页面按原日期执行并提示冲突。
  * **开度核对**：计划保存重算时快照各上游闸门开度（`openingSnapshot`）；闸门工记录的实际开度与快照不一致时，按池号列出供确认（`findOpeningMismatches`），两边各自管好本侧数据、互不覆盖，确认状态仅存本机。
  * **按侧重试、已算好不重复**：重算按池系分侧、串级上游优先；逐条落库、单条失败跳过并计数，重跑时只补算仍为「待重算」的计划，已算好的不再生成，已出卤的计划不再重算。
* **出卤回写**：走水状态推进到「已出卤」时，蒸发池阶段自动推进（钠盐→钾盐→锂盐），并把最新一次观测的密度回写为实际密度。
