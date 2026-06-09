// flows.js — 核心業務流程(對應 V1.1 流程補充 A/B/C/D)
//
// 設計重點(V1.1):庫存從「只會往前扣」→「會扣、會還、不會超賣、會自動判成團」的閉環。
//
// 鎖說明:SQLite 用 BEGIN IMMEDIATE 立即取得 write lock,等同悲觀鎖
//        (SELECT ... FOR UPDATE)的效果 — 同一時間只有一個交易能改這個 DB,
//        保證兩個人不會同時通過「庫存檢查」造成超賣。node:sqlite 為同步 API,
//        交易期間天然序列化。

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

// ───────────────────────────────────────────────────────────
// 流程 A + B:報名扣庫存(含防超賣鎖)+ 建立佔位
// ───────────────────────────────────────────────────────────
function createOrder(db, { tour_id, customer, channel, order_type, items }) {
  if (!items || items.length === 0) throw new BusinessError('請至少選擇一位旅客');

  return tx(db, () => {
    const tour = db.prepare('SELECT * FROM tour WHERE tour_id=?').get(tour_id);
    if (!tour) throw new BusinessError('團期不存在');
    if (tour.status !== '報名中') throw new BusinessError(`此團目前為「${tour.status}」,無法報名`);

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
      `INSERT INTO "order" (order_no,order_type,tour_id,customer_id,channel,status,hold_expire_at,cancel_reason,refund_amount,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(orderNo, order_type || '一般', tour_id, customer_id, channel || '官網', '待付訂金', holdAt, null, 0, NOW());
    const order_id = Number(o.lastInsertRowid);

    // order_item(取成交價)
    const priceStmt = db.prepare('SELECT price FROM tour_price WHERE tour_id=? AND passenger_type_id=?');
    const insItem = db.prepare(
      `INSERT INTO order_item (order_id,passenger_type_id,qty,agreed_unit_price,agreed_subtotal,discount_amount,final_amount)
       VALUES (?,?,?,?,?,?,?)`
    );
    for (const it of items) {
      const pr = priceStmt.get(tour_id, it.passenger_type_id);
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
function payOrder(db, { order_id, payment_type, amount, method }) {
  return tx(db, () => {
    const order = db.prepare('SELECT * FROM "order" WHERE order_id=?').get(order_id);
    if (!order) throw new BusinessError('訂單不存在');
    if (order.status === '取消' || order.status === '逾期取消')
      throw new BusinessError('訂單已取消,無法收款');

    db.prepare(
      `INSERT INTO payment (order_id,payment_type,amount,method,paid_at,note,created_at)
       VALUES (?,?,?,?,?,?,?)`
    ).run(order_id, payment_type, amount, method || '信用卡', NOW(), '', NOW());

    if (payment_type === '訂金') {
      // 時限內付了訂金 → 已確認,清除 hold_expire_at,位子轉正式佔用(流程B)
      db.prepare('UPDATE "order" SET status=?, hold_expire_at=NULL WHERE order_id=?')
        .run('已確認', order_id);
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

  // 步驟5:狀態 → 取消(逾期用「逾期取消」以利對帳),記 cancel_reason
  const newStatus = reason === '逾期' ? '逾期取消' : '取消';
  db.prepare('UPDATE "order" SET status=?, cancel_reason=?, refund_amount=? WHERE order_id=?')
    .run(newStatus, reason, refund, order_id);

  return { skipped: false, tour_id: order.tour_id, refund };
}

// ───────────────────────────────────────────────────────────
// 流程 D:成團 / 不成團 自動判定
// ───────────────────────────────────────────────────────────

// 已成團人數 = Σ order_item.qty(限 counts_toward_min=1 且 訂單為已確認)
function countConfirmedPax(db, tour_id) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(oi.qty),0) AS pax
     FROM "order" o
     JOIN order_item oi ON oi.order_id=o.order_id
     JOIN passenger_type pt ON pt.passenger_type_id=oi.passenger_type_id
     WHERE o.tour_id=? AND o.status='已確認' AND pt.counts_toward_min=1`
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
// 契約簽署(V1.0 流程四)
// ───────────────────────────────────────────────────────────
function signContract(db, { order_id, contract_template_id, signer_name }) {
  return tx(db, () => {
    const order = db.prepare('SELECT * FROM "order" WHERE order_id=?').get(order_id);
    if (!order) throw new BusinessError('訂單不存在');
    const tpl = db.prepare('SELECT * FROM contract_template WHERE contract_template_id=?').get(contract_template_id);
    if (!tpl) throw new BusinessError('契約範本不存在');

    const exists = db.prepare('SELECT member_contract_id FROM member_contract WHERE order_id=?').get(order_id);
    const contractNo = 'C' + order.order_no.slice(1);
    if (exists) {
      db.prepare(
        'UPDATE member_contract SET signed_status=?, signed_at=?, signer_name=?, signed_pdf_url=? WHERE order_id=?'
      ).run('已簽', NOW(), signer_name, `/contracts/${contractNo}.pdf`, order_id);
    } else {
      db.prepare(
        `INSERT INTO member_contract (order_id,contract_template_id,contract_version,contract_no,signed_status,signed_at,signer_name,signed_pdf_url,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(order_id, contract_template_id, tpl.contract_version, contractNo, '已簽', NOW(), signer_name, `/contracts/${contractNo}.pdf`, NOW());
    }
    return { contract_no: contractNo };
  });
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
  signContract,
};
