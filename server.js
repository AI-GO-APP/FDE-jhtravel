// server.js — 零依賴 HTTP 伺服器(node:http)+ API 路由
// 啟動:node server.js  → http://localhost:3000

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { freshDb } = require('./db');
const F = require('./flows');

const PORT = 3000;
const db = freshDb(); // 每次啟動重建乾淨資料庫(prototype)

const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.pdf': 'application/pdf' };

// ───── 查詢用 helper(組裝畫面資料)─────
function listTours() {
  const tours = db.prepare(
    `SELECT t.*, p.name AS product_name, p.region_type, p.days
     FROM tour t JOIN product p ON p.product_id=t.product_id
     ORDER BY t.tour_id`
  ).all();
  return tours.map(t => {
    const inv = availableSeats(t.tour_id);
    const signed = F.signedPax(db, t.tour_id);
    const cap = (t.max_pax && t.max_pax > 0) ? Math.max(0, t.max_pax - signed) : inv.min;
    return { ...t, available: { min: Math.min(inv.min, cap), detail: inv.detail }, signed_pax: signed, confirmed_pax: F.countConfirmedPax(db, t.tour_id) };
  });
}

// 可售名額 = 各資源 (total-used) 的最小值(以最稀缺資源為準)
function availableSeats(tour_id) {
  const rows = db.prepare(
    `SELECT r.name, i.total_qty, i.used_qty, (i.total_qty-i.used_qty) AS remain
     FROM tour_inventory i JOIN resource_type r ON r.resource_type_id=i.resource_type_id
     WHERE i.tour_id=?`
  ).all(tour_id);
  if (rows.length === 0) return { min: 0, detail: [] };
  return { min: Math.min(...rows.map(r => r.remain)), detail: rows };
}

function tourDetail(tour_id) {
  const tour = db.prepare(
    `SELECT t.*, p.name AS product_name, p.region_type, p.days
     FROM tour t JOIN product p ON p.product_id=t.product_id WHERE t.tour_id=?`
  ).get(tour_id);
  if (!tour) return null;
  const inv = availableSeats(tour_id);
  const prices = db.prepare(
    `SELECT tp.passenger_type_id, pt.name, tp.price_tier_id, ptr.name AS price_tier_name, tp.price, tp.deposit_ratio
     FROM tour_price tp
     JOIN passenger_type pt ON pt.passenger_type_id=tp.passenger_type_id
     LEFT JOIN price_tier ptr ON ptr.price_tier_id=tp.price_tier_id
     WHERE tp.tour_id=? ORDER BY tp.price_tier_id, tp.passenger_type_id`
  ).all(tour_id);
  const signed = F.signedPax(db, tour_id);
  const cap = (tour.max_pax && tour.max_pax > 0) ? Math.max(0, tour.max_pax - signed) : inv.min;
  return { tour, inventory: inv.detail, prices, confirmed_pax: F.countConfirmedPax(db, tour_id), signed_pax: signed, available: Math.min(inv.min, cap) };
}

function adminTour(tour_id) {
  const detail = tourDetail(tour_id);
  if (!detail) return null;
  const orders = db.prepare(
    `SELECT o.*, c.name AS customer_name, c.phone
     FROM "order" o JOIN customer c ON c.customer_id=o.customer_id
     WHERE o.tour_id=? ORDER BY o.order_id DESC`
  ).all(tour_id);
  for (const o of orders) {
    o.items = db.prepare(
      `SELECT oi.*, pt.name AS pt_name FROM order_item oi
       JOIN passenger_type pt ON pt.passenger_type_id=oi.passenger_type_id WHERE oi.order_id=?`
    ).all(o.order_id);
    o.paid = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM payment WHERE order_id=?').get(o.order_id).s;
    const mc = db.prepare('SELECT signed_status FROM member_contract WHERE order_id=?').get(o.order_id);
    o.contract_signed = mc ? mc.signed_status : '未簽';
  }
  return { ...detail, orders };
}

