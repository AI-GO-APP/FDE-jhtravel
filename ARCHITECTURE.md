# 架構設計文件 — 旅遊團控系統 Prototype

本文件說明本 prototype 的**分層架構、資料流、請求生命週期,以及鎖與交易的設計理由**。
使用說明與 API 清單請見 [README.md](./README.md)。

---

## 1. 設計原則

| 原則 | 說明 |
| --- | --- |
| **零外部依賴** | 只用 Node.js 內建 `node:sqlite`、`node:http`、`node:fs`。不需 `npm install`,降低環境風險,聚焦驗證商業邏輯。 |
| **流程層集中** | 所有「會動到庫存/狀態」的商業規則集中在 `flows.js`,不散落在路由或前端。庫存正確性只有一個地方需要審查。 |
| **交易為邊界** | 每條會改變庫存或訂單狀態的流程,都以一個資料庫交易為原子邊界——全成功或全回滾,不會留下「扣了一半」的中間態。 |
| **可重複展示** | 每次啟動 `freshDb()` 重建乾淨種子資料,demo 不受前一次操作污染。 |

---

## 2. 模組分層

```
┌─────────────────────────────────────────────┐
│  瀏覽器 (public/index.html)                   │  前台報名 + 後台團控,純 fetch 呼叫 API
└───────────────┬─────────────────────────────┘
                │ HTTP / JSON (UTF-8)
┌───────────────▼─────────────────────────────┐
│  server.js  — 傳輸層                          │
│   · node:http 路由(/api/*)                   │
│   · 查詢組裝 helper(listTours / orderDetail…) │  ← 唯讀查詢,不含商業規則
│   · 背景排程 setInterval(30s)                 │  ← 定時呼叫流程 B/D
│   · 錯誤分流:BusinessError→400,其他→500      │
└───────────────┬─────────────────────────────┘
                │ 函式呼叫(同步)
┌───────────────▼─────────────────────────────┐
│  flows.js  — 流程 / 商業規則層                 │
│   · createOrder      流程 A+B(扣庫存佔位)     │
│   · payOrder         流程 B(付款確認)         │
│   · cancelOrder      流程 C(取消還庫存)       │
│   · evaluateFormation/checkDeadlines 流程 D    │
│   · releaseExpiredHolds 流程 B(逾期釋放)      │
│   · tx() 交易包裹 + computeConsumption() 扣量  │
└───────────────┬─────────────────────────────┘
                │ prepared statements
┌───────────────▼─────────────────────────────┐
│  db.js  — 資料層                              │
│   · freshDb()/openDb()  連線                  │
│   · createSchema()  14 張表 DDL               │
│   · seed()  種子資料                          │
└───────────────┬─────────────────────────────┘
                │
            tour.db (SQLite,執行時產生,不進版控)
```

**分層規約:**
- `server.js` 只負責「收請求、組查詢結果、把寫入動作轉交 flows」。**它不直接寫庫存或改訂單狀態。**
- `flows.js` 是**唯一**寫入庫存/訂單狀態的地方,且每個寫入流程都包在 `tx()` 內。
- 唯讀查詢(列表、詳情)可直接在 `server.js` 用 prepared statement,因為不涉及一致性風險。

---

## 3. 一次「報名」請求的完整流向

以使用者在前台送出報名為例(流程 A + B):

```
前端 submitSignup()
  └─ POST /api/orders  { tour_id, customer, items:[{passenger_type_id, qty}] }
       │
server.js handleApi()
  └─ F.createOrder(db, body)
       │
flows.js createOrder()  ── tx(db, () => {            ← BEGIN IMMEDIATE(取得 write lock)
       │  1. 查 tour,確認狀態=報名中
       │  2. computeConsumption(items)                ← 依 consumption_rule 算各資源要扣量
       │     某資源要扣 = Σ(item.qty × rule.qty)
       │  3. 鎖內讀 tour_inventory,逐資源檢查
       │     used_qty + 要扣 ≤ total_qty ?
       │       └─ 任一不足 → throw BusinessError       ← 整筆 ROLLBACK,不扣任何東西
       │  4. 全過 → UPDATE used_qty += 要扣
       │  5. 建/取 customer
       │  6. INSERT order(狀態=待付訂金, hold_expire_at=now+24h)
       │  7. INSERT order_item(帶成交價 from tour_price)
       │  })                                          ← COMMIT
       │
  ◀── { order_id, order_no, hold_expire_at }
前端 → 顯示「報名成功,24h 內付訂金」
```

