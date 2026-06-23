// tests/flows.test.js — 後台操作 + 核心流程 A/B/C/D(自建資料)
//
// 執行:node tests/flows.test.js
//   自動啟動 server.js(子行程,乾淨 DB)→ 跑斷言 → 關閉伺服器。
//   全過 exit 0;任一失敗 exit 1。
//
// 涵蓋:
//   ・後台寫入操作:建商品 → 開團(設庫存/售價)→ 建訂單(扣庫存)→ 新增旅客 → 收款
//   ・流程A 報名扣庫存(含防超賣鎖)
//   ・流程B 佔位 / 付訂金確認 / 逾期自動釋放
//   ・流程C 取消 / 退訂(庫存歸還)
//   ・流程D 成團 / 不成團判定
//
// 測試自己用 API 開測試團,不依賴種子資料 → 種子改了也不會壞。
// 一律以 Node http client 送純 UTF-8,避免 shell/curl 對中文重新編碼。

const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 3000;
let pass = 0, fail = 0;

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const r = http.request(
      { host: 'localhost', port: PORT, path: p, method,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...(data ? { 'Content-Length': data.length } : {}) } },
      res => { let s = ''; res.setEncoding('utf8'); res.on('data', c => s += c);
        res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : {} })); }
    );
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}
function waitReady(retries = 40) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      const r = http.get(`http://localhost:${PORT}/api/products`, res => { res.resume(); resolve(); });
      r.on('error', () => { if (--retries <= 0) reject(new Error('server 未就緒')); else setTimeout(tick, 150); });
    };
    tick();
  });
}
const car = (td) => td.inventory.find(i => i.name === '車位');

// 後台:建商品 + 開團(回傳 product_id / tour_id),順帶驗證這兩個寫入操作
async function openTour({ tour_code, min_pax, deadline, total = 8, assert = false }) {
  const prod = await req('POST', '/api/products', { product_code: 'TEST', name: '煙霧測試商品', region_type: '國內', days: 2 });
  const tour = await req('POST', '/api/tours', {
    product_id: prod.body.product_id, tour_code, start_date: '2026-12-01', end_date: '2026-12-02',
    min_pax, signup_deadline: deadline,
    inventory: [{ resource_type_id: 1, total_qty: total }, { resource_type_id: 2, total_qty: total }],
    prices: [{ passenger_type_id: 1, price: 4500, deposit_ratio: 0.3 }],
  });
  if (assert) {
    check('後台建立商品成功', prod.status === 200 && prod.body.product_id > 0, JSON.stringify(prod.body));
    check('後台開團(含庫存+售價)成功', tour.status === 200 && tour.body.tour_id > 0, JSON.stringify(tour.body));
  }
  return tour.body.tour_id;
}