function orderDetail(order_id) {
  const order = db.prepare(
    `SELECT o.*, c.name AS customer_name, c.phone, c.email, t.tour_code, p.name AS product_name, ptr.name AS price_tier_name
     FROM "order" o JOIN customer c ON c.customer_id=o.customer_id
     JOIN tour t ON t.tour_id=o.tour_id JOIN product p ON p.product_id=t.product_id
     LEFT JOIN price_tier ptr ON ptr.price_tier_id=o.price_tier_id
     WHERE o.order_id=?`
  ).get(order_id);
  if (!order) return null;
  order.items = db.prepare(
    `SELECT oi.*, pt.name AS pt_name FROM order_item oi
     JOIN passenger_type pt ON pt.passenger_type_id=oi.passenger_type_id WHERE oi.order_id=?`
  ).all(order_id);
  order.travelers = db.prepare('SELECT * FROM traveler WHERE order_id=?').all(order_id);
  order.payments = db.prepare('SELECT * FROM payment WHERE order_id=? ORDER BY payment_id').all(order_id);
  order.contract = db.prepare('SELECT * FROM member_contract WHERE order_id=?').get(order_id) || null;
  order.total = order.items.reduce((s, i) => s + i.final_amount, 0);
  order.paid = order.payments.reduce((s, p) => s + p.amount, 0);
  return order;
}

function passengerTypes() {
  return db.prepare('SELECT * FROM passenger_type WHERE status=? ORDER BY passenger_type_id').all('啟用');
}
function resourceTypes() {
  return db.prepare('SELECT * FROM resource_type WHERE status=? ORDER BY resource_type_id').all('啟用');
}
function contractTemplates() {
  return db.prepare('SELECT contract_template_id, template_name, contract_version FROM contract_template WHERE is_active=1').all();
}
function priceTiers() {
  return db.prepare("SELECT * FROM price_tier WHERE status='啟用' ORDER BY sort_order, price_tier_id").all();
}
function listProducts() {
  const rows = db.prepare('SELECT * FROM product ORDER BY product_id').all();
  // 附上每個商品已開幾團
  for (const r of rows) {
    r.tour_count = db.prepare('SELECT COUNT(*) AS c FROM tour WHERE product_id=?').get(r.product_id).c;
  }
  return rows;
}

// 某商品底下的所有團期
function productTours(product_id) {
  const product = db.prepare('SELECT * FROM product WHERE product_id=?').get(product_id);
  if (!product) return null;
  const tours = db.prepare('SELECT * FROM tour WHERE product_id=? ORDER BY start_date').all(product_id);
  for (const t of tours) {
    const inv = availableSeats(t.tour_id);
    const signed = F.signedPax(db, t.tour_id);
    const cap = (t.max_pax && t.max_pax > 0) ? Math.max(0, t.max_pax - signed) : inv.min;
    t.available = Math.min(inv.min, cap);
    t.signed_pax = signed;
    t.confirmed_pax = F.countConfirmedPax(db, t.tour_id);
  }
  return { product, tours };
}

// 全部訂單(跨團)
function listOrders() {
  const rows = db.prepare(
    `SELECT o.*, c.name AS customer_name, t.tour_code, p.name AS product_name
     FROM "order" o JOIN customer c ON c.customer_id=o.customer_id
     JOIN tour t ON t.tour_id=o.tour_id JOIN product p ON p.product_id=t.product_id
     ORDER BY o.order_id DESC`
  ).all();
  for (const o of rows) {
    const agg = db.prepare('SELECT COALESCE(SUM(final_amount),0) AS total, COALESCE(SUM(qty),0) AS pax FROM order_item WHERE order_id=?').get(o.order_id);
    o.total = agg.total; o.pax = agg.pax;
    o.paid = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM payment WHERE order_id=?').get(o.order_id).s;
  }
  return rows;
}

// 客戶列表(含報名次數、最近訂單)
function listCustomers() {
  const rows = db.prepare('SELECT * FROM customer ORDER BY customer_id').all();
  for (const c of rows) {
    c.order_count = db.prepare('SELECT COUNT(*) AS n FROM "order" WHERE customer_id=?').get(c.customer_id).n;
    const last = db.prepare('SELECT order_no FROM "order" WHERE customer_id=? ORDER BY order_id DESC LIMIT 1').get(c.customer_id);
    c.last_order = last ? last.order_no : '';
  }
  return rows;
}

// 全部收款
function listPayments() {
  return db.prepare(
    `SELECT pay.*, o.order_no, c.name AS customer_name
     FROM payment pay JOIN "order" o ON o.order_id=pay.order_id
     JOIN customer c ON c.customer_id=o.customer_id
     ORDER BY pay.payment_id DESC`
  ).all();
}

