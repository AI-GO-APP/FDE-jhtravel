// flows.js — 核心業務流程(對應 V1.1 流程補充 A/B/C/D)
//
// 設計重點(V1.1):庫存從「只會往前扣」→「會扣、會還、不會超賣、會自動判成團」的閉環。
//
// 鎖說明:SQLite 用 BEGIN IMMEDIATE 立即取得 write lock,等同悲觀鎖
//        (SELECT ... FOR UPDATE)的效果 — 同一時間只有一個交易能改這個 DB,
//        保證兩個人不會同時通過「庫存檢查」造成超賣。node:sqlite 為同步 API,
//        交易期間天然序列化。

const crypto = require('node:crypto');
const NOW = () => new Date().toISOString().slice(0, 19); // 'YYYY-MM-DDTHH:mm:ss'
const HOLD_HOURS = 24; // 佔位時限(V1.1 流程B)

// 業務錯誤(可回報給使用者,非系統 bug)
class BusinessError extends Error {}

// 交易包裹:BEGIN IMMEDIATE(取鎖)→ 成功 COMMIT / 失敗 ROLLBACK
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// 依 order_item 算每個資源要扣/要還的量(V1.1 流程A 步驟3 的算法)
// items: [{passenger_type_id, qty}] → Map(resource_type_id -> 總量)
function computeConsumption(db, items) {
  const ruleStmt = db.prepare(
    'SELECT resource_type_id, qty FROM consumption_rule WHERE passenger_type_id = ?'
  );
  const need = new Map();
  for (const it of items) {
    for (const r of ruleStmt.all(it.passenger_type_id)) {
      need.set(r.resource_type_id, (need.get(r.resource_type_id) || 0) + it.qty * r.qty);
    }
  }
  return need;
}

// 已報名人數 = 有效訂單(待付訂金 / 已確認 / 已完成)的 order_item.qty 總和
function signedPax(db, tour_id) {
  return db.prepare(
    `SELECT COALESCE(SUM(oi.qty),0) AS n FROM "order" o
     JOIN order_item oi ON oi.order_id=o.order_id
     WHERE o.tour_id=? AND o.status IN ('待付訂金','已確認','已完成')`
  ).get(tour_id).n;
}

// 預設價別 id(is_default=1 的啟用價別;查不到則取最小 id)。來源未指定價別時套此。
function defaultPriceTierId(db) {
  const row = db.prepare(
    "SELECT price_tier_id FROM price_tier WHERE is_default=1 AND status='啟用' ORDER BY sort_order, price_tier_id LIMIT 1"
  ).get() || db.prepare('SELECT MIN(price_tier_id) AS price_tier_id FROM price_tier').get();
  return row ? row.price_tier_id : 1;
}

