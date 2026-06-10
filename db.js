// db.js — 資料庫連線、建表(schema)、種子資料
// 對應 V1.0 地基書資料模型 + V1.1 流程補充的欄位調整
// 使用 Node.js 內建 node:sqlite(Node 22+),零外部依賴

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DB_PATH = path.join(__dirname, 'tour.db');

// 每次啟動重建乾淨資料庫(prototype 用,方便重複展示)
function freshDb() {
  if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH);
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON;');
  createSchema(db);
  seed(db);
  return db;
}

function openDb() {
  if (!fs.existsSync(DB_PATH)) return freshDb();
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

function createSchema(db) {
  db.exec(`
  -- ========== 主檔 Master ==========
  CREATE TABLE product (
    product_id    INTEGER PRIMARY KEY,
    product_code  TEXT,
    name          TEXT,
    region_type   TEXT,        -- 國內 / 國外
    days          INTEGER,
    status        TEXT,        -- 上架 / 下架
    created_at    TEXT
  );

  CREATE TABLE passenger_type (
    passenger_type_id  INTEGER PRIMARY KEY,
    name               TEXT,
    counts_toward_min  INTEGER,  -- 1=計入成團人數 0=不計入(V1.1 流程D)
    status             TEXT
  );

  CREATE TABLE resource_type (
    resource_type_id  INTEGER PRIMARY KEY,
    name              TEXT,     -- 車位 / 床位 / 機位
    status            TEXT
  );

  -- 旅客類型如何扣資源(V1.1 流程A 扣量算法核心)
  CREATE TABLE consumption_rule (
    passenger_type_id  INTEGER,
    resource_type_id   INTEGER,
    qty                INTEGER,  -- 一人消耗幾單位
    PRIMARY KEY (passenger_type_id, resource_type_id)
  );

  CREATE TABLE cost_category (
    cost_category_id  INTEGER PRIMARY KEY,
    name              TEXT,     -- 住宿 / 交通 / 餐食 / 服務費
    is_pass_through   INTEGER,  -- 是否代收轉付
    status            TEXT
  );

  CREATE TABLE customer (
    customer_id  INTEGER PRIMARY KEY,
    name         TEXT,
    phone        TEXT,
    email        TEXT,
    line_id      TEXT,
    note         TEXT,
    created_at   TEXT
  );

  CREATE TABLE contract_template (
    contract_template_id  INTEGER PRIMARY KEY,
    template_code         TEXT,
    template_name         TEXT,
    contract_type         TEXT,
    contract_version      TEXT,
    content               TEXT,
    is_active             INTEGER,
    created_at            TEXT
  );

  -- ========== 團務 Operation ==========
  CREATE TABLE tour (
    tour_id          INTEGER PRIMARY KEY,
    tour_code        TEXT,
    product_id       INTEGER,
    start_date       TEXT,
    end_date         TEXT,
    min_pax          INTEGER,   -- 成團門檻
    signup_deadline  TEXT,      -- 報名截止日(V1.1 流程D 不成團判定)
    status           TEXT,      -- 草稿 / 報名中 / 已成團 / 不成團取消 / 關閉
    manual_group_status TEXT,   -- 人工成團狀態:主管手動決定(待定 / 強制成團 / 強制不成團)
    confirmed_at     TEXT,      -- 成團時間
    created_at       TEXT
  );

  CREATE TABLE tour_inventory (
    tour_id           INTEGER,
    resource_type_id  INTEGER,
    total_qty         INTEGER,
    used_qty          INTEGER,
    PRIMARY KEY (tour_id, resource_type_id)
  );

  CREATE TABLE tour_price (
    tour_id            INTEGER,
    passenger_type_id  INTEGER,
    price              INTEGER,
    deposit_ratio      REAL,    -- 訂金比例 0~1
    created_at         TEXT,
    PRIMARY KEY (tour_id, passenger_type_id)
  );

  CREATE TABLE "order" (
    order_id        INTEGER PRIMARY KEY,
    order_no        TEXT,
    order_type      TEXT,       -- 一般 / 同業
    tour_id         INTEGER,
    customer_id     INTEGER,
    channel         TEXT,       -- 官網 / 同業 / 電話
    status          TEXT,       -- 待付訂金 / 已確認 / 逾期取消 / 取消(V1.1)
    hold_expire_at  TEXT,       -- V1.1 新增:佔位到期時間
    cancel_reason   TEXT,       -- V1.1 新增:客取消 / 逾期 / 不成團
    refund_amount   INTEGER,    -- V1.1 新增:應退款金額(第一階段先記)
    created_at      TEXT,
    cancelled_at    TEXT        -- 取消時間
  );

  CREATE TABLE order_item (
    order_item_id      INTEGER PRIMARY KEY,
    order_id           INTEGER,
    passenger_type_id  INTEGER,
    qty                INTEGER,
    agreed_unit_price  INTEGER,
    agreed_subtotal    INTEGER,
    discount_amount    INTEGER,
    final_amount       INTEGER
  );

  CREATE TABLE traveler (
    traveler_id          INTEGER PRIMARY KEY,
    order_id             INTEGER,
    passenger_type_id    INTEGER,
    name                 TEXT,
    english_name         TEXT,
    birthday             TEXT,
    gender               TEXT,
    nationality          TEXT,
    id_no                TEXT,    -- 身分證字號(國內團用)
    passport_no          TEXT,
    passport_expire_date TEXT
  );

  CREATE TABLE member_contract (
    member_contract_id    INTEGER PRIMARY KEY,
    order_id              INTEGER,
    contract_template_id  INTEGER,
    contract_version      TEXT,
    contract_no           TEXT,
    signed_status         TEXT,   -- 未簽 / 已簽
    signed_at             TEXT,
    signer_name           TEXT,
    signed_pdf_url        TEXT,
    created_at            TEXT
  );

  -- ========== 財務 Finance ==========
  CREATE TABLE payment (
    payment_id    INTEGER PRIMARY KEY,
    order_id      INTEGER,
    payment_type  TEXT,    -- V1.1 新增:訂金 / 尾款
    amount        INTEGER,
    method        TEXT,    -- 信用卡 / 轉帳 / 現金
    paid_at       TEXT,
    note          TEXT,
    created_at    TEXT
  );
  `);
}

function seed(db) {
  const now = '2026-06-09T09:00:00';

  // --- 旅客類型 ---
  const pt = db.prepare(
    'INSERT INTO passenger_type (passenger_type_id,name,counts_toward_min,status) VALUES (?,?,?,?)'
  );
  pt.run(1, '大人', 1, '啟用');
  pt.run(2, '小孩佔床', 1, '啟用');
  pt.run(3, '小孩不佔床', 1, '啟用');
  pt.run(4, '嬰兒', 0, '啟用'); // 不計入成團人數

  // --- 資源類型 ---
  const rt = db.prepare(
    'INSERT INTO resource_type (resource_type_id,name,status) VALUES (?,?,?)'
  );
  rt.run(1, '車位', '啟用');
  rt.run(2, '床位', '啟用');
  rt.run(3, '機位', '啟用');

  // --- 消耗規則(誰扣什麼、扣多少)---
  const cr = db.prepare(
    'INSERT INTO consumption_rule (passenger_type_id,resource_type_id,qty) VALUES (?,?,?)'
  );
  // 大人:車位1 床位1 機位1
  cr.run(1, 1, 1); cr.run(1, 2, 1); cr.run(1, 3, 1);
  // 小孩佔床:車位1 床位1 機位1
  cr.run(2, 1, 1); cr.run(2, 2, 1); cr.run(2, 3, 1);
  // 小孩不佔床:車位1 床位0 機位1
  cr.run(3, 1, 1); cr.run(3, 2, 0); cr.run(3, 3, 1);
  // 嬰兒:車位0 床位0 機位0(膝上,不佔資源)
  cr.run(4, 1, 0); cr.run(4, 2, 0); cr.run(4, 3, 0);

  // --- 成本科目 ---
  const cc = db.prepare(
    'INSERT INTO cost_category (cost_category_id,name,is_pass_through,status) VALUES (?,?,?,?)'
  );
  cc.run(1, '住宿', 1, '啟用');
  cc.run(2, '交通', 1, '啟用');
  cc.run(3, '餐食', 1, '啟用');
  cc.run(4, '服務費', 0, '啟用');

  // ============================================================
  // 種子資料:照「資料庫總覽」的故事 — 王小明報名花蓮三日遊(步驟 1~10)
  // ============================================================

  // 步驟1. 商品(product)
  const pd = db.prepare(
    'INSERT INTO product (product_id,product_code,name,region_type,days,status,created_at) VALUES (?,?,?,?,?,?,?)'
  );
  pd.run(1, 'HUA3D', '花蓮三日遊', '國內', 3, '上架', now);   // ← 故事主角
  pd.run(2, 'HOK5', '北海道五日遊', '國外', 5, '上架', now);   // 另一個商品,讓「開團」有選擇

  // 契約範本
  db.prepare(
    'INSERT INTO contract_template (contract_template_id,template_code,template_name,contract_type,contract_version,content,is_active,created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(1, 'DOMESTIC', '國內旅遊定型化契約', '國內', 'V1', '本契約依交通部觀光署國內旅遊定型化契約範本…', 1, now);

  // 步驟2. 團期(tour)— 花蓮三日遊,2026/07/01 出發
  const tr = db.prepare(
    'INSERT INTO tour (tour_id,tour_code,product_id,start_date,end_date,min_pax,signup_deadline,status,manual_group_status,confirmed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  );
  tr.run(1, 'HUA3D260701A', 1, '2026-07-01', '2026-07-03', 16, '2026-06-25', '報名中', '待定', null, now);
  // 第二團(北海道,空團,讓後台列表不只一筆、也可示範開團結果)
  tr.run(2, 'HOK5260810A', 2, '2026-08-10', '2026-08-14', 10, '2026-07-20', '報名中', '待定', null, now);

  // 步驟3. 庫存(tour_inventory)— 車位42、床位40
  const iv = db.prepare(
    'INSERT INTO tour_inventory (tour_id,resource_type_id,total_qty,used_qty) VALUES (?,?,?,?)'
  );
  // 花蓮三日:車位42、床位40;used 已對應王小明訂單(2大1小 → 車位3、床位3)
  iv.run(1, 1, 42, 3); iv.run(1, 2, 40, 3);
  // 北海道:車位30、床位30、機位30(尚無訂單)
  iv.run(2, 1, 30, 0); iv.run(2, 2, 30, 0); iv.run(2, 3, 30, 0);

  // 步驟4. 售價(tour_price)— 大人30,000、小孩28,000
  const tp = db.prepare(
    'INSERT INTO tour_price (tour_id,passenger_type_id,price,deposit_ratio,created_at) VALUES (?,?,?,?,?)'
  );
  tp.run(1, 1, 30000, 0.3, now); tp.run(1, 2, 28000, 0.3, now); tp.run(1, 3, 26000, 0.3, now); tp.run(1, 4, 5000, 0.3, now);
  tp.run(2, 1, 42000, 0.3, now); tp.run(2, 2, 39000, 0.3, now); tp.run(2, 3, 36000, 0.3, now); tp.run(2, 4, 8000, 0.3, now);

  // 步驟5. 客戶(customer)+ 訂單(order)— 王小明報名 HUA3D260701A
  db.prepare(
    'INSERT INTO customer (customer_id,name,phone,email,line_id,note,created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(1, '王小明', '0912345678', 'ming@example.com', 'mingwang', '', now);

  db.prepare(
    'INSERT INTO "order" (order_id,order_no,order_type,tour_id,customer_id,channel,status,hold_expire_at,cancel_reason,refund_amount,created_at,cancelled_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(1, 'HUA3D260701A', '一般', 1, 1, '櫃台', '已確認', null, null, 0, '2026-06-05T10:00:00', null);

  // 步驟6. 訂單明細(order_item)— 大人2、小孩1。2×30000 + 1×28000 = 88,000
  const item = db.prepare(
    'INSERT INTO order_item (order_id,passenger_type_id,qty,agreed_unit_price,agreed_subtotal,discount_amount,final_amount) VALUES (?,?,?,?,?,?,?)'
  );
  item.run(1, 1, 2, 30000, 60000, 0, 60000);   // 大人2位
  item.run(1, 2, 1, 28000, 28000, 0, 28000);   // 小孩佔床1位

  // 步驟7. 旅客(traveler)— 王小明、王太太、王小華
  const tv = db.prepare(
    'INSERT INTO traveler (order_id,passenger_type_id,name,english_name,birthday,gender,nationality,id_no,passport_no,passport_expire_date) VALUES (?,?,?,?,?,?,?,?,?,?)'
  );
  tv.run(1, 1, '王小明', 'Wang Hsiao-Ming', '1985-03-12', '男', '台灣', 'A123456789', '', '');
  tv.run(1, 1, '王太太', 'Wang Mei-Li',     '1987-08-20', '女', '台灣', 'B223456789', '', '');
  tv.run(1, 2, '王小華', 'Wang Hsiao-Hua',  '2017-05-06', '男', '台灣', 'A123456780', '', '');

  // 步驟8. 庫存扣減已反映在上方 tour_inventory.used_qty(車位3、床位3)

  // 步驟9. 報名契約(member_contract)— 王小明這張訂單簽的契約
  db.prepare(
    'INSERT INTO member_contract (member_contract_id,order_id,contract_template_id,contract_version,contract_no,signed_status,signed_at,signer_name,signed_pdf_url,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(1, 1, 1, 'V1', 'C-HUA3D260701A', '已簽', '2026-06-05T10:30:00', '王小明', '/contracts/C-HUA3D260701A.pdf', '2026-06-05T10:30:00');

  // 步驟10. 收款(payment)— 訂金20,000、尾款68,000(合計88,000)
  const pay = db.prepare(
    'INSERT INTO payment (order_id,payment_type,amount,method,paid_at,note,created_at) VALUES (?,?,?,?,?,?,?)'
  );
  pay.run(1, '訂金', 20000, '信用卡', '2026-06-05T10:35:00', '', '2026-06-05T10:35:00');
  pay.run(1, '尾款', 68000, '匯款',   '2026-06-20T14:00:00', '', '2026-06-20T14:00:00');
}

module.exports = { openDb, freshDb, DB_PATH };