關鍵:**步驟 2~7 全在同一交易+鎖內**,確保兩個人不會同時通過步驟 3 的庫存檢查 → 這就是防超賣的核心。

---

## 4. 鎖與交易的設計理由

### 為什麼用 `BEGIN IMMEDIATE`?
規格(V1.1 流程 A)要求悲觀鎖 `SELECT ... FOR UPDATE`。SQLite 沒有列級鎖,但
`BEGIN IMMEDIATE` 會**立即取得資料庫層級的 write lock**:同一時間只有一個交易能進入
寫入狀態,其他交易必須等待。效果等同「序列化庫存操作」,達成防超賣所需的互斥。

> 真實環境換成 PostgreSQL/MySQL 時,把 `tx()` 內的讀取改成
> `SELECT ... FOR UPDATE` 鎖定該 tour 的 `tour_inventory` 各列即可,流程結構不變。

### 為什麼 `flows.js` 用同步 API?
`node:sqlite` 的 `DatabaseSync` 是同步的。在單執行緒的 Node 事件迴圈中,一個
`tx()` 從 BEGIN 到 COMMIT 之間不會被其他請求插入執行,**交易天然序列化**,
讓「檢查—扣減」這組動作不會被打斷。這對展示一致性最直觀。

### 取消為什麼用「重算」而非「沖銷」?
V1.1 第一階段刻意用「重算 order_item 還庫存」(`computeConsumption` 同一套算法
反向加回),簡單且夠用。第二階段導入 `inventory_ledger` 後,改為「反向沖銷當初那筆
扣帳」會更精準可稽核——這是預留的演進路線,屆時 `cancelOrder` 改讀分錄即可,
上層介面不動。

---

## 5. 背景排程(流程 B / D)

`server.js` 用 `setInterval(…, 30000)` 每 30 秒執行:
- `releaseExpiredHolds()` — 找 `狀態=待付訂金 且 hold_expire_at < now` 的訂單,走流程 C 還庫存,狀態轉「逾期取消」。
- `checkDeadlines()` — 找 `狀態=報名中 且 signup_deadline ≤ 今天` 的團,達門檻補成團、未達則「不成團取消」+全團退訂。

> 真實環境應換成獨立的 cron / 排程服務(避免多台 server 重複跑),且加上交易內的
> 冪等防呆——本 prototype 的 `_cancelOrderInTx` 已有「已取消不重複歸還」的防呆。
> 後台頁面另提供按鈕可手動觸發同樣的 job,方便 demo。

---

## 6. 狀態機

### 訂單 order.status
```
                付訂金
  待付訂金 ───────────────▶ 已確認
     │                        │
     │ 逾期(排程)            │ 客取消 / 不成團
     ▼                        ▼
  逾期取消                    取消
  (庫存已還)               (庫存已還,記應退款)
```

### 團 tour.status
```
                確認人數 ≥ min_pax
  報名中 ──────────────────────────▶ 已成團 (記 confirmed_at)
     │                                   │
     │ 截止日未達門檻                     │ 掉回門檻下:預設維持已成團 + 警示
     ▼                                   │ (keepConfirmed 可設定)
  不成團取消                              ▼
  (全團退訂)                          (維持已成團)
```

---

## 7. 資料模型重點

完整 14 張表見 `db.js`。設計上值得注意的兩點:

1. **`consumption_rule` 是全域的**(旅客類型 × 資源類型),但**每個團只管理它實際設庫存的資源**。
   例:大人規則含「機位 1」,但國內團 `tour_inventory` 沒有機位列 → `createOrder` 略過該資源不檢查、不扣。
   這讓同一套消耗規則可服務國內團(無機位)與國外團(有機位)。
2. **`counts_toward_min`** 控制旅客類型是否計入成團人數(嬰兒=0)。成團判定的 SQL 直接 JOIN
   `passenger_type` 過濾此旗標,規則改動只需改資料、不需改程式。

---

## 8. 已知簡化(prototype 範圍)

| 項目 | 現況 | 正式環境 |
| --- | --- | --- |
| 鎖 | SQLite `BEGIN IMMEDIATE`(DB 級鎖) | RDBMS 列級鎖 `FOR UPDATE` |
| 排程 | 單 server `setInterval` | 獨立排程服務 + 分散式鎖 |
| 退款 | 只記「應退款金額」 | 串接金流退款流程(第二階段) |
| 庫存稽核 | 重算還庫存 | `inventory_ledger` 分錄沖銷(第二階段) |
| 認證/權限 | 無 | 前台會員 / 後台帳號權限 |
| 併發測試 | 同步序列化已保證正確 | 需壓力測試驗證鎖行為 |
