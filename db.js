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

  -- 消耗規則異動紀錄(誰、何時改過)
  CREATE TABLE consumption_rule_log (
    log_id      INTEGER PRIMARY KEY,
    edited_by   TEXT,
    edited_at   TEXT,
    detail      TEXT
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
    pdf_file              TEXT,    -- 定型化契約 PDF(放 public/contracts/)
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
    min_pax          INTEGER,   -- 成團門檻(最低人數)
    max_pax          INTEGER,   -- 報名人數上限(0/NULL=不另設上限,以庫存為準)
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
    sign_token            TEXT,    -- 不可猜的簽署連結 token(只有該旅客拿到)
    signature             TEXT,    -- 手寫簽名(base64 PNG data URL)
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

  // 消耗規則初始異動紀錄
  db.prepare('INSERT INTO consumption_rule_log (edited_by,edited_at,detail) VALUES (?,?,?)')
    .run('系統', now, '建立初始消耗規則');

  // ============================================================
  // 種子資料:照「資料庫總覽」的故事 — 王小明報名花蓮三日遊(步驟 1~10)
  // ============================================================

  // 步驟1. 商品(product)
  const pd = db.prepare(
    'INSERT INTO product (product_id,product_code,name,region_type,days,status,created_at) VALUES (?,?,?,?,?,?,?)'
  );
  pd.run(1, 'HUA3D', '花蓮三日遊', '國內', 3, '上架', now);   // ← 故事主角
  pd.run(2, 'HOK5', '北海道五日遊', '國外', 5, '上架', now);   // 另一個商品,讓「開團」有選擇

  // 契約範本(國內 / 國外 兩份定型化契約;V1 = 交通部觀光署定型化契約 PDF)
  const tpl = db.prepare(
    'INSERT INTO contract_template (contract_template_id,template_code,template_name,contract_type,contract_version,content,pdf_file,is_active,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  tpl.run(1, 'DOMESTIC', '國內旅遊定型化契約', '國內', 'V1',
    '依交通部觀光署「國內旅遊定型化契約範本」', '/contracts/domestic-v1.pdf', 1, now);
  tpl.run(2, 'OVERSEAS', '國外旅遊定型化契約', '國外', 'V1',
    '依交通部觀光署「國外旅遊定型化契約範本」', '/contracts/overseas-v1.pdf', 1, now);

  // 步驟2. 團期(tour)— 花蓮三日遊,2026/07/01 出發。max_pax=報名上限
  const tr = db.prepare(
    'INSERT INTO tour (tour_id,tour_code,product_id,start_date,end_date,min_pax,max_pax,signup_deadline,status,manual_group_status,confirmed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  tr.run(1, 'HUA3D260701A', 1, '2026-07-01', '2026-07-03', 16, 40, '2026-06-25', '報名中', '待定', null, now);
  // 第二團(北海道,空團,讓後台列表不只一筆、也可示範開團結果)
  tr.run(2, 'HOK5260810A', 2, '2026-08-10', '2026-08-14', 10, 30, '2026-07-20', '報名中', '待定', null, now);

  // 步驟3. 庫存(tour_inventory)— 車位42、床位40
  const iv = db.prepare(
    'INSERT INTO tour_inventory (tour_id,resource_type_id,total_qty,used_qty) VALUES (?,?,?,?)'
  );
  // 花蓮三日:車位42、床位40;used 對應範例訂單(王3+林2+陳3+張2+李2 = 車12床12)
  iv.run(1, 1, 42, 12); iv.run(1, 2, 40, 12);
  // 北海道:車位30、床位30、機位30;used 對應(永盛8+黃2+吳2+王小明2 = 車14床14機14)
  iv.run(2, 1, 30, 14); iv.run(2, 2, 30, 14); iv.run(2, 3, 30, 14);

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
  ).run(1, 'HUA3D260701A', '一般', 1, 1, '櫃台', '已完成', null, null, 0, '2026-06-05T10:00:00', null);

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
    'INSERT INTO member_contract (member_contract_id,order_id,contract_template_id,contract_version,contract_no,signed_status,signed_at,signer_name,signed_pdf_url,sign_token,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(1, 1, 1, 'V1', 'C-HUA3D260701A', '已簽', '2026-06-05T10:30:00', '王小明', '/contracts/domestic-v1.pdf', 'seedwang0001', '2026-06-05T10:30:00');

  // 步驟10. 收款(payment)— 訂金20,000、尾款68,000(合計88,000)
  const pay = db.prepare(
    'INSERT INTO payment (order_id,payment_type,amount,method,paid_at,note,created_at) VALUES (?,?,?,?,?,?,?)'
  );
  pay.run(1, '訂金', 20000, '信用卡', '2026-06-05T10:35:00', '', '2026-06-05T10:35:00');
  pay.run(1, '尾款', 68000, '匯款',   '2026-06-20T14:00:00', '12345', '2026-06-20T14:00:00');

  // ── 其他範例訂單(呈現不同狀態:剛報名 / 已付訂金 / 同業團)──
  const future = new Date(); future.setDate(future.getDate() + 30);
  const holdFuture = future.toISOString().slice(0, 19); // 待付訂金佔位到期設遠期,demo 期間不被自動釋放

  const cust = db.prepare('INSERT INTO customer (customer_id,name,phone,email,line_id,note,created_at) VALUES (?,?,?,?,?,?,?)');
  cust.run(2, '林小姐', '0922111222', 'lin@example.com', '', '', now);
  cust.run(3, '陳先生', '0933222333', 'chen@example.com', '', '', now);
  cust.run(4, '永盛旅行社', '02-27001234', 'sales@yongsheng.com', 'yongsheng', '同業合作', now);

  const ord = db.prepare('INSERT INTO "order" (order_id,order_no,order_type,tour_id,customer_id,channel,status,hold_expire_at,cancel_reason,refund_amount,created_at,cancelled_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const oi = db.prepare('INSERT INTO order_item (order_id,passenger_type_id,qty,agreed_unit_price,agreed_subtotal,discount_amount,final_amount) VALUES (?,?,?,?,?,?,?)');
  const py = db.prepare('INSERT INTO payment (order_id,payment_type,amount,method,paid_at,note,created_at) VALUES (?,?,?,?,?,?,?)');

  // 林小姐:剛報名、待付訂金(花蓮三日,2 大人,尚未付款)
  ord.run(2, 'O20260607002', '一般', 1, 2, '官網', '待付訂金', holdFuture, null, 0, '2026-06-07T09:30:00', null);
  oi.run(2, 1, 2, 30000, 60000, 0, 60000);

  // 陳先生:已付訂金、已確認(花蓮三日,2 大 1 小;訂金 26,400;契約已產生但未簽)
  ord.run(3, 'O20260606003', '一般', 1, 3, '櫃台', '已確認', null, null, 0, '2026-06-06T15:00:00', null);
  oi.run(3, 1, 2, 30000, 60000, 0, 60000);
  oi.run(3, 2, 1, 28000, 28000, 0, 28000);
  py.run(3, '訂金', 26400, '信用卡', '2026-06-06T15:10:00', '', '2026-06-06T15:10:00');
  db.prepare('INSERT INTO member_contract (member_contract_id,order_id,contract_template_id,contract_version,contract_no,signed_status,signed_at,signer_name,signed_pdf_url,sign_token,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(2, 3, 1, 'V1', 'C20260606003', '未簽', null, '', '/contracts/domestic-v1.pdf', 'seedchen0002', now);

  // 永盛旅行社:已付訂金、已確認(北海道,8 大人,同業團;訂金 100,800)
  ord.run(4, 'O20260605004', '同業', 2, 4, '同業', '已確認', null, null, 0, '2026-06-05T11:00:00', null);
  oi.run(4, 1, 8, 42000, 336000, 0, 336000);
  py.run(4, '訂金', 100800, '轉帳', '2026-06-05T11:20:00', '', '2026-06-05T11:20:00');

  // ── 幾筆「剛報名(待付訂金)」範例 ──
  cust.run(5, '張先生', '0955333444', '', '', '', now);
  cust.run(6, '李小姐', '0966444555', 'lee@example.com', '', '', now);
  cust.run(7, '黃先生', '0977555666', '', '', '', now);
  cust.run(8, '吳小姐', '0988666777', 'wu2@example.com', '', '', now);

  // 張先生:剛報名(花蓮三日,2 大人)
  ord.run(5, 'O20260608005', '一般', 1, 5, '官網', '待付訂金', holdFuture, null, 0, '2026-06-08T10:00:00', null);
  oi.run(5, 1, 2, 30000, 60000, 0, 60000);
  // 李小姐:剛報名(花蓮三日,1 大 1 小)
  ord.run(6, 'O20260608006', '一般', 1, 6, '電話', '待付訂金', holdFuture, null, 0, '2026-06-08T14:20:00', null);
  oi.run(6, 1, 1, 30000, 30000, 0, 30000);
  oi.run(6, 2, 1, 28000, 28000, 0, 28000);
  // 黃先生:剛報名(北海道,2 大人)
  ord.run(7, 'O20260608007', '一般', 2, 7, '官網', '待付訂金', holdFuture, null, 0, '2026-06-08T16:00:00', null);
  oi.run(7, 1, 2, 42000, 84000, 0, 84000);
  // 吳小姐:剛報名(北海道,2 大 1 嬰)
  ord.run(8, 'O20260609008', '一般', 2, 8, '業務', '待付訂金', holdFuture, null, 0, '2026-06-09T09:15:00', null);
  oi.run(8, 1, 2, 42000, 84000, 0, 84000);
  oi.run(8, 4, 1, 8000, 8000, 0, 8000);

  // 王小明回頭客:同一客戶第 2 筆訂單(北海道,2 大人,待付訂金)→ 客戶管理會顯示報名次數 2
  ord.run(9, 'O20260609009', '一般', 2, 1, '官網', '待付訂金', holdFuture, null, 0, '2026-06-09T11:00:00', null);
  oi.run(9, 1, 2, 42000, 84000, 0, 84000);
}

module.exports = { openDb, freshDb, DB_PATH };
