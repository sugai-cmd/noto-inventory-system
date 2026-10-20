// COREZOフォルダの仕分け（取込済・要確認・未分類）とSlackの文面。
// 読み取りと登録は corezoOrderImport.test.js で見ているので、ここでは取込結果を差し替える。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { processInbox, buildSlackText } = require('../../src/services/corezoOrder/corezoInbox');

function makeInbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corezo-inbox-test-'));
  const inbox = path.join(dir, 'COREZO');
  const state = path.join(dir, 'state');
  fs.mkdirSync(inbox);
  return { dir, inbox, state };
}

const registered = {
  status: 'registered',
  parsed: { orderNumber: '141709', orderedOn: '2026-10-19', delivery: { name: '試験 太郎' } },
  plan: {
    customerName: '金沢楽座',
    items: [{ productName: '浄酎 ホワイト35 300ml', quantity: 1 }],
    requestedDeliveryOn: null,
  },
  order: { order_no: 'O2610-0003' },
  warnings: [],
};

const RESULTS = {
  'a.txt': registered,
  'b.txt': {
    status: 'notice',
    parsed: { orderNumber: '140773', subject: '【COREZO】注文番号140773 配送先住所変更について' },
    reasons: ['COREZOからの連絡です（【COREZO】注文番号140773 配送先住所変更について）／注文番号 140773'],
    warnings: [],
  },
  'c.txt': { status: 'not_corezo', parsed: {}, warnings: [] },
  'd.txt': {
    status: 'needs_review',
    parsed: { orderNumber: '141710' },
    reasons: ['商品コード 4999999999999 に当たる商品がありません'],
    candidates: { product: ['浄酎 ホワイト35 300ml'] },
    warnings: [],
  },
};

const fakeImport = async (filePath) => RESULTS[path.basename(filePath)];

test('届いたメールを結果ごとにフォルダへ仕分け、取込済は注文番号で名前を付け直す', async () => {
  const { inbox, state } = makeInbox();
  for (const name of Object.keys(RESULTS)) fs.writeFileSync(path.join(inbox, name), 'x');
  // 対象外の拡張子は触らない（PDFが混ざっても壊れないこと）
  fs.writeFileSync(path.join(inbox, 'z.pdf'), 'x');

  const summary = await processInbox({ inboxDir: inbox, stateDir: state, importFn: fakeImport });

  assert.equal(summary.items.length, 4);
  assert.ok(fs.existsSync(path.join(inbox, '取込済', '20261019_141709.txt')));
  // 連絡メールは「要確認」。**自動では直さない**ので人の目に入る場所に置く
  assert.ok(fs.existsSync(path.join(inbox, '要確認', 'b.txt')));
  assert.ok(fs.existsSync(path.join(inbox, '未分類', 'c.txt')));
  assert.ok(fs.existsSync(path.join(inbox, '要確認', 'd.txt')));
  assert.ok(fs.existsSync(path.join(inbox, 'z.pdf')), 'PDFはそのまま残ること');
});

test('COREZOフォルダが無いとき（ドライブ未起動など）は分かる言葉で止まる', async () => {
  await assert.rejects(
    processInbox({ inboxDir: '/nonexistent/COREZO', stateDir: '/tmp', importFn: fakeImport }),
    /COREZOフォルダが見つかりません/
  );
});

test('Slackの文面: 登録・連絡・要確認を知らせ、登録済みの再取込は知らせない', () => {
  const items = Object.entries(RESULTS).map(([name, result]) => ({
    name, status: result.status, result,
  }));
  items.push({ name: 'e.txt', status: 'duplicate', result: { status: 'duplicate', parsed: {}, reasons: ['登録済み'], warnings: [] } });

  const text = buildSlackText({ items, deleted: [] });
  assert.match(text, /受注 O2610-0003 を登録しました/);
  assert.match(text, /金沢楽座/);
  assert.match(text, /配送先住所変更/);
  assert.match(text, /自動では直していません/);
  assert.match(text, /要確認（登録していません）: d\.txt（注文番号 141710）/);
  assert.match(text, /未分類/);
  assert.doesNotMatch(text, /登録済み/, '取込済みの再取込は知らせない');
});

test('知らせることが無ければ Slack には送らない', () => {
  assert.equal(buildSlackText({ items: [], deleted: [] }), null);
});
