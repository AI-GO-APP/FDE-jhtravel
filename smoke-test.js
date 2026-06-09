// smoke-test.js — 端對端煙霧測試(流程 A/B/C/D + 契約)
//
// 執行:node smoke-test.js
//   會自動啟動 server.js(子行程,乾淨 DB)→ 跑斷言 → 關閉伺服器。
//   全數通過 exit 0;任一失敗 exit 1。
//
// 注意:一律以 Node http client 送純 UTF-8 body,避免 shell/curl 對中文重新編碼。

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
      const r = http.get(`http://localhost:${PORT}/api/tours`, res => { res.resume(); resolve(); });
      r.on('error', () => { if (--retries <= 0) reject(new Error('server 未就緒')); else setTimeout(tick, 150); });
    };
    tick();
  });
}

async function run() {
  // ── 流程 A:報名扣庫存 + 防超賣 ──
  console.log('\n[流程 A] 報名扣庫存 + 防超賣鎖');
  const r1 = await req('POST', '/api/orders', {
    tour_id: 1, channel: '官網', customer: { name: '王小明', phone: '0911111111' },
    items: [{ passenger_type_id: 1, qty: 5 }, { passenger_type_id: 4, qty: 1 }], // 5大人+1嬰兒
  });
  check('5大人+1嬰兒 報名成功', r1.status === 200 && r1.body.ok, JSON.stringify(r1.body));
  const order1 = r1.body.order_id;

  const r2 = await req('POST', '/api/orders', {
    tour_id: 1, customer: { name: '李大華', phone: '0922222222' },
    items: [{ passenger_type_id: 1, qty: 4 }], // 車位剩3,需4 → 擋
  });
  check('超賣被擋(車位剩3 需4)', r2.status === 400 && /車位僅剩 3/.test(r2.body.error), JSON.stringify(r2.body));

  const t1 = (await req('GET', '/api/tours/1')).body;
  const car = t1.inventory.find(i => i.name === '車位');
  check('車位已扣 5(剩3,嬰兒不佔位)', car.used_qty === 5 && car.remain === 3, `used=${car.used_qty}`);

  const r3 = await req('POST', '/api/orders', {
    tour_id: 1, customer: { name: '陳美麗', phone: '0933333333' },
    items: [{ passenger_type_id: 1, qty: 3 }], // 剛好補滿
  });
  check('補報3大人成功(車位滿)', r3.status === 200 && r3.body.ok);
  const order3 = r3.body.order_id;

  // ── 流程 B:付訂金→已確認;逾期釋放 ──
  console.log('\n[流程 B] 佔位 / 付訂金確認 / 逾期自動釋放');
  await req('POST', `/api/orders/${order1}/pay`, { payment_type: '訂金', amount: 6900 });
  const o1 = (await req('GET', `/api/orders/${order1}`)).body;
  check('付訂金後狀態→已確認、清除佔位', o1.status === '已確認' && !o1.hold_expire_at, o1.status);

  // order3 待付訂金 → 模擬逾期 → 釋放
  await req('POST', `/api/orders/${order3}/expire-now`);
  const rel = await req('POST', '/api/jobs/release-expired');
  check('釋放逾期佔位 1 筆', rel.body.released.includes(order3), JSON.stringify(rel.body.released));
  const o3 = (await req('GET', `/api/orders/${order3}`)).body;
  check('逾期訂單→逾期取消、原因=逾期', o3.status === '逾期取消' && o3.cancel_reason === '逾期', o3.status);
  const carAfter = (await req('GET', '/api/tours/1')).body.inventory.find(i => i.name === '車位');
  check('逾期釋放後車位歸還(剩3)', carAfter.remain === 3, `remain=${carAfter.remain}`);

  // ── 流程 D:成團判定 ──
  console.log('\n[流程 D] 成團 / 不成團判定');
  // 團2 門檻10:報6+5=11,均付訂金 → 已成團
  const a = (await req('POST', '/api/orders', { tour_id: 2, customer: { name: '測試A', phone: '0901' }, items: [{ passenger_type_id: 1, qty: 6 }] })).body;
  const b = (await req('POST', '/api/orders', { tour_id: 2, customer: { name: '測試B', phone: '0902' }, items: [{ passenger_type_id: 1, qty: 5 }] })).body;
  await req('POST', `/api/orders/${a.order_id}/pay`, { payment_type: '訂金', amount: 7000 });
  await req('POST', `/api/orders/${b.order_id}/pay`, { payment_type: '訂金', amount: 6000 });
  let t2 = (await req('GET', '/api/tours/2')).body;
  check('11人 ≥ 門檻10 → 已成團、記 confirmed_at', t2.tour.status === '已成團' && !!t2.tour.confirmed_at, t2.tour.status);

  // ── 流程 C:取消還庫存 + 應退款 + 防呆 ──
  console.log('\n[流程 C] 取消還庫存 / 應退款 / 防呆');
  const carB2 = (await req('GET', '/api/tours/2')).body.inventory.find(i => i.name === '車位').remain;
  const cancel = await req('POST', `/api/orders/${b.order_id}/cancel`, { reason: '客取消' });
  check('取消已收款訂單 → 應退款=6000', cancel.body.refund === 6000, JSON.stringify(cancel.body));
  const carB2after = (await req('GET', '/api/tours/2')).body.inventory.find(i => i.name === '車位').remain;
  check('取消後車位歸還(+5)', carB2after === carB2 + 5, `${carB2}→${carB2after}`);
  t2 = (await req('GET', '/api/tours/2')).body;
  check('已成團後掉回門檻下 → 預設維持已成團', t2.tour.status === '已成團' && t2.confirmed_pax === 6, `${t2.tour.status}/${t2.confirmed_pax}`);
  const dup = await req('POST', `/api/orders/${b.order_id}/cancel`, { reason: '客取消' });
  check('重複取消防呆(不報錯、不重複歸還)', dup.status === 200, JSON.stringify(dup.body));
  const carDup = (await req('GET', '/api/tours/2')).body.inventory.find(i => i.name === '車位').remain;
  check('重複取消後庫存不變', carDup === carB2after, `remain=${carDup}`);

  // 團3:截止日=今天、0人 → 不成團取消(背景排程或手動觸發)
  const dl = await req('POST', '/api/jobs/check-deadlines');
  const t3 = (await req('GET', '/api/tours/3')).body;
  check('截止日未達門檻 → 不成團取消', t3.tour.status === '不成團取消', `${t3.tour.status} (job=${JSON.stringify(dl.body.result)})`);

  // ── 契約(V1.0 流程四)──
  console.log('\n[契約] 產生並簽署報名契約');
  const meta = (await req('GET', '/api/meta')).body;
  const sign = await req('POST', `/api/orders/${order1}/sign`, { contract_template_id: meta.contract_templates[0].contract_template_id, signer_name: '王小明' });
  check('簽署成功並產生契約編號', sign.status === 200 && !!sign.body.contract_no, JSON.stringify(sign.body));
  const o1c = (await req('GET', `/api/orders/${order1}`)).body;
  check('訂單契約狀態=已簽', o1c.contract && o1c.contract.signed_status === '已簽', JSON.stringify(o1c.contract));
}

(async () => {
  console.log('啟動 server.js(子行程)…');
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { stdio: 'ignore' });
  try {
    await waitReady();
    await run();
  } catch (e) {
    fail++; console.error('\n測試執行錯誤:', e.message);
  } finally {
    srv.kill();
    console.log(`\n──────── 結果:${pass} 通過 / ${fail} 失敗 ────────`);
    process.exit(fail ? 1 : 0);
  }
})();
