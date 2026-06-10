// test-backend-mvp.js — 後台 MVP 端對端測試(資料庫總覽 步驟 1~10)
//
// 執行:node test-backend-mvp.js
//   自動啟動 server.js(子行程,乾淨 DB)→ 跑斷言 → 關閉伺服器。
//   全過 exit 0;任一失敗 exit 1。
//
// 兩部分:
//   A. 驗證種子故事(王小明報名花蓮三日遊)已涵蓋步驟 1~10
//   B. 驗證後台操作員可實際「建商品 → 開團 → 建訂單 → 新增旅客 → 收款」

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

async function run() {
  // ── A. 種子故事:步驟 1~10 ──
  console.log('\n[A] 種子故事:王小明報名花蓮三日遊(步驟 1~10)');

  const products = (await req('GET', '/api/products')).body;
  const hua = products.find(p => p.product_code === 'HUA3D');
  check('步驟1 商品「花蓮三日遊」存在', !!hua && hua.name === '花蓮三日遊', JSON.stringify(hua));

  const tours = (await req('GET', '/api/tours')).body;
  const tour = tours.find(t => t.tour_code === 'HUA3D260701A');
  check('步驟2 團期 HUA3D260701A 存在、2026-07-01 出發', !!tour && tour.start_date === '2026-07-01', JSON.stringify(tour && tour.start_date));

  const td = (await req('GET', `/api/tours/${tour.tour_id}`)).body;
  const car = td.inventory.find(i => i.name === '車位');
  const bed = td.inventory.find(i => i.name === '床位');
  check('步驟3 庫存 車位42、床位40', car.total_qty === 42 && bed.total_qty === 40, `車${car.total_qty} 床${bed.total_qty}`);
  const adultPrice = td.prices.find(p => p.name === '大人');
  const childPrice = td.prices.find(p => p.name === '小孩佔床');
  check('步驟4 售價 大人30000、小孩28000', adultPrice.price === 30000 && childPrice.price === 28000, `大${adultPrice.price} 小${childPrice.price}`);

  const o = (await req('GET', '/api/orders/1')).body;
  check('步驟5 訂單 HUA3D260701A、客戶 王小明', o.order_no === 'HUA3D260701A' && o.customer_name === '王小明', `${o.order_no}/${o.customer_name}`);
  const adultItem = o.items.find(i => i.pt_name === '大人');
  const childItem = o.items.find(i => i.pt_name === '小孩佔床');
  check('步驟6 明細 大人2 + 小孩1,總額88000', adultItem.qty === 2 && childItem.qty === 1 && o.total === 88000, `大${adultItem.qty}小${childItem.qty} 總${o.total}`);
  const names = o.travelers.map(t => t.name);
  check('步驟7 旅客 王小明/王太太/王小華(3人,含身分證)', o.travelers.length === 3 && names.includes('王太太') && o.travelers.every(t => t.id_no), names.join('、'));
  check('步驟8 庫存已扣(車位3、床位3)', car.used_qty === 3 && bed.used_qty === 3, `車${car.used_qty} 床${bed.used_qty}`);
  check('步驟9 契約 C-HUA3D260701A 已簽', o.contract && o.contract.signed_status === '已簽' && o.contract.contract_no === 'C-HUA3D260701A', JSON.stringify(o.contract && o.contract.contract_no));
  const dep = o.payments.find(p => p.payment_type === '訂金');
  const fin = o.payments.find(p => p.payment_type === '尾款');
  check('步驟10 收款 訂金20000 + 尾款68000,已收88000', dep.amount === 20000 && fin.amount === 68000 && o.paid === 88000, `訂${dep.amount}尾${fin.amount} 已收${o.paid}`);

  // ── B. 後台操作員實際操作 ──
  console.log('\n[B] 後台操作員:建商品 → 開團 → 建訂單 → 新增旅客 → 收款');

  const np = await req('POST', '/api/products', { product_code: 'KH2D', name: '高雄二日遊', region_type: '國內', days: 2 });
  check('建立商品成功', np.status === 200 && np.body.product_id > 0, JSON.stringify(np.body));

  const nt = await req('POST', '/api/tours', {
    product_id: np.body.product_id, tour_code: 'KH2D260901A', start_date: '2026-09-01', end_date: '2026-09-02',
    min_pax: 10, signup_deadline: '2026-08-20',
    inventory: [{ resource_type_id: 1, total_qty: 20 }, { resource_type_id: 2, total_qty: 20 }],
    prices: [{ passenger_type_id: 1, price: 5000, deposit_ratio: 0.3 }, { passenger_type_id: 2, price: 4500, deposit_ratio: 0.3 }],
  });
  check('開團(含庫存+售價)成功', nt.status === 200 && nt.body.tour_id > 0, JSON.stringify(nt.body));

  const no = await req('POST', '/api/orders', {
    tour_id: nt.body.tour_id, channel: '櫃台', customer: { name: '測試客戶', phone: '0900111222' },
    items: [{ passenger_type_id: 1, qty: 2 }, { passenger_type_id: 2, qty: 1 }],
  });
  check('建立訂單成功(待付訂金)', no.status === 200 && !!no.body.order_no, JSON.stringify(no.body));

  const at = (await req('GET', `/api/admin/tours/${nt.body.tour_id}`)).body;
  const nc = at.inventory.find(i => i.name === '車位');
  check('建單後庫存自動扣(2大1小 → 車位3)', nc.used_qty === 3, `車位 used=${nc.used_qty}`);

  const tv = await req('POST', `/api/orders/${no.body.order_id}/travelers`, { passenger_type_id: 1, name: '測試大人', id_no: 'C123456789', gender: '男' });
  check('新增旅客成功', tv.status === 200 && tv.body.traveler_id > 0, JSON.stringify(tv.body));

  await req('POST', `/api/orders/${no.body.order_id}/pay`, { payment_type: '訂金', amount: 4200 });
  const od = (await req('GET', `/api/orders/${no.body.order_id}`)).body;
  check('收訂金後訂單轉「已確認」', od.status === '已確認', od.status);
  check('旅客已登記在該訂單', od.travelers.length === 1 && od.travelers[0].name === '測試大人', JSON.stringify(od.travelers.map(t => t.name)));
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
