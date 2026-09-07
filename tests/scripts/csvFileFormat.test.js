// CSVのつもりで置かれた、CSVではないファイルを止めること。
//
// csv-parse はリッチテキストでもエラーを出さない。見出しが「{\rtf1...」の
// 1列だけの表として読めてしまうので、以降の項目が全部 undefined になり、
// 「得意先名が空です」が何百件も並ぶだけで原因にたどり着けない。
// 黙って通るぶん、aliases.json より危ない。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const iconv = require('iconv-lite');

const { readCsv } = require('../../scripts/lib/csvReader');

const SHEET_CSV = '顧客ID,得意先名,掛率\nC0080,松本,0.7\n';

function place(t, name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csvfmt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  return p;
}

test('リッチテキストのCSVは、ファイル名を添えて止まる', (t) => {
  // テキストエディットが書き出す形。以前はこれが1列の表として読めてしまっていた
  const rtf =
    '{\\rtf1\\ansi\\ansicpg932\\cocoartf2870\n' +
    '{\\fonttbl\\f0\\fnil Helvetica;}\n' +
    '\\f0\\fs24 \\cf0 顧客ID,得意先名\\\nC0080,松本}';
  const p = place(t, 'customers.csv', rtf);

  assert.throws(
    () => readCsv(p),
    (e) => {
      assert.match(e.message, /リッチテキスト書類（RTF）/);
      // どのファイルかを言う（21シートあるので、名前が無いと直せない）
      assert.match(e.message, /customers\.csv/);
      assert.match(e.message, /標準テキストにする/);
      return true;
    }
  );
});

test('Excelの書類をCSVとして置いたときは、書き出し方を案内する', (t) => {
  const p = place(t, 'products.csv', Buffer.from('504b0304140006000800', 'hex'));

  assert.throws(
    () => readCsv(p),
    (e) => {
      assert.match(e.message, /Excel・Wordなどの書類/);
      assert.match(e.message, /products\.csv/);
      assert.match(e.message, /カンマ区切り形式/);
      return true;
    }
  );
});

test('普通のCSVはこれまで通り読める（誤検知しない）', (t) => {
  const rows = readCsv(place(t, 'customers.csv', SHEET_CSV));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['得意先名'], '松本');
});

test('BOM付きUTF-8・Shift_JIS の判定は変わらない', (t) => {
  const bom = readCsv(place(t, 'a.csv', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SHEET_CSV)])));
  assert.equal(bom[0]['得意先名'], '松本');

  const sjis = readCsv(place(t, 'b.csv', iconv.encode(SHEET_CSV, 'Shift_JIS')));
  assert.equal(sjis[0]['得意先名'], '松本');
});

test('ファイルが無ければ null のまま（飛ばせるようにしてある）', () => {
  assert.equal(readCsv('/tmp/存在しないファイル.csv'), null);
});