// ───────────────────────────────────────────────────────────
// 流程 A + B:報名扣庫存(含防超賣鎖)+ 建立佔位
// ───────────────────────────────────────────────────────────
function createOrder(db, { tour_id, customer, channel, order_type, price_tier_id, items }) {
  if (!items || items.length === 0) throw new BusinessError('請至少選擇一位旅客');

  return tx(db, () => {
    const tour = db.prepare('SELECT * FROM tour WHERE tour_id=?').get(tour_id);
    if (!tour) throw new BusinessError('團期不存在');

    // 價別:未指定(如官網前台)時套用預設價別(直客價)
    const tier_id = price_tier_id || defaultPriceTierId(db);
    // 報名中、已成團 都可繼續報名(賣到滿為止);不成團取消/關閉/草稿 則不可
    if (tour.status !== '報名中' && tour.status !== '已成團')
      throw new BusinessError(`此團目前為「${tour.status}」,無法報名`);

    // 步驟3:算要扣量
    const need = computeConsumption(db, items);

    // 步驟2+4:鎖定庫存後逐一檢查是否超賣(BEGIN IMMEDIATE 已持有 write lock)
    const invRows = db.prepare(
      `SELECT i.resource_type_id, i.total_qty, i.used_qty, r.name
       FROM tour_inventory i JOIN resource_type r ON r.resource_type_id=i.resource_type_id
       WHERE i.tour_id=?`
    ).all(tour_id);
    const invMap = new Map(invRows.map(x => [x.resource_type_id, x]));

    for (const [rid, q] of need) {
      if (q === 0) continue;
      const row = invMap.get(rid);
      if (!row) continue; // 此團未管理該資源(如國內團無機位)→ 不檢查也不扣
      if (row.used_qty + q > row.total_qty) {
        // 任一資源不足 → 整筆 rollback,不扣任何東西(步驟4)
        const remain = row.total_qty - row.used_qty;
        throw new BusinessError(`${row.name}僅剩 ${remain},無法報名(本次需 ${q})`);
      }
    }

    // 報名人數上限檢查(max_pax > 0 時才管制)
    if (tour.max_pax && tour.max_pax > 0) {
      const newPax = items.reduce((a, i) => a + (i.qty || 0), 0);
      const signed = signedPax(db, tour_id);
      if (signed + newPax > tour.max_pax) {
        const left = tour.max_pax - signed;
        throw new BusinessError(`報名已達上限(${tour.max_pax} 位),僅剩 ${left} 位,無法報名(本次 ${newPax} 位)`);
      }
    }

    // 步驟5:全部通過,逐一扣庫存
    const updInv = db.prepare(
      'UPDATE tour_inventory SET used_qty = used_qty + ? WHERE tour_id=? AND resource_type_id=?'
    );
    for (const [rid, q] of need) if (q !== 0) updInv.run(q, tour_id, rid);

    // 建/取客戶
    let customer_id;
    const existing = customer.phone
      ? db.prepare('SELECT customer_id FROM customer WHERE phone=?').get(customer.phone)
      : null;
    if (existing) {
      customer_id = existing.customer_id;
    } else {
      const c = db.prepare(
        'INSERT INTO customer (name,phone,email,line_id,note,created_at) VALUES (?,?,?,?,?,?)'
      ).run(customer.name, customer.phone || '', customer.email || '', customer.line_id || '', '', NOW());
      customer_id = Number(c.lastInsertRowid);
    }

    // 步驟6:寫入 order,狀態=待付訂金,並設 hold_expire_at(流程B)
    const holdAt = addHours(NOW(), HOLD_HOURS);
    const orderNo = genOrderNo();
    const o = db.prepare(
      `INSERT INTO "order" (order_no,order_type,tour_id,customer_id,channel,price_tier_id,status,hold_expire_at,cancel_reason,refund_amount,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(orderNo, order_type || '一般', tour_id, customer_id, channel || '官網', tier_id, '待付訂金', holdAt, null, 0, NOW());
    const order_id = Number(o.lastInsertRowid);

    // order_item(依該單價別取成交價)
    const priceStmt = db.prepare('SELECT price FROM tour_price WHERE tour_id=? AND passenger_type_id=? AND price_tier_id=?');
    const insItem = db.prepare(
      `INSERT INTO order_item (order_id,passenger_type_id,qty,agreed_unit_price,agreed_subtotal,discount_amount,final_amount)
       VALUES (?,?,?,?,?,?,?)`
    );
    for (const it of items) {
      const pr = priceStmt.get(tour_id, it.passenger_type_id, tier_id);
      const unit = pr ? pr.price : 0;
      const subtotal = unit * it.qty;
      insItem.run(order_id, it.passenger_type_id, it.qty, unit, subtotal, 0, subtotal);
    }

    return { order_id, order_no: orderNo, hold_expire_at: holdAt };
  });
}

// ───────────────────────────────────────────────────────────
// 流程 B(成功路徑):付訂金 → 已確認;付尾款
// ───────────────────────────────────────────────────────────
function payOrder(db, { order_id, payment_type, amount, method, note, remark }) {
  return tx(db, () => {
    const order = db.prepare('SELECT * FROM "order" WHERE order_id=?').get(order_id);
    if (!order) throw new BusinessError('訂單不存在');
    if (order.status === '取消' || order.status === '逾期取消')
      throw new BusinessError('訂單已取消,無法收款');

    db.prepare(
      `INSERT INTO payment (order_id,payment_type,amount,method,paid_at,note,remark,created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(order_id, payment_type, amount, method || '信用卡', NOW(), note || '', remark || '', NOW());

    if (payment_type === '訂金') {
      // 時限內付了訂金 → 已確認,清除 hold_expire_at,位子轉正式佔用(流程B)
      db.prepare('UPDATE "order" SET status=?, hold_expire_at=NULL WHERE order_id=?')
        .run('已確認', order_id);
    }

    // 全額付清(訂金+尾款 ≥ 成交總額)→ 狀態轉「已完成」
    const total = db.prepare('SELECT COALESCE(SUM(final_amount),0) AS s FROM order_item WHERE order_id=?').get(order_id).s;
    const paid = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM payment WHERE order_id=?').get(order_id).s;
    if (total > 0 && paid >= total) {
      db.prepare('UPDATE "order" SET status=?, hold_expire_at=NULL WHERE order_id=?').run('已完成', order_id);
    }

    return { tour_id: order.tour_id };
  });
}

// ───────────────────────────────────────────────────────────
// 流程 C:取消 / 退訂(庫存歸還)
// reason: '客取消' | '逾期' | '不成團'
// ───────────────────────────────────────────────────────────
function cancelOrder(db, { order_id, reason }) {
  return tx(db, () => _cancelOrderInTx(db, order_id, reason));
}

// 供其他流程(逾期釋放、不成團)在既有交易內呼叫
function _cancelOrderInTx(db, order_id, reason) {
  const order = db.prepare('SELECT * FROM "order" WHERE order_id=?').get(order_id);
  if (!order) throw new BusinessError('訂單不存在');

  // 步驟2 防呆:已取消不可重複歸還
  if (order.status === '取消' || order.status === '逾期取消') {
    return { skipped: true, tour_id: order.tour_id };
  }

  // 步驟3:重算當初扣了多少
  const items = db.prepare(
    'SELECT passenger_type_id, qty FROM order_item WHERE order_id=?'
  ).all(order_id);
  const need = computeConsumption(db, items);

  // 步驟4:逐一歸還(理論上不會變負;若會則告警)
  const invStmt = db.prepare(
    'SELECT used_qty FROM tour_inventory WHERE tour_id=? AND resource_type_id=?'
  );
  const updInv = db.prepare(
    'UPDATE tour_inventory SET used_qty = used_qty - ? WHERE tour_id=? AND resource_type_id=?'
  );
  for (const [rid, q] of need) {
    if (q === 0) continue;
    const cur = invStmt.get(order.tour_id, rid);
    if (cur && cur.used_qty - q < 0) {
      console.warn(`[告警] 歸還後 used_qty 將為負:tour=${order.tour_id} resource=${rid}`);
    }
    updInv.run(q, order.tour_id, rid);
  }

  // 步驟6:若已收款 → 標記應退款金額(第一階段先記金額)
  const paid = db.prepare(
    'SELECT COALESCE(SUM(amount),0) AS s FROM payment WHERE order_id=?'
  ).get(order_id).s;
  const refund = paid; // 第一階段:已收款全額列為應退款(實際退費規則後補)

  // 步驟5:狀態 → 取消(逾期用「逾期取消」以利對帳),記 cancel_reason + cancelled_at
  const newStatus = reason === '逾期' ? '逾期取消' : '取消';
  db.prepare('UPDATE "order" SET status=?, cancel_reason=?, refund_amount=?, cancelled_at=? WHERE order_id=?')
    .run(newStatus, reason, refund, NOW(), order_id);

  return { skipped: false, tour_id: order.tour_id, refund };
}

// ───────────────────────────────────────────────────────────
// 流程 D:成團 / 不成團 自動判定
// ───────────────────────────────────────────────────────────

// 成團人數 = Σ order_item.qty(以「報名人數」計:有效訂單=待付訂金/已確認/已完成,
//            且該旅客類型 counts_toward_min=1,如嬰兒不計入)
function countConfirmedPax(db, tour_id) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(oi.qty),0) AS pax
     FROM "order" o
     JOIN order_item oi ON oi.order_id=o.order_id
     JOIN passenger_type pt ON pt.passenger_type_id=oi.passenger_type_id
     WHERE o.tour_id=? AND o.status IN ('待付訂金','已確認','已完成') AND pt.counts_toward_min=1`
  ).get(tour_id);
  return row.pax;
}

// 每次報名確認 / 取消後重算(流程D 判定1、2)
// 預設:已成團後掉回門檻以下「維持已成團」+ 跳警示(keepConfirmed 可設定)
function evaluateFormation(db, tour_id, { keepConfirmed = true } = {}) {
  return tx(db, () => {
    const tour = db.prepare('SELECT * FROM tour WHERE tour_id=?').get(tour_id);
    if (!tour) return null;
    if (tour.status === '不成團取消') return { status: tour.status, pax: 0 };

    const pax = countConfirmedPax(db, tour_id);

    if (tour.status !== '已成團' && pax >= tour.min_pax) {
      db.prepare('UPDATE tour SET status=?, confirmed_at=? WHERE tour_id=?')
        .run('已成團', NOW(), tour_id);
      return { status: '已成團', pax, justConfirmed: true };
    }

    if (tour.status === '已成團' && pax < tour.min_pax) {
      if (keepConfirmed) {
        return { status: '已成團', pax, warning: `已成團後掉回門檻以下(${pax}/${tour.min_pax}),維持已成團但需注意` };
      }
      db.prepare('UPDATE tour SET status=?, confirmed_at=NULL WHERE tour_id=?').run('報名中', tour_id);
      return { status: '報名中', pax };
    }

    return { status: tour.status, pax };
  });
}

// ───────────────────────────────────────────────────────────
// 流程 B(背景):釋放逾期未付訂金的佔位
// ───────────────────────────────────────────────────────────
function releaseExpiredHolds(db) {
  const now = NOW();
  const expired = db.prepare(
    `SELECT order_id FROM "order"
     WHERE status='待付訂金' AND hold_expire_at IS NOT NULL AND hold_expire_at < ?`
  ).all(now);

  const released = [];
  for (const { order_id } of expired) {
    tx(db, () => _cancelOrderInTx(db, order_id, '逾期'));
    released.push(order_id);
  }
  // 釋放後相關團不影響成團人數(逾期者本來就未確認),但仍重算保險
  return { released };
}

// ───────────────────────────────────────────────────────────
// 流程 D(背景):截止日仍未成團 → 不成團取消 + 全團退訂
// ───────────────────────────────────────────────────────────
function checkDeadlines(db) {
  const today = NOW().slice(0, 10); // YYYY-MM-DD
  const tours = db.prepare(
    `SELECT * FROM tour WHERE status='報名中' AND signup_deadline <= ?`
  ).all(today);

  const result = [];
  for (const tour of tours) {
    const pax = countConfirmedPax(db, tour.tour_id);
    if (pax >= tour.min_pax) {
      // 已達門檻但狀態還沒翻 → 補成團
      evaluateFormation(db, tour.tour_id);
      result.push({ tour_id: tour.tour_id, tour_code: tour.tour_code, outcome: '已成團', pax });
      continue;
    }
    // 不成團路徑:整團取消 + 退訂歸還庫存
    tx(db, () => {
      db.prepare('UPDATE tour SET status=? WHERE tour_id=?').run('不成團取消', tour.tour_id);
      const orders = db.prepare(
        `SELECT order_id FROM "order" WHERE tour_id=? AND status NOT IN ('取消','逾期取消')`
      ).all(tour.tour_id);
      for (const { order_id } of orders) _cancelOrderInTx(db, order_id, '不成團');
    });
    result.push({ tour_id: tour.tour_id, tour_code: tour.tour_code, outcome: '不成團取消', pax, min_pax: tour.min_pax });
  }
  return { result };
}

// ───────────────────────────────────────────────────────────
// 契約(V1.0 流程四)
// ───────────────────────────────────────────────────────────

// 依訂單所屬團期的「國內/國外」挑選對應的啟用範本
function resolveTemplate(db, order_id) {
  const region = db.prepare(
    `SELECT p.region_type FROM "order" o JOIN tour t ON t.tour_id=o.tour_id
     JOIN product p ON p.product_id=t.product_id WHERE o.order_id=?`
  ).get(order_id);
  const type = region && region.region_type === '國外' ? '國外' : '國內';
  return db.prepare(
    'SELECT * FROM contract_template WHERE contract_type=? AND is_active=1 ORDER BY contract_template_id LIMIT 1'
  ).get(type);
}

// 產生契約(狀態=未簽 + 不可猜 token)— 後台按下後得到專屬該旅客的簽署連結
function generateContract(db, { order_id }) {
  return tx(db, () => {
    const order = db.prepare('SELECT * FROM "order" WHERE order_id=?').get(order_id);
    if (!order) throw new BusinessError('訂單不存在');
    const exists = db.prepare('SELECT * FROM member_contract WHERE order_id=?').get(order_id);
    if (exists) return { contract_no: exists.contract_no, sign_token: exists.sign_token, signed_status: exists.signed_status };

    const tpl = resolveTemplate(db, order_id);
    if (!tpl) throw new BusinessError('查無對應的啟用契約範本');
    const contractNo = 'C' + order.order_no.replace(/^O/, '');
    const token = crypto.randomBytes(18).toString('hex'); // 36 字元,不可枚舉
    db.prepare(
      `INSERT INTO member_contract (order_id,contract_template_id,contract_version,contract_no,signed_status,signed_at,signer_name,signed_pdf_url,sign_token,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(order_id, tpl.contract_template_id, tpl.contract_version, contractNo, '未簽', null, '', tpl.pdf_file || '', token, NOW());
    return { contract_no: contractNo, sign_token: token, signed_status: '未簽' };
  });
}

