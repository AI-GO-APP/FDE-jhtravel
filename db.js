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
    status           TEXT,      -- 報名中 / 已成團 / 不成團取消
    confirmed_at     TEXT,      -- V1.1 新增:成團時間
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
    created_at      TEXT
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

  // --- 商品 ---
  const pd = db.prepare(
    'INSERT INTO product (product_id,product_code,name,region_type,days,status,created_at) VALUES (?,?,?,?,?,?,?)'
  );
  pd.run(1, 'HL2', '花蓮二日遊', '國內', 2, '上架', now);
  pd.run(2, 'HOK5', '北海道五日遊', '國外', 5, '上架', now);

  // --- 契約範本 ---
  db.prepare(
    'INSERT INTO contract_template (contract_template_id,template_code,template_name,contract_type,contract_version,content,is_active,created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(1, 'STD', '國內旅遊定型化契約', '國內', 'v2024', '本契約依交通部觀光署定型化契約範本…', 1, now);

  // --- 團期 ---
  const tr = db.prepare(
    'INSERT INTO tour (tour_id,tour_code,product_id,start_date,end_date,min_pax,signup_deadline,status,confirmed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  );
  // 團1:小庫存,方便展示「防超賣」(車位只有 8)
  tr.run(1, 'HL2-0701', 1, '2026-07-01', '2026-07-02', 6, '2026-06-25', '報名中', null, now);
  // 團2:北海道,較大團
  tr.run(2, 'HOK5-0810', 2, '2026-08-10', '2026-08-14', 10, '2026-07-20', '報名中', null, now);
  // 團3:已過/接近截止日,方便展示「不成團」判定(截止日設在今天)
  tr.run(3, 'HL2-0610', 1, '2026-06-20', '2026-06-21', 8, '2026-06-09', '報名中', null, now);

  // --- 庫存 ---
  const iv = db.prepare(
    'INSERT INTO tour_inventory (tour_id,resource_type_id,total_qty,used_qty) VALUES (?,?,?,?)'
  );
  // 團1:車位8、床位8、機位0(國內無機位)
  iv.run(1, 1, 8, 0); iv.run(1, 2, 8, 0);
  // 團2:車位20、床位20、機位20
  iv.run(2, 1, 20, 0); iv.run(2, 2, 20, 0); iv.run(2, 3, 20, 0);
  // 團3:車位16、床位16
  iv.run(3, 1, 16, 0); iv.run(3, 2, 16, 0);

  // --- 售價 ---
  const tp = db.prepare(
    'INSERT INTO tour_price (tour_id,passenger_type_id,price,deposit_ratio) VALUES (?,?,?,?)'
  );
  // 團1 花蓮二日
  tp.run(1, 1, 4500, 0.3); tp.run(1, 2, 3800, 0.3); tp.run(1, 3, 3200, 0.3); tp.run(1, 4, 800, 0.3);
  // 團2 北海道五日
  tp.run(2, 1, 38900, 0.3); tp.run(2, 2, 35900, 0.3); tp.run(2, 3, 30900, 0.3); tp.run(2, 4, 6000, 0.3);
  // 團3 花蓮二日
  tp.run(3, 1, 4500, 0.3); tp.run(3, 2, 3800, 0.3); tp.run(3, 3, 3200, 0.3); tp.run(3, 4, 800, 0.3);
}

module.exports = { openDb, freshDb, DB_PATH };
