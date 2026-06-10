// tests/seed-story.test.js — 種子故事驗證(資料庫總覽 步驟 1~10,純讀取)
//
// 執行:node tests/seed-story.test.js
//   自動啟動 server.js(子行程,乾淨 DB)→ 驗證「王小明報名花蓮三日遊」
//   這份種子資料是否完整涵蓋步驟 1~10 → 關閉伺服器。
//   全過 exit 0;任一失敗 exit 1。
//
// 只做讀取斷言;後台「寫入操作」與流程 A/B/C/D 由 flows.test.js 負責(不重複)。

const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 3000;
let pass = 0, fail = 0;

function req(method, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: 'localhost', port: PORT, path: p, method },
      res => { let s = ''; res.setEncoding('utf8'); res.on('data', c => s += c);
        res.on('end', () => resolve(s ? JSON.parse(s) : {})); });
    r.on('error', reject); r.end();
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
  console.log('\n[種子故事] 王小明報名花蓮三日遊(步驟 1~10)');

  const products = await req('GET', '/api/products');
  const hua = products.find(p => p.product_code === 'HUA3D');
  check('步驟1 商品「花蓮三日遊」存在', !!hua && hua.name === '花蓮三日遊', JSON.stringify(hua));

  const tours = await req('GET', '/api/tours');
  const tour = tours.find(t => t.tour_code === 'HUA3D260701A');
  check('步驟2 團期 HUA3D260701A、2026-07-01 出發', !!tour && tour.start_date === '2026-07-01', tour && tour.start_date);

  const td = await req('GET', `/api/tours/${tour.tour_id}`);
  const car = td.inventory.find(i => i.name === '車位');
  const bed = td.inventory.find(i => i.name === '床位');
  check('步驟3 庫存 車位42、床位40', car.total_qty === 42 && bed.total_qty === 40, `車${car.total_qty} 床${bed.total_qty}`);
  const adult = td.prices.find(p => p.name === '大人');
  const child = td.prices.find(p => p.name === '小孩佔床');
  check('步驟4 售價 大人30000、小孩28000', adult.price === 30000 && child.price === 28000, `大${adult.price} 小${child.price}`);

  const o = await req('GET', '/api/orders/1');
  check('步驟5 訂單 HUA3D260701A、客戶 王小明', o.order_no === 'HUA3D260701A' && o.customer_name === '王小明', `${o.order_no}/${o.customer_name}`);
  const ai = o.items.find(i => i.pt_name === '大人');
  const ci = o.items.find(i => i.pt_name === '小孩佔床');
  check('步驟6 明細 大人2 + 小孩1,總額88000', ai.qty === 2 && ci.qty === 1 && o.total === 88000, `大${ai.qty}小${ci.qty} 總${o.total}`);
  check('步驟7 旅客 3人、含身分證', o.travelers.length === 3 && o.travelers.map(t => t.name).includes('王太太') && o.travelers.every(t => t.id_no), o.travelers.map(t => t.name).join('、'));
  check('步驟8 庫存已扣(車位3、床位3)', car.used_qty === 3 && bed.used_qty === 3, `車${car.used_qty} 床${bed.used_qty}`);
  check('步驟9 契約 C-HUA3D260701A 已簽', o.contract && o.contract.signed_status === '已簽' && o.contract.contract_no === 'C-HUA3D260701A', o.contract && o.contract.contract_no);
  const dep = o.payments.find(p => p.payment_type === '訂金');
  const fin = o.payments.find(p => p.payment_type === '尾款');
  check('步驟10 收款 訂金20000 + 尾款68000,已收88000', dep.amount === 20000 && fin.amount === 68000 && o.paid === 88000, `訂${dep.amount}尾${fin.amount} 已收${o.paid}`);
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
