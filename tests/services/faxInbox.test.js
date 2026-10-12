// FAXフォルダの仕分け（取込済・要確認・未分類・不要の掃除）とSlackの文面。
// OCRと登録は faxOrderImport.test.js で見ているので、ここでは取込結果を差し替えて試す。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { processInbox, buildSlackText } = require('../../src/services/faxOrder/faxInbox');
const { notifySlack } = require('../../src/services/faxOrder/slackNotify');

function makeInbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fax-inbox-test-'));
  const inbox = path.join(dir, 'FAX');
  const state = path.join(dir, 'state');
  fs.mkdirSync(inbox);
  return { dir, inbox, state };
}

const registered = (orderNumber) => ({
  status: 'registered',
  parsed: { orderNumber, orderedOn: '2026-10-10', warehouse: 'カナカン酒類石川' },
  plan: {
    customerName: 'カナカン酒類石川',
    productName: 'JOCHU ホワイト35 300ml',
    quantity: 24,
    requestedDeliveryOn: '2026-10-15',
  },
  order: { order_no: 'O2610-0001' },
  warnings: [],
});

const RESULTS = {
  'a.pdf': registered('73068150'),
  'b.pdf': { status: 'duplicate', parsed: registered('73068150').parsed, reasons: ['登録済み'], warnings: [] },
  'c.pdf': { status: 'not_kanakan', parsed: {}, warnings: [] },
  'd.pdf': {
    status: 'needs_review',
    parsed: { orderNumber: '73068152' },
    reasons: ['得意先を決められませんでした'],
    candidates: { customer: ['カナカン酒類石川'] },
    warnings: [],
  },
};

const fakeImport = async (pdfPath) => {
  const name = path.basename(pdfPath);
  if (name === 'e.pdf') throw new Error('PDFが壊れています');
  return RESULTS[name];
};

test('届いたPDFを結果ごとにフォルダへ仕分け、取込済は名前を変える', async () => {
  const { inbox, state } = makeInbox();
  for (const f of ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf', 'memo.txt']) {
    fs.writeFileSync(path.join(inbox, f), f);
  }

  const { items } = await processInbox({ inboxDir: inbox, stateDir: state, importFn: fakeImport });
  assert.equal(items.length, 5); // PDF以外は触らない

  const ls = (sub) => fs.readdirSync(path.join(inbox, sub)).sort();
  // 同じ発注番号は上書きせずに _2 を付ける
  assert.deepEqual(ls('取込済'), [
    '20261010_カナカン酒類石川_73068150.pdf',
    '20261010_カナカン酒類石川_73068150_2.pdf',
  ]);
  assert.deepEqual(ls('未分類'), ['c.pdf']);
  assert.deepEqual(ls('要確認'), ['d.pdf', 'e.pdf']);
  assert.deepEqual(fs.readdirSync(inbox).filter((f) => f.endsWith('.pdf')), []);
  assert.ok(fs.existsSync(path.join(inbox, 'memo.txt')));
});

test('dry-runは何も動かさない', async () => {
  const { inbox, state } = makeInbox();
  fs.writeFileSync(path.join(inbox, 'a.pdf'), 'a');
  const { items } = await processInbox({
    inboxDir: inbox, stateDir: state, importFn: fakeImport, dryRun: true,
  });
  assert.equal(items[0].folder, '取込済');
  assert.ok(fs.existsSync(path.join(inbox, 'a.pdf')));
  assert.ok(!fs.existsSync(path.join(inbox, '取込済')));
});

test('「不要」に置かれたファイルは、初めて見つけた日から30日たったら消す', async () => {
  const { inbox, state } = makeInbox();
  fs.mkdirSync(path.join(inbox, '不要'));
  fs.writeFileSync(path.join(inbox, '不要', 'old.pdf'), 'x');
  const run = (now) => processInbox({ inboxDir: inbox, stateDir: state, importFn: fakeImport, now });

  const day0 = new Date('2026-10-12T10:00:00Z');
  assert.deepEqual((await run(day0)).deleted, []);

  // 途中で別のファイルが置かれても、そちらは別に数える
  fs.writeFileSync(path.join(inbox, '不要', 'new.pdf'), 'x');
  const day29 = new Date(day0.getTime() + 29 * 86400000);
  assert.deepEqual((await run(day29)).deleted, []);

  const day30 = new Date(day0.getTime() + 30 * 86400000);
  assert.deepEqual((await run(day30)).deleted, ['old.pdf']);
  assert.deepEqual(fs.readdirSync(path.join(inbox, '不要')), ['new.pdf']);
});

test('FAXフォルダが無いとき（ドライブ未起動など）は分かる言葉で止まる', async () => {
  await assert.rejects(
    processInbox({ inboxDir: '/nonexistent/FAX', stateDir: '/tmp', importFn: fakeImport }),
    /FAXフォルダが見つかりません/
  );
});

test('Slackの文面: 登録・要確認・未分類を知らせ、登録済みの再取込は知らせない', () => {
  const items = Object.entries(RESULTS).map(([name, result]) => ({
    name, status: result.status, result,
  }));
  const text = buildSlackText({ items, deleted: [] });
  assert.match(text, /受注 O2610-0001 を登録しました/);
  assert.match(text, /要確認.*d\.pdf/);
  assert.match(text, /候補（得意先）: カナカン酒類石川/);
  assert.match(text, /未分類.*c\.pdf/);
  assert.doesNotMatch(text, /b\.pdf/);
  assert.equal(buildSlackText({ items: [items[1]], deleted: [] }), null);
});

test('Slack: ボットのトークンがあればDM（chat.postMessage）で送る', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const r = await notifySlack('テスト', { SLACK_BOT_TOKEN: 'xoxb-1', SLACK_CHANNEL: 'U123' }, fakeFetch);
  assert.equal(r.via, 'bot');
  assert.equal(calls[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(JSON.parse(calls[0].init.body).channel, 'U123');

  const none = await notifySlack('テスト', {}, fakeFetch);
  assert.equal(none.reason, 'not_configured');
});