async function run() {
  // ── 流程 A:報名扣庫存 + 防超賣(車位8 的測試團)──
  console.log('\n[後台操作 + 流程 A] 開團 / 報名扣庫存 / 防超賣鎖');
  const tA = await openTour({ tour_code: 'FLOW-A', min_pax: 6, deadline: '2026-11-01', total: 8, assert: true });

  const r1 = await req('POST', '/api/orders', { tour_id: tA, channel: '櫃台', customer: { name: '甲', phone: '0900000001' }, items: [{ passenger_type_id: 1, qty: 5 }] });
  check('建立訂單成功(5大人,扣庫存)', r1.status === 200 && r1.body.ok, JSON.stringify(r1.body));
  const orderA1 = r1.body.order_id;
  const tdA0 = (await req('GET', `/api/tours/${tA}`)).body;
  check('成團進度以報名人數計(待付訂金也算 → 5)', tdA0.confirmed_pax === 5, `confirmed=${tdA0.confirmed_pax}`);

  const r2 = await req('POST', '/api/orders', { tour_id: tA, customer: { name: '乙', phone: '0900000002' }, items: [{ passenger_type_id: 1, qty: 4 }] });
  check('超賣被擋(車位剩3 需4)', r2.status === 400 && /車位僅剩 3/.test(r2.body.error), JSON.stringify(r2.body));

  const c1 = car((await req('GET', `/api/tours/${tA}`)).body);
  check('車位已扣 5(剩3)', c1.used_qty === 5 && c1.remain === 3, `used=${c1.used_qty}`);

  const r3 = await req('POST', '/api/orders', { tour_id: tA, customer: { name: '丙', phone: '0900000003' }, items: [{ passenger_type_id: 1, qty: 3 }] });
  check('補報3大人成功(車位滿)', r3.status === 200 && r3.body.ok);
  const orderA2 = r3.body.order_id;

  // 新增旅客(後台寫入操作)
  const tv = await req('POST', `/api/orders/${orderA1}/travelers`, { passenger_type_id: 1, name: '測試旅客', id_no: 'A123456789', gender: '男' });
  const od1 = (await req('GET', `/api/orders/${orderA1}`)).body;
  check('新增旅客成功並掛在訂單', tv.status === 200 && od1.travelers.length === 1, JSON.stringify(tv.body));

  // ── 流程 B:付訂金→已確認;逾期釋放 ──
  console.log('\n[流程 B] 收款確認 / 逾期自動釋放');
  await req('POST', `/api/orders/${orderA1}/pay`, { payment_type: '訂金', amount: 6750 });
  const o1 = (await req('GET', `/api/orders/${orderA1}`)).body;
  check('收訂金後狀態→已確認、清除佔位', o1.status === '已確認' && !o1.hold_expire_at, o1.status);

  // 付清尾款 → 已完成(5大人 @4500 = 22500;訂金6750 + 尾款15750)
  await req('POST', `/api/orders/${orderA1}/pay`, { payment_type: '尾款', amount: 15750 });
  const o1full = (await req('GET', `/api/orders/${orderA1}`)).body;
  check('付清尾款 → 狀態轉「已完成」', o1full.status === '已完成' && o1full.paid === 22500, o1full.status);

  await req('POST', `/api/orders/${orderA2}/expire-now`, {});
  const rel = await req('POST', '/api/jobs/release-expired', {});
  check('釋放逾期佔位含該訂單', rel.body.released.includes(orderA2), JSON.stringify(rel.body.released));
  const o2 = (await req('GET', `/api/orders/${orderA2}`)).body;
  check('逾期訂單→逾期取消、原因=逾期', o2.status === '逾期取消' && o2.cancel_reason === '逾期', o2.status);
  check('逾期釋放後車位歸還(剩3)', car((await req('GET', `/api/tours/${tA}`)).body).remain === 3);

  // ── 流程 D:成團判定(再加一筆確認 → 5+2=7 ≥ 門檻6)──
  console.log('\n[流程 D] 成團 / 不成團判定');
  const r4 = await req('POST', '/api/orders', { tour_id: tA, customer: { name: '丁', phone: '0900000004' }, items: [{ passenger_type_id: 1, qty: 2 }] });
  await req('POST', `/api/orders/${r4.body.order_id}/pay`, { payment_type: '訂金', amount: 2700 });
  let tdA = (await req('GET', `/api/tours/${tA}`)).body;
  check('7人 ≥ 門檻6 → 已成團、記 confirmed_at', tdA.tour.status === '已成團' && !!tdA.tour.confirmed_at, tdA.tour.status);

  // ── 流程 C:取消還庫存 + 應退款 + 防呆 ──
  console.log('\n[流程 C] 取消還庫存 / 應退款 / 防呆');
  const carBefore = car((await req('GET', `/api/tours/${tA}`)).body).remain;
  const cancel = await req('POST', `/api/orders/${r4.body.order_id}/cancel`, { reason: '客取消' });
  check('取消已收款訂單 → 應退款=2700', cancel.body.refund === 2700, JSON.stringify(cancel.body));
  const carAfter = car((await req('GET', `/api/tours/${tA}`)).body).remain;
  check('取消後車位歸還(+2)', carAfter === carBefore + 2, `${carBefore}→${carAfter}`);
  tdA = (await req('GET', `/api/tours/${tA}`)).body;
  check('已成團後掉回門檻下 → 預設維持已成團', tdA.tour.status === '已成團', tdA.tour.status);
  const dup = await req('POST', `/api/orders/${r4.body.order_id}/cancel`, { reason: '客取消' });
  check('重複取消防呆(不報錯、不重複歸還)', dup.status === 200, JSON.stringify(dup.body));
  check('重複取消後庫存不變', car((await req('GET', `/api/tours/${tA}`)).body).remain === carAfter);

  // ── 報名上限(max_pax)+ 編輯 ──
  console.log('\n[報名上限] max_pax 限制 + 編輯團期');
  const pC = await req('POST', '/api/products', { name: '上限測試', region_type: '國內', days: 1 });
  const tC = await req('POST', '/api/tours', {
    product_id: pC.body.product_id, tour_code: 'FLOW-CAP', start_date: '2026-12-01', min_pax: 2, max_pax: 4, signup_deadline: '2026-11-01',
    inventory: [{ resource_type_id: 1, total_qty: 50 }, { resource_type_id: 2, total_qty: 50 }],
    prices: [{ passenger_type_id: 1, price: 1000, deposit_ratio: 0.3 }],
  });
  const cid = tC.body.tour_id;
  const cap1 = await req('POST', '/api/orders', { tour_id: cid, customer: { name: '甲', phone: '09c1' }, items: [{ passenger_type_id: 1, qty: 3 }] });
  check('上限內報名成功(3 ≤ 4)', cap1.status === 200 && cap1.body.ok, JSON.stringify(cap1.body));
  const cap2 = await req('POST', '/api/orders', { tour_id: cid, customer: { name: '乙', phone: '09c2' }, items: [{ passenger_type_id: 1, qty: 2 }] });
  check('超過上限被擋(3+2 > 4)', cap2.status === 400 && /上限/.test(cap2.body.error || ''), JSON.stringify(cap2.body));
  await req('POST', `/api/tours/${cid}`, { min_pax: 2, max_pax: 10 });
  const capEd = await req('POST', '/api/orders', { tour_id: cid, customer: { name: '丙', phone: '09c3' }, items: [{ passenger_type_id: 1, qty: 2 }] });
  check('調高上限後可再報名(改為 10)', capEd.status === 200 && capEd.body.ok, JSON.stringify(capEd.body));

  // ── 契約:產生 token 連結 + 憑 token 線上簽署 ──
  console.log('\n[契約] 產生簽署連結 + 憑 token 簽署(僅此連結可簽)');
  const oc = await req('POST', '/api/orders', { tour_id: cid, customer: { name: '簽約客', phone: '09c4' }, items: [{ passenger_type_id: 1, qty: 1 }] });
  const gen = await req('POST', `/api/orders/${oc.body.order_id}/contract`);
  check('產生契約並取得 token(未簽)', gen.status === 200 && !!gen.body.sign_token && gen.body.signed_status === '未簽', JSON.stringify(gen.body).slice(0, 90));
  const token = gen.body.sign_token;
  const info = await req('GET', '/api/sign/' + token);
  check('憑 token 取得簽署資料、對應國內範本', info.status === 200 && /國內/.test(info.body.template.template_name), JSON.stringify(info.body.template));
  const bad = await req('GET', '/api/sign/zzz' + token);
  check('錯誤 token → 查無(404,非公開)', bad.status === 404, bad.status);
  const noSig = await req('POST', '/api/sign/' + token, { signer_name: '簽約客' });
  check('未手寫簽名 → 被擋', noSig.status === 400 && /簽名/.test(noSig.body.error || ''), JSON.stringify(noSig.body));
  const fakeSig = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const sg = await req('POST', '/api/sign/' + token, { signer_name: '簽約客', signature: fakeSig });
  check('憑 token + 手寫簽名簽署成功', sg.status === 200 && !!sg.body.contract_no, JSON.stringify(sg.body));
  const info2 = await req('GET', '/api/sign/' + token);
  check('簽署後狀態 → 已簽', info2.body.contract.signed_status === '已簽', info2.body.contract.signed_status);

  // ── 價別:直客價 / 同業價,依指定套不同價;未指定套預設 ──
  console.log('\n[價別] 直客價 / 同業價 套不同單價');
  const meta = (await req('GET', '/api/meta')).body;
  const directTier = meta.price_tiers.find(t => t.is_default);
  const agentTier = meta.price_tiers.find(t => /同業/.test(t.name));
  check('價別主檔含直客價(預設)+ 同業價', !!directTier && !!agentTier, JSON.stringify(meta.price_tiers));
  const pT = await req('POST', '/api/products', { name: '價別測試', region_type: '國內', days: 1 });
  const tT = await req('POST', '/api/tours', {
    product_id: pT.body.product_id, tour_code: 'FLOW-TIER', start_date: '2026-12-01', min_pax: 1, signup_deadline: '2026-11-01',
    inventory: [{ resource_type_id: 1, total_qty: 20 }, { resource_type_id: 2, total_qty: 20 }],
    prices: [
      { passenger_type_id: 1, price_tier_id: directTier.price_tier_id, price: 10000, deposit_ratio: 0.3 },
      { passenger_type_id: 1, price_tier_id: agentTier.price_tier_id, price: 8000, deposit_ratio: 0.3 },
    ],
  });
  const tierTour = tT.body.tour_id;
  const oD = await req('POST', '/api/orders', { tour_id: tierTour, channel: '官網', price_tier_id: directTier.price_tier_id, customer: { name: '直客', phone: '09t1' }, items: [{ passenger_type_id: 1, qty: 1 }] });
  const odD = (await req('GET', `/api/orders/${oD.body.order_id}`)).body;
  check('指定直客價 → 單價10000、訂單顯示「直客價」', odD.items[0].agreed_unit_price === 10000 && odD.price_tier_name === '直客價', `${odD.items[0].agreed_unit_price}/${odD.price_tier_name}`);
  const oA = await req('POST', '/api/orders', { tour_id: tierTour, channel: '同業', price_tier_id: agentTier.price_tier_id, customer: { name: '同業', phone: '09t2' }, items: [{ passenger_type_id: 1, qty: 1 }] });
  const odA = (await req('GET', `/api/orders/${oA.body.order_id}`)).body;
  check('指定同業價 → 單價8000(低於直客)、顯示「同業價」', odA.items[0].agreed_unit_price === 8000 && odA.price_tier_name === '同業價', `${odA.items[0].agreed_unit_price}/${odA.price_tier_name}`);
  const oU = await req('POST', '/api/orders', { tour_id: tierTour, channel: '櫃台', customer: { name: '未指定', phone: '09t3' }, items: [{ passenger_type_id: 1, qty: 1 }] });
  const odU = (await req('GET', `/api/orders/${oU.body.order_id}`)).body;
  check('未指定價別 → 自動套預設(直客價10000)', odU.items[0].agreed_unit_price === 10000 && odU.price_tier_name === '直客價', `${odU.items[0].agreed_unit_price}/${odU.price_tier_name}`);

  // 不成團:開一個截止日已過、0 人的團 → 判定不成團取消
  const tB = await openTour({ tour_code: 'FLOW-B', min_pax: 8, deadline: '2020-01-01', total: 16 });
  await req('POST', '/api/jobs/check-deadlines', {});
  const tdB = (await req('GET', `/api/tours/${tB}`)).body;
  check('截止日未達門檻 → 不成團取消', tdB.tour.status === '不成團取消', tdB.tour.status);
}

(async () => {
  console.log('啟動 server.js(子行程)…');
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { stdio: 'ignore' });
  try { await waitReady(); await run(); }
  catch (e) { fail++; console.error('\n測試執行錯誤:', e.message); }
  finally {
    srv.kill();
    console.log(`\n──────── 結果:${pass} 通過 / ${fail} 失敗 ────────`);
    process.exit(fail ? 1 : 0);
  }
})();