// 報名契約 + 契約範本
function listContracts() {
  const templates = db.prepare('SELECT * FROM contract_template ORDER BY contract_template_id').all();
  const member = db.prepare(
    `SELECT mc.*, o.order_no FROM member_contract mc JOIN "order" o ON o.order_id=mc.order_id
     ORDER BY mc.member_contract_id DESC`
  ).all();
  return { templates, member };
}

// 設定:旅客類型、資源類型、消耗規則、成本科目(皆含 id 與 status,供前端編輯)
function listSettings() {
  const passenger_types = db.prepare('SELECT * FROM passenger_type ORDER BY passenger_type_id').all();
  const resource_types = db.prepare('SELECT * FROM resource_type ORDER BY resource_type_id').all();
  const rulesRaw = db.prepare('SELECT * FROM consumption_rule').all();
  const rules = {};
  for (const r of rulesRaw) rules[`${r.passenger_type_id}_${r.resource_type_id}`] = r.qty;
  const cost_categories = db.prepare('SELECT * FROM cost_category ORDER BY cost_category_id').all();
  const rule_log = db.prepare('SELECT * FROM consumption_rule_log ORDER BY log_id DESC LIMIT 20').all();
  return { passenger_types, resource_types, rules, cost_categories, rule_log };
}

// ───── 路由 ─────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // API
  if (p.startsWith('/api/')) return handleApi(req, res, url);

  // 靜態檔案
  let file = p === '/' ? '/index.html' : p;
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full)) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
});

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', c => (b += c));
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const seg = p.split('/').filter(Boolean); // ['api', ...]
  try {
    // GET /api/tours
    if (req.method === 'GET' && p === '/api/tours') return json(res, 200, listTours());
    // GET /api/meta(旅客類型、資源類型、契約範本)
    if (req.method === 'GET' && p === '/api/meta')
      return json(res, 200, { passenger_types: passengerTypes(), resource_types: resourceTypes(), contract_templates: contractTemplates(), price_tiers: priceTiers() });
    // GET /api/products(商品列表)
    if (req.method === 'GET' && p === '/api/products') return json(res, 200, listProducts());
    // GET /api/products/:id/tours(某商品底下的團期)
    if (req.method === 'GET' && seg[1] === 'products' && seg[2] && seg[3] === 'tours') {
      const d = productTours(Number(seg[2]));
      return d ? json(res, 200, d) : json(res, 404, { error: '商品不存在' });
    }
    // GET /api/customers(客戶列表)
    if (req.method === 'GET' && p === '/api/customers') return json(res, 200, listCustomers());
    // GET /api/payments(全部收款)
    if (req.method === 'GET' && p === '/api/payments') return json(res, 200, listPayments());
    // GET /api/contracts(契約範本 + 報名契約)
    if (req.method === 'GET' && p === '/api/contracts') return json(res, 200, listContracts());
    // GET /api/settings(消耗規則 + 成本科目)
    if (req.method === 'GET' && p === '/api/settings') return json(res, 200, listSettings());
    // GET /api/orders(全部訂單)— 注意:需放在 /api/orders/:id 之前
    if (req.method === 'GET' && p === '/api/orders') return json(res, 200, listOrders());
    // GET /api/tours/:id
    if (req.method === 'GET' && seg[1] === 'tours' && seg[2]) {
      const d = tourDetail(Number(seg[2]));
      return d ? json(res, 200, d) : json(res, 404, { error: '團期不存在' });
    }
    // GET /api/admin/tours/:id
    if (req.method === 'GET' && seg[1] === 'admin' && seg[2] === 'tours' && seg[3]) {
      const d = adminTour(Number(seg[3]));
      return d ? json(res, 200, d) : json(res, 404, { error: '團期不存在' });
    }
    // GET /api/orders/:id
    if (req.method === 'GET' && seg[1] === 'orders' && seg[2]) {
      const d = orderDetail(Number(seg[2]));
      return d ? json(res, 200, d) : json(res, 404, { error: '訂單不存在' });
    }

    // POST /api/products  建立商品(步驟1)
    if (req.method === 'POST' && p === '/api/products') {
      const body = await readBody(req);
      const r = F.createProduct(db, body);
      return json(res, 200, { ok: true, ...r });
    }
    // POST /api/tours  開團 + 設庫存 + 設售價(步驟2~4)
    if (req.method === 'POST' && p === '/api/tours') {
      const body = await readBody(req);
      const r = F.createTour(db, body);
      return json(res, 200, { ok: true, ...r });
    }
    // POST /api/customers  新增客戶
    if (req.method === 'POST' && p === '/api/customers') {
      const b = await readBody(req);
      if (!b.name) return json(res, 400, { error: '請填寫客戶姓名' });
      const r = db.prepare('INSERT INTO customer (name,phone,email,line_id,note,created_at) VALUES (?,?,?,?,?,?)')
        .run(b.name, b.phone || '', b.email || '', b.line_id || '', b.note || '', F.NOW());
      return json(res, 200, { ok: true, customer_id: Number(r.lastInsertRowid) });
    }
    // POST /api/contract-templates  新增契約範本
    if (req.method === 'POST' && p === '/api/contract-templates') {
      const b = await readBody(req);
      if (!b.template_name) return json(res, 400, { error: '請填寫範本名稱' });
      const r = db.prepare('INSERT INTO contract_template (template_code,template_name,contract_type,contract_version,content,is_active,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(b.template_code || '', b.template_name, b.contract_type || '國內', b.contract_version || 'V1', b.content || '', 1, F.NOW());
      return json(res, 200, { ok: true, contract_template_id: Number(r.lastInsertRowid) });
    }

    // ── 狀態切換 / 設定編輯 ──
    // POST /api/products/:id/status  上架 / 下架
    if (req.method === 'POST' && seg[1] === 'products' && seg[3] === 'status') {
      const b = await readBody(req);
      db.prepare('UPDATE product SET status=? WHERE product_id=?').run(b.status, Number(seg[2]));
      return json(res, 200, { ok: true });
    }
    // POST /api/passenger-types/:id/status  啟用 / 停用
    if (req.method === 'POST' && seg[1] === 'passenger-types' && seg[3] === 'status') {
      const b = await readBody(req);
      db.prepare('UPDATE passenger_type SET status=? WHERE passenger_type_id=?').run(b.status, Number(seg[2]));
      return json(res, 200, { ok: true });
    }
    // POST /api/resource-types/:id/status  啟用 / 停用
    if (req.method === 'POST' && seg[1] === 'resource-types' && seg[3] === 'status') {
      const b = await readBody(req);
      db.prepare('UPDATE resource_type SET status=? WHERE resource_type_id=?').run(b.status, Number(seg[2]));
      return json(res, 200, { ok: true });
    }
    // POST /api/contract-templates/:id/status  啟用 / 停用
    if (req.method === 'POST' && seg[1] === 'contract-templates' && seg[3] === 'status') {
      const b = await readBody(req);
      db.prepare('UPDATE contract_template SET is_active=? WHERE contract_template_id=?').run(b.is_active ? 1 : 0, Number(seg[2]));
      return json(res, 200, { ok: true });
    }
    // POST /api/cost-categories  新增成本科目
    if (req.method === 'POST' && p === '/api/cost-categories') {
      const b = await readBody(req);
      if (!b.name) return json(res, 400, { error: '請填寫科目名稱' });
      const r = db.prepare('INSERT INTO cost_category (name,is_pass_through,status) VALUES (?,?,?)')
        .run(b.name, b.is_pass_through ? 1 : 0, b.status || '啟用');
      return json(res, 200, { ok: true, cost_category_id: Number(r.lastInsertRowid) });
    }
    // POST /api/cost-categories/:id  編輯成本科目(含狀態)
    if (req.method === 'POST' && seg[1] === 'cost-categories' && seg[2] && !seg[3]) {
      const b = await readBody(req);
      db.prepare('UPDATE cost_category SET name=?, is_pass_through=?, status=? WHERE cost_category_id=?')
        .run(b.name, b.is_pass_through ? 1 : 0, b.status, Number(seg[2]));
      return json(res, 200, { ok: true });
    }
    // PUT /api/consumption-rules  儲存消耗規則(整批 upsert + 寫異動紀錄)
    if (req.method === 'PUT' && p === '/api/consumption-rules') {
      const b = await readBody(req);
      F.saveConsumptionRules(db, b);
      return json(res, 200, { ok: true });
    }
    // POST /api/resource-types  新增資源類型
    if (req.method === 'POST' && p === '/api/resource-types') {
      const b = await readBody(req);
      if (!b.name) return json(res, 400, { error: '請填寫資源名稱' });
      const r = db.prepare('INSERT INTO resource_type (name,status) VALUES (?,?)').run(b.name, '啟用');
      const rtId = Number(r.lastInsertRowid);
      const pts = db.prepare('SELECT passenger_type_id FROM passenger_type').all();
      const ins = db.prepare('INSERT OR REPLACE INTO consumption_rule (passenger_type_id,resource_type_id,qty) VALUES (?,?,0)');
      for (const pt of pts) ins.run(pt.passenger_type_id, rtId);
      return json(res, 200, { ok: true, resource_type_id: rtId });
    }
    // POST /api/resource-types/:id  編輯資源類型名稱
    if (req.method === 'POST' && seg[1] === 'resource-types' && seg[2] && !seg[3]) {
      const b = await readBody(req);
      db.prepare('UPDATE resource_type SET name=? WHERE resource_type_id=?').run(b.name, Number(seg[2]));
      return json(res, 200, { ok: true });
    }
    // POST /api/passenger-types  新增旅客類型
    if (req.method === 'POST' && p === '/api/passenger-types') {
      const b = await readBody(req);
      if (!b.name) return json(res, 400, { error: '請填寫旅客類型名稱' });
      const r = db.prepare('INSERT INTO passenger_type (name,counts_toward_min,status) VALUES (?,?,?)')
        .run(b.name, b.counts_toward_min ? 1 : 0, '啟用');
      const ptId = Number(r.lastInsertRowid);
      // 同步在消耗規則中為各資源建立 0 的規則(讓新類型立即出現在規則表)
      const ress = db.prepare('SELECT resource_type_id FROM resource_type').all();
      const ins = db.prepare('INSERT OR REPLACE INTO consumption_rule (passenger_type_id,resource_type_id,qty) VALUES (?,?,0)');
      for (const rt of ress) ins.run(ptId, rt.resource_type_id);
      return json(res, 200, { ok: true, passenger_type_id: ptId });
    }
    // POST /api/passenger-types/:id  編輯旅客類型(名稱 / 是否計入成團,有給才改)
    if (req.method === 'POST' && seg[1] === 'passenger-types' && seg[2] && !seg[3]) {
      const b = await readBody(req);
      const cur = db.prepare('SELECT * FROM passenger_type WHERE passenger_type_id=?').get(Number(seg[2]));
      if (!cur) return json(res, 404, { error: '旅客類型不存在' });
      db.prepare('UPDATE passenger_type SET name=?, counts_toward_min=? WHERE passenger_type_id=?').run(
        b.name != null ? b.name : cur.name,
        b.counts_toward_min != null ? (b.counts_toward_min ? 1 : 0) : cur.counts_toward_min,
        Number(seg[2])
      );
      return json(res, 200, { ok: true });
    }
    // POST /api/tours/:id  編輯團期(門檻/上限/日期)
    if (req.method === 'POST' && seg[1] === 'tours' && seg[2] && !seg[3]) {
      const b = await readBody(req);
      const r = F.updateTour(db, { tour_id: Number(seg[2]), ...b });
      return json(res, 200, r);
    }

    // POST /api/orders  建立訂單(流程A/B)
    if (req.method === 'POST' && p === '/api/orders') {
      const body = await readBody(req);
      const r = F.createOrder(db, body);
      return json(res, 200, { ok: true, ...r });
    }
    // POST /api/orders/:id/travelers  新增旅客(步驟7)
    if (req.method === 'POST' && seg[1] === 'orders' && seg[3] === 'travelers') {
      const body = await readBody(req);
      const r = F.addTraveler(db, { order_id: Number(seg[2]), ...body });
      return json(res, 200, { ok: true, ...r });
    }
    // POST /api/orders/:id/pay  收款(流程B)
    if (req.method === 'POST' && seg[1] === 'orders' && seg[3] === 'pay') {
      const body = await readBody(req);
      const r = F.payOrder(db, { order_id: Number(seg[2]), ...body });
      if (body.payment_type === '訂金') F.evaluateFormation(db, r.tour_id); // 確認後重算成團
      return json(res, 200, { ok: true });
    }
    // POST /api/orders/:id/cancel  取消(流程C)
    if (req.method === 'POST' && seg[1] === 'orders' && seg[3] === 'cancel') {
      const body = await readBody(req);
      const r = F.cancelOrder(db, { order_id: Number(seg[2]), reason: body.reason || '客取消' });
      F.evaluateFormation(db, r.tour_id);
      return json(res, 200, { ok: true, refund: r.refund });
    }
    // POST /api/orders/:id/contract  產生契約(未簽)→ 取得專屬該旅客的簽署連結
    if (req.method === 'POST' && seg[1] === 'orders' && seg[3] === 'contract') {
      const r = F.generateContract(db, { order_id: Number(seg[2]) });
      return json(res, 200, { ok: true, ...r });
    }
    // GET /api/sign/:token  憑 token 取簽署資料(查無 token 即 404,不公開)
    if (req.method === 'GET' && seg[1] === 'sign' && seg[2]) {
      const mc = F.contractByToken(db, seg[2]);
      if (!mc) return json(res, 404, { error: '簽署連結無效' });
      const order = db.prepare(
        `SELECT o.order_no, c.name AS customer_name, t.tour_code, t.start_date, t.end_date, p.name AS product_name, p.region_type
         FROM "order" o JOIN customer c ON c.customer_id=o.customer_id
         JOIN tour t ON t.tour_id=o.tour_id JOIN product p ON p.product_id=t.product_id WHERE o.order_id=?`
      ).get(mc.order_id);
      const items = db.prepare(
        `SELECT oi.qty, pt.name AS pt_name FROM order_item oi JOIN passenger_type pt ON pt.passenger_type_id=oi.passenger_type_id WHERE oi.order_id=?`
      ).all(mc.order_id);
      const tpl = db.prepare('SELECT template_name, pdf_file FROM contract_template WHERE contract_template_id=?').get(mc.contract_template_id);
      return json(res, 200, {
        order, items, template: tpl || null,
        contract: { contract_no: mc.contract_no, signed_status: mc.signed_status, signer_name: mc.signer_name, signed_at: mc.signed_at, signature: mc.signature || null },
      });
    }
    // POST /api/sign/:token  憑 token 送出簽署(只有該旅客的連結能簽)
    if (req.method === 'POST' && seg[1] === 'sign' && seg[2]) {
      const body = await readBody(req);
      const r = F.signByToken(db, { sign_token: seg[2], signature: body.signature });
      return json(res, 200, { ok: true, ...r });
    }
    // POST /api/orders/:id/expire-now  (展示用)立即讓佔位逾期
    if (req.method === 'POST' && seg[1] === 'orders' && seg[3] === 'expire-now') {
      db.prepare(`UPDATE "order" SET hold_expire_at=? WHERE order_id=? AND status='待付訂金'`)
        .run('2000-01-01T00:00:00', Number(seg[2]));
      return json(res, 200, { ok: true });
    }

    // 背景作業(流程B/D)— prototype 用按鈕手動觸發
    if (req.method === 'POST' && p === '/api/jobs/release-expired')
      return json(res, 200, { ok: true, ...F.releaseExpiredHolds(db) });
    if (req.method === 'POST' && p === '/api/jobs/check-deadlines')
      return json(res, 200, { ok: true, ...F.checkDeadlines(db) });

    return json(res, 404, { error: '無此 API' });
  } catch (e) {
    const isBiz = e instanceof F.BusinessError;
    if (!isBiz) console.error(e);
    return json(res, isBiz ? 400 : 500, { error: e.message });
  }
}

// 背景排程(每 30 秒自動跑流程B/D,模擬真實定時排程)
setInterval(() => {
  try {
    const a = F.releaseExpiredHolds(db);
    const b = F.checkDeadlines(db);
    if (a.released.length) console.log('[排程] 釋放逾期佔位:', a.released);
    if (b.result.length) console.log('[排程] 截止判定:', b.result);
  } catch (e) { console.error('[排程錯誤]', e); }
}, 30000);

server.listen(PORT, () => {
  console.log(`\n  旅遊團控系統 Prototype 已啟動`);
  console.log(`  ➜  前台/後台: http://localhost:${PORT}\n`);
  console.log('  提示:資料庫每次啟動會重建為乾淨種子資料。\n');
});