// 用 token 取契約(公開簽署頁用;token 對不上就查無)
function contractByToken(db, token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM member_contract WHERE sign_token=?').get(token) || null;
}

// 客戶憑 token 線上簽署 — 只有拿到該連結的旅客能簽
// 簽署人固定為「報名人(訂單聯絡人)」,不採用前端傳入值,避免竄改
function signByToken(db, { sign_token, signature }) {
  return tx(db, () => {
    const mc = db.prepare('SELECT * FROM member_contract WHERE sign_token=?').get(sign_token);
    if (!mc) throw new BusinessError('簽署連結無效或已失效');
    if (!signature) throw new BusinessError('請完成手寫簽名');
    if (mc.signed_status === '已簽') return { contract_no: mc.contract_no, already: true };
    const cust = db.prepare(
      'SELECT c.name FROM "order" o JOIN customer c ON c.customer_id=o.customer_id WHERE o.order_id=?'
    ).get(mc.order_id);
    const signer = cust ? cust.name : '';
    db.prepare('UPDATE member_contract SET signed_status=?, signed_at=?, signer_name=?, signature=? WHERE member_contract_id=?')
      .run('已簽', NOW(), signer, signature, mc.member_contract_id);
    return { contract_no: mc.contract_no, signer_name: signer };
  });
}

