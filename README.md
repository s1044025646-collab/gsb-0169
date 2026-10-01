# 多目标非支配排序与超体积比较后端

Windows 本地可运行的**纯后端**：TypeScript + Node.js + SQLite。只提供 HTTP API、CLI、虚构候选方案与自动化测试；**不含网页、不做自动方案搜索、不调用任何现成多目标优化库**。

支持 2~3 个有限数值目标，管理候选编号、每目标 `max/min` 方向、单位、可行性标记、冻结参考点、数据修订与比较报告。

## 算法说明（均可解释，无黑盒库）

- 统一口径：`min` 目标取负号，全部转换为“最大化坐标”后再比较。
- Pareto 支配：逐轴 `>=` 且至少一轴严格 `>`；相同坐标互不支配。
- 非支配排序：逐层剥离当前非支配集（front），得到 rank。
- 超体积 = 各点到参考点盒子的**并集体积**：
  - 2D：x 轴扫描线 + y 区间合并；
  - 3D：沿第 0 轴切片，截面再做 2D 矩形并（区间合并）。
  - **绝不**把各矩形体积直接相加而重复统计交叠；测试用少量点的容斥原理（2^n 子集枚举）独立核对。
- 单点贡献 = `HV(全集) - HV(去掉该点)`，恒非负；相同坐标不同编号各自贡献为 0，但来源编号全部保留。
- 参考点方向错误的点直接报错（`REFERENCE_POINT_INFEASIBLE_SIDE`），**不偷偷移动参考点**。
- 比较批次强制同一冻结参考点、方向与尺度；单位正比例换算时体积按各轴比例**乘积**变化。原始超体积带单位（各目标单位之积），**不是无量纲**。
- 多方案优劣只用支配/超体积表达，不使用随意加权总分。

## 依赖

- Node.js >= 20（开发环境 Node 25 已验证）
- 运行时依赖：`better-sqlite3`
- 安装：

```powershell
npm install
```

所有数据库与临时文件都在项目内的 `data/` 与 `tmp/`。

## 测试

```powershell
npm test
```

覆盖：互不支配、链式支配、重复点、零贡献、相同单轴值、混合目标方向、2D/3D 容斥交叉核对、加劣点不变、输入重排不变、贡献非负、3D 切片边界、失败路径、事务回滚、重启持久化、分页、错误码与 API 端到端。时间使用可注入时钟，重复提交用幂等键。

## 可重复演示

```powershell
npm run demo
```

使用固定数据与固定时间，重建 `tmp/demo.db` 并打印分层、超体积、单位换算、批次比较、报告编号与幂等重放。

## 启动 API（仅绑定本机，自动端口）

```powershell
npm run dev          # 直接用 tsx 运行
# 或
npm run build
npm start
```

启动后只监听 `127.0.0.1` 的操作系统自动分配端口；实际地址写入 `tmp/server.json`。查看：

```powershell
type tmp\server.json
```

自定义数据库路径：

```powershell
$env:MO_DB_PATH="data/custom.db"; npm run dev
```

停止：在运行窗口按 `Ctrl+C`（仅停止本项目该进程）。

### 端点

- `GET /health`
- `POST /batches` 导入（可带 `idempotencyKey`、`batchId`、`scale`）
- `GET /batches?limit=&offset=` 分页
- `GET /batches/:id`
- `GET /batches/:id/candidates?limit=&offset=` 分页
- `GET /batches/:id/evidence` 支配证据（含 `dominatedBy` / `dominates`，可追溯到编号）
- `GET /batches/:id/layers`
- `GET /batches/:id/contributions` 单点移除贡献
- `POST /comparisons` `{batchA,batchB,scale?}`，冻结参考点/尺度并生成报告
- `GET /reports/:id`

错误统一为 `{ "error": { "code", "message", "details?" } }`，如 `DIMENSION_MISMATCH`、`NON_FINITE_VALUE`、`INVALID_DIRECTION`、`REFERENCE_POINT_INFEASIBLE_SIDE`、`REFERENCE_POINT_MISMATCH`、`SCALE_MISMATCH`、`IDEMPOTENCY_MISMATCH`、`INVALID_PAGINATION`、`NOT_FOUND`。

## CLI

CLI 会打印关键操作前后的状态（批次数量变化、创建/幂等、层数、超体积）。

```powershell
npm run cli -- import data/seed-design-alpha.json
npm run cli -- layers design-alpha
npm run cli -- evidence design-alpha
npm run cli -- contributions design-alpha
npm run cli -- import data/seed-design-beta.json
npm run cli -- compare design-alpha design-beta
npm run cli -- list
npm run cli -- report <reportId> --out tmp/report.json
```

用独立数据库：追加 `--db=data/demo.db`。

## 迁移与进程管理

迁移以 `CREATE TABLE IF NOT EXISTS` 与 `user_version` 保护，可重复执行。启动/停止只管理本项目自身进程；不扫描或结束其它程序。
