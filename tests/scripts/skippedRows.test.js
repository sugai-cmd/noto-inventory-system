// 取り込まずに飛ばした行を、理由つきで残すこと。
//
// 実運用で「顧客リスト: 読込169 / 投入121 / スキップ47」と出たが、
// 47件のうちレポートから追えるのは名寄せ不一致の分だけだった。
// 得意先名が空欄の行は summary.skipped++ するだけで何も記録しておらず、
// 「どの47行か」を調べる手立てが無かった。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const CUSTOMER_HEADER =
  '顧客ID,得意先名,区分,業態,掛率,住所,支払いサイト月数,支払いサイト日付,' +
  '請求日送付期日,備考,担当者,サブ担当者,流通経路,最終訪問日,取引開始月';
const LIST_HEADER = 'No.,得意先,業態,担当者,郵便番号,住所,電話番号,次回todo/課題,最新訪問日';

function useCsv(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const csvDir = path.join(dir, 'csv');
  const reportDir = path.join(dir, 'report');
  fs.mkdirSync(csvDir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(csvDir, name), content, 'utf8');
  }
  return {
    dbPath: path.join(dir, 'skip.sqlite'),
    reportDir,
    env: {
      MIGRATION_CSV_DIR: csvDir,
      MIGRATION_REPORT_DIR: reportDir,
      MIGRATION_ALIASES: path.join(dir, 'aliases.json'),
    },
  };
}

function run(ctx) {
  return execFileSync(
    'node',
    [path.join(ROOT, 'scripts', 'migrate-from-sheets.js'), '--allow-partial'],
    { cwd: ROOT, env: { ...process.env, ...ctx.env, DB_PATH: ctx.dbPath }, encoding: 'utf8' }
  );
}

function report(ctx, name) {
  return fs.readFileSync(path.join(ctx.reportDir, name), 'utf8');
}

/** 見出しを除いたデータ行 */
function rowsOf(csv) {
  return csv.trim().split('\n').slice(1).filter(Boolean);
}

test('得意先名が空欄の行を、理由つきで残す', (t) => {
  const ctx = useCsv(t, {
    'customers.csv': `${CUSTOMER_HEADER}\nC0008,カナカン酒類石川,卸売業者,卸問屋,0.7,金沢市,翌月,末日,,,,,,,\n`,
    'customer_list.csv':
      `${LIST_HEADER}\n` +
      '1,カナカン酒類石川,卸問屋,山本,9200000,金沢市,076-000-0000,,\n' +
      '2,,,,,,,,\n' +          // シートの余白行
      '3,   ,,,,,,,\n',        // 空白だけの行
  });
  const out = run(ctx);

  assert.match(out, /顧客リスト: 読込3 \/ 投入1 .*スキップ2/);

  const skipped = rowsOf(report(ctx, 'skipped-rows.csv'));
  assert.equal(skipped.length, 2);
  for (const line of skipped) {
    assert.match(line, /顧客リスト/);
    assert.match(line, /得意先名が空欄です/);
  }
  // シートで探せるよう行番号が入る（ヘッダを1行目とした番号）
  assert.match(skipped[0], /^顧客リスト,3,/);
  assert.match(skipped[1], /^顧客リスト,4,/);
});

test('得意先マスタに無い名前も、名前つきで残す', (t) => {
  const ctx = useCsv(t, {
    'customers.csv': `${CUSTOMER_HEADER}\nC0008,カナカン酒類石川,卸売業者,卸問屋,0.7,金沢市,翌月,末日,,,,,,,\n`,
    'customer_list.csv':
      `${LIST_HEADER}\n` +
      '1,カナカン酒類石川,卸問屋,山本,9200000,金沢市,076-000-0000,,\n' +
      '2,まだ登録していない酒販店,小売,田中,9200001,金沢市,076-000-0001,,\n',
  });
  run(ctx);

  const skipped = report(ctx, 'skipped-rows.csv');
  assert.match(skipped, /得意先マスタに無い名前です/);
  // 行番号だけでなく、探せる名前を添える
  assert.match(skipped, /まだ登録していない酒販店/);
});

test('飛ばした行は errors.csv には出さない（エラーと意図した除外を混ぜない）', (t) => {
  const ctx = useCsv(t, {
    'customers.csv': `${CUSTOMER_HEADER}\nC0008,カナカン酒類石川,卸売業者,卸問屋,0.7,金沢市,翌月,末日,,,,,,,\n`,
    'customer_list.csv': `${LIST_HEADER}\n1,,,,,,,,\n`,
  });
  run(ctx);

  assert.match(report(ctx, 'skipped-rows.csv'), /得意先名が空欄です/);
  assert.equal(rowsOf(report(ctx, 'errors.csv')).length, 0);
});

test('飛ばす行が無ければ、skipped-rows.csv は見出しだけ', (t) => {
  const ctx = useCsv(t, {
    'customers.csv': `${CUSTOMER_HEADER}\nC0008,カナカン酒類石川,卸売業者,卸問屋,0.7,金沢市,翌月,末日,,,,,,,\n`,
  });
  const out = run(ctx);

  assert.equal(rowsOf(report(ctx, 'skipped-rows.csv')).length, 0);
  assert.doesNotMatch(out, /取り込まなかった行/);
});