// 編輯團期(門檻 / 上限 / 日期 / 截止日)
function updateTour(db, { tour_id, min_pax, max_pax, start_date, end_date, signup_deadline }) {
  const tour = db.prepare('SELECT * FROM tour WHERE tour_id=?').get(tour_id);
  if (!tour) throw new BusinessError('團期不存在');
  db.prepare(
    'UPDATE tour SET min_pax=?, max_pax=?, start_date=?, end_date=?, signup_deadline=? WHERE tour_id=?'
  ).run(
    min_pax != null ? Number(min_pax) : tour.min_pax,
    max_pax != null ? Number(max_pax) : tour.max_pax,
    start_date || tour.start_date,
    end_date || tour.end_date,
    signup_deadline || tour.signup_deadline,
    tour_id
  );
  return { ok: true };
}

// 儲存消耗規則 + 寫異動紀錄(誰、何時)
function saveConsumptionRules(db, { rules, edited_by }) {
  return tx(db, () => {
    const up = db.prepare('INSERT OR REPLACE INTO consumption_rule (passenger_type_id,resource_type_id,qty) VALUES (?,?,?)');
    for (const r of (rules || [])) up.run(r.passenger_type_id, r.resource_type_id, Number(r.qty) || 0);
    db.prepare('INSERT INTO consumption_rule_log (edited_by,edited_at,detail) VALUES (?,?,?)')
      .run(edited_by || 'OP 管理者', NOW(), `更新 ${(rules || []).length} 筆規則`);
    return { ok: true };
  });
}

