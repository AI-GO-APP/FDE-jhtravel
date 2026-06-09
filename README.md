# 旅遊團控系統 — 第一階段地基 Prototype

依《第一階段地基規格書 V1.0》資料模型 + 《流程補充 V1.1》四條關鍵流程實作的可執行雛形。
**零外部依賴**,使用 Node.js 內建 `node:sqlite` + `node:http`。

## 啟動方式

```powershell
cd "C:\Users\apin2\Downloads\吉航\團控系統_prototype"
node server.js
```

開啟瀏覽器 → **http://localhost:3000**

> 每次啟動會重建乾淨的種子資料(`tour.db`),方便重複展示。

## 檔案結構

| 檔案 | 內容 |
| --- | --- |
| `db.js` | 資料表 schema(對應 V1.0 全部主檔/團務/財務表)+ V1.1 欄位調整 + 種子資料 |
| `flows.js` | 核心業務流程 A/B/C/D(交易 + 鎖) |
| `server.js` | HTTP 伺服器、API 路由、背景排程(每 30 秒) |
| `public/index.html` | 前台(團期列表/詳情/報名)+ 後台(團控管理/訂單詳情)單頁介面 |
| `smoke-test.js` | 端對端煙霧測試:自動起 server → 驗證流程 A/B/C/D + 契約(17 項斷言) |

## 跑測試

```powershell
node smoke-test.js
```
會自動啟動子行程伺服器、跑完斷言再關閉;全過 exit 0,任一失敗 exit 1。
(一律用 Node http client 送純 UTF-8,避免 Windows shell/curl 把中文重新編碼。)

## 對應規格的實作

### 資料模型(V1.0)
完整建立 14 張表:`product`、`passenger_type`、`resource_type`、`consumption_rule`、
`customer`、`contract_template`、`tour`、`tour_inventory`、`tour_price`、`order`、
`order_item`、`traveler`、`member_contract`、`payment`。

V1.1 欄位調整已併入:
- `order.status`(待付訂金/已確認/逾期取消/取消)、`hold_expire_at`、`cancel_reason`、`refund_amount`
- `tour.status`(報名中/已成團/不成團取消)、`confirmed_at`
- `payment.payment_type`(訂金/尾款)

### 四條關鍵流程(V1.1)

| 流程 | 說明 | 實作位置 |
| --- | --- | --- |
| **A 報名扣庫存(防超賣鎖)** | 交易內 `BEGIN IMMEDIATE` 取寫鎖 → 依 `consumption_rule` 算扣量 → 任一資源不足整筆 rollback | `flows.createOrder` |
| **B 佔位與自動釋放** | 建單即扣庫存設 `hold_expire_at`(24h);付訂金→已確認;逾期由排程回收→逾期取消 | `flows.createOrder` / `payOrder` / `releaseExpiredHolds` |
| **C 取消還庫存** | 防呆(已取消不重複歸還)→ 重算 order_item 還庫存 → 標記應退款 | `flows.cancelOrder` |
| **D 成團/不成團判定** | 已確認且 `counts_toward_min` 的人數 ≥ `min_pax` → 已成團;截止日未達 → 不成團取消+全團退訂 | `flows.evaluateFormation` / `checkDeadlines` |

### 防超賣鎖說明
SQLite 以 `BEGIN IMMEDIATE` 立即取得 write lock,效果等同悲觀鎖
`SELECT ... FOR UPDATE`:同一時間只有一個交易能改庫存,保證兩人不會同時通過庫存檢查。
多通路(官網/同業)共用同一份 `tour_inventory`。

## 操作示範路線(建議展示順序)

1. **前台** → 團期列表 → 點「花蓮二日遊 HL2-0701」(車位僅 8,易展示超賣)
2. 報名 5 位大人 → 建立訂單(扣 5 車位)
3. 再報名 4 位大人 → 系統擋下「車位僅剩 3」(**防超賣**)
4. 切到**後台** → 進入該團 → 對訂單「收訂金」→ 狀態轉「已確認」、看成團進度
5. 對待付訂金訂單按「模擬逾期」→ 上方「釋放逾期未付佔位」→ 庫存回收(**流程B**)
6. 對已確認訂單「取消」→ 庫存歸還、出現應退款(**流程C**)
7. 後台上方「截止日成團/不成團判定」→ 團3(截止日已到、未滿)轉「不成團取消」(**流程D**)
8. 訂單明細頁可「產生並簽署報名契約」(V1.0 流程四)

## 主要 API

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/api/tours` | 團期列表(含可售名額、成團進度) |
| GET | `/api/tours/:id` | 團期詳情(庫存/售價) |
| POST | `/api/orders` | 建立訂單(流程A/B) |
| POST | `/api/orders/:id/pay` | 收款(訂金→已確認) |
| POST | `/api/orders/:id/cancel` | 取消(流程C) |
| POST | `/api/orders/:id/sign` | 簽署契約 |
| GET | `/api/admin/tours/:id` | 後台團控(報名/庫存/進度) |
| GET | `/api/orders/:id` | 訂單詳情 |
| POST | `/api/jobs/release-expired` | 釋放逾期佔位(流程B) |
| POST | `/api/jobs/check-deadlines` | 截止判定(流程D) |

## 範圍說明
本雛形聚焦第一階段「報名→扣庫存→成團判定→收款→契約」閉環。
**不含**:採購發包、成本核銷、損益、代收轉付、配房、開票、簽證、報表
(屬規格書「不包含」與第二階段:`inventory_ledger`、`cost_entry` 等)。