// ───────────────────────────────────────────────────────────
// 後台操作:建立商品(步驟1)
// ───────────────────────────────────────────────────────────
function createProduct(db, { product_code, name, region_type, days }) {
  if (!name) throw new BusinessError('請填寫行程名稱');
  const r = db.prepare(
    'INSERT INTO product (product_code,name,region_type,days,status,created_at) VALUES (?,?,?,?,?,?)'
  ).run(product_code || '', name, region_type || '國內', Number(days) || 1, '上架', NOW());
  return { product_id: Number(r.lastInsertRowid) };
}

// ───────────────────────────────────────────────────────────
// 後台操作:開團(步驟2~4)— 建立 tour + 庫存 + 售價(同一交易)
// inventory: [{resource_type_id, total_qty}]
// prices:    [{passenger_type_id, price, deposit_ratio}]
// ───────────────────────────────────────────────────────────
function createTour(db, { product_id, tour_code, start_date, end_date, min_pax, max_pax, signup_deadline, inventory, prices }) {
  if (!product_id) throw new BusinessError('請選擇商品');
  if (!tour_code) throw new BusinessError('請填寫團號');
  if (!start_date) throw new BusinessError('請填寫出發日期');

  return tx(db, () => {
    const prod = db.prepare('SELECT * FROM product WHERE product_id=?').get(product_id);
    if (!prod) throw new BusinessError('商品不存在');

    const r = db.prepare(
      `INSERT INTO tour (tour_code,product_id,start_date,end_date,min_pax,max_pax,signup_deadline,status,manual_group_status,confirmed_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(tour_code, product_id, start_date, end_date || start_date, Number(min_pax) || 0, Number(max_pax) || 0,
          signup_deadline || start_date, '報名中', '待定', null, NOW());
    const tour_id = Number(r.lastInsertRowid);

    const invStmt = db.prepare(
      'INSERT INTO tour_inventory (tour_id,resource_type_id,total_qty,used_qty) VALUES (?,?,?,0)'
    );
    for (const i of (inventory || [])) {
      if (i.total_qty != null && Number(i.total_qty) > 0) {
        invStmt.run(tour_id, i.resource_type_id, Number(i.total_qty));
      }
    }

    const priceStmt = db.prepare(
      'INSERT OR REPLACE INTO tour_price (tour_id,passenger_type_id,price_tier_id,price,deposit_ratio,created_at) VALUES (?,?,?,?,?,?)'
    );
    const fallbackTier = defaultPriceTierId(db);
    for (const p of (prices || [])) {
      if (p.price != null && Number(p.price) > 0) {
        priceStmt.run(tour_id, p.passenger_type_id, p.price_tier_id || fallbackTier, Number(p.price), p.deposit_ratio != null ? Number(p.deposit_ratio) : 0.3, NOW());
      }
    }

    return { tour_id, tour_code };
  });
}

// ───────────────────────────────────────────────────────────
// 後台操作:新增旅客(步驟7)— 為訂單登記實際出團的人
// ───────────────────────────────────────────────────────────
function addTraveler(db, { order_id, passenger_type_id, name, english_name, birthday, gender, nationality, id_no, passport_no, passport_expire_date }) {
  const order = db.prepare('SELECT order_id, status FROM "order" WHERE order_id=?').get(order_id);
  if (!order) throw new BusinessError('訂單不存在');
  if (order.status === '取消' || order.status === '逾期取消') throw new BusinessError('訂單已取消,無法新增旅客');
  if (!name) throw new BusinessError('請填寫旅客姓名');

  // 旅客人數不可超過報名人數(order_item 的 qty 總和)
  const headcount = db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM order_item WHERE order_id=?').get(order_id).n;
  const current = db.prepare('SELECT COUNT(*) AS n FROM traveler WHERE order_id=?').get(order_id).n;
  if (current >= headcount) {
    throw new BusinessError(`旅客人數已達報名人數上限(${headcount} 位);如需加人,請另開一筆訂單`);
  }

  const r = db.prepare(
    `INSERT INTO traveler (order_id,passenger_type_id,name,english_name,birthday,gender,nationality,id_no,passport_no,passport_expire_date)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(order_id, passenger_type_id || null, name, english_name || '', birthday || '', gender || '',
        nationality || '台灣', id_no || '', passport_no || '', passport_expire_date || '');
  return { traveler_id: Number(r.lastInsertRowid) };
}

// ───────────────────────────────────────────────────────────
// 工具
// ───────────────────────────────────────────────────────────
function addHours(iso, h) {
  const d = new Date(iso);
  d.setHours(d.getHours() + h);
  return d.toISOString().slice(0, 19);
}
let _seq = 0;
function genOrderNo() {
  _seq += 1;
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
  return 'O' + ymd + String(Date.now() % 100000).padStart(5, '0') + _seq;
}

module.exports = {
  BusinessError,
  NOW,
  createOrder,
  payOrder,
  cancelOrder,
  evaluateFormation,
  countConfirmedPax,
  releaseExpiredHolds,
  checkDeadlines,
  generateContract,
  contractByToken,
  signByToken,
  resolveTemplate,
  createProduct,
  createTour,
  updateTour,
  addTraveler,
  saveConsumptionRules,
  signedPax,
};
