// 移行スクリプトの読み取り部分を検証する。
//
// 実データを通して見つかった「このまま流すと数字が壊れる」箇所を、
// 小さな入力で再現できる形にして残す。

const test = require('node:test');
const assert = require('node:assert/strict');
const iconv = require('iconv-lite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseNumber, parseInteger, parseAbsNumber, parseNumberLoose } = require('../../scripts/lib/parseNumber');
const { renumber, dedupeCode } = require('../../scripts/lib/legacyCode');
const { aliasesForSheet, aliasRow } = require('../../scripts/lib/columnAliases');
const { parseDateOnly, parseMonthOnly, parseDateTimeParts } = require('../../scripts/lib/parseDate');
const { readCsv } = require('../../scripts/lib/csvReader');

// --- 数値の読み取り ---------------------------------------------------------

test('桁区切りのカンマが入った数量を読める（素のNumberではNaNになる）', () => {
  assert.equal(Number('1,000'), Number.NaN || Number('1,000')); // 素のNumberはNaN
  assert.ok(Number.isNaN(Number('1,000')));

  assert.equal(parseNumber('1,000', '数量'), 1000);
  assert.equal(parseNumber('31,680', '売価'), 31680);
  assert.equal(parseInteger('1,000', '本数'), 1000);
});

test('パーセント付きの度数と全角数字を読める', () => {
  assert.equal(parseNumber('36.55%', 'アルコール度数'), 36.55);
  assert.equal(parseNumber('１２３', '数量'), 123);
  assert.equal(parseNumber('¥1,200', '単価'), 1200);
  assert.equal(parseNumber('20L', '投入量'), 20);
});

test('空欄と「-」はnull、読めない値は例外にする（黙って0にしない）', () => {
  assert.equal(parseNumber('', '数量'), null);
  assert.equal(parseNumber('-', '数量'), null);
  assert.equal(parseNumber(null, '数量'), null);
  assert.throws(() => parseNumber('あいう', '度数'), /度数を数値として読み取れませんでした/);
  assert.throws(() => parseNumber('', '数量', { required: true }), /数量が空です/);
});

test('向きを符号で表しているシートの数量は、大きさだけを取る', () => {
  // 浄酎容器変動履歴の瓶詰め・容器移動は -19.9 のように負で入っている。
  // こちらは受入元/払出先の列で向きを表すので、符号をそのまま入れると逆算されて逆向きになる。
  assert.equal(parseAbsNumber('-19.9', '数量(L)'), 19.9);
  assert.equal(parseAbsNumber('15.0', '数量(L)'), 15);
});

test('数量のうしろに注記が付いたマスタのセルを、行ごと落とさずに救う', () => {
  // 実データの資材マスタに「500（3000）」というロット数があり、
  // これで行が落ちると、その資材を使うレシピまで芋づるで落ちていた。
  assert.deepEqual(parseNumberLoose('500（3000）', 'ロット数'), { value: 500, salvaged: '500（3000）' });
  assert.deepEqual(parseNumberLoose('500', 'ロット数'), { value: 500, salvaged: null });
  assert.deepEqual(parseNumberLoose('', 'ロット数'), { value: null, salvaged: null });
});

// --- 伝票番号 ---------------------------------------------------------------

test('過去の受注番号をOへ、原酒受払IDをRへ振り直す', () => {
  // 実データでは受注番号と蒸留IDが37件、原酒受払IDと資材履歴IDが73件、完全に一致していた
  assert.equal(renumber('D2605-0001', 'O'), 'O2605-0001');
  assert.equal(renumber('D2605-1001', 'O'), 'O2605-1001');
  assert.equal(renumber('M2603-0001', 'R'), 'R2603-0001');
});

test('形が違う番号は作り変えない', () => {
  assert.equal(renumber('C2606-0001', 'C'), 'C2606-0001');
  assert.equal(renumber('へんな値', 'O'), 'へんな値');
  assert.equal(renumber('', 'O'), '');
});

test('重複した履歴IDは枝番を付けて、行を落とさない', () => {
  // 実データには同じ資材履歴ID・商品履歴IDの行があり、
  // UNIQUE制約で2件目が落ちると在庫の動きが1件消えてしまう
  const counters = {};
  assert.deepEqual(dedupeCode(counters, 'material', 'M2607-0013'), { code: 'M2607-0013', duplicated: false });
  assert.deepEqual(dedupeCode(counters, 'material', 'M2607-0013'), { code: 'M2607-0013-2', duplicated: true });
  assert.deepEqual(dedupeCode(counters, 'material', 'M2607-0013'), { code: 'M2607-0013-3', duplicated: true });
  // 系統が違えば別勘定
  assert.deepEqual(dedupeCode(counters, 'product', 'M2607-0013'), { code: 'M2607-0013', duplicated: false });
  assert.deepEqual(dedupeCode(counters, 'material', null), { code: null, duplicated: false });
});

// --- 見出しの表記ゆれ -------------------------------------------------------

test('シート側の列名でも読める（資材マスタは「資材名」、台帳は「資材名称」）', () => {
  const row = aliasRow({ 資材名称: '300mlガラス瓶' }, aliasesForSheet('資材在庫変動履歴'));
  assert.equal(row['資材名称'], '300mlガラス瓶');
  assert.equal(row['資材名'], '300mlガラス瓶');

  const master = aliasRow({ 資材名: '300mlガラス瓶', 単価: '281' }, aliasesForSheet('資材マスタ'));
  assert.equal(master['資材名称'], '300mlガラス瓶');
  assert.equal(master['単価(円)'], '281');
});

test('見出しの全角半角・空白の違いを吸収する', () => {
  const row = aliasRow({ '受入元／払出先': '酒井硝子' }, aliasesForSheet('資材在庫変動履歴'));
  assert.equal(row['受入元/払出先'], '酒井硝子');
});

test('無い列はundefinedを返す（例外にしない）', () => {
  const row = aliasRow({ 資材名: 'x' }, aliasesForSheet('資材マスタ'));
  assert.equal(row['存在しない列'], undefined);
});

// --- 日付・月 ---------------------------------------------------------------

test('「26年7月」のような対象月を読める（委託販売実績報告の書き方）', () => {
  assert.equal(parseMonthOnly('26年7月'), '2026-07');
  assert.equal(parseMonthOnly('2026年7月'), '2026-07');
  assert.equal(parseMonthOnly('2026/07'), '2026-07');
});

test('日付欄の「-」は空欄として扱う', () => {
  assert.equal(parseDateOnly('-'), null);
  assert.equal(parseDateOnly('未定'), null);
  assert.equal(parseDateOnly('2026/06/17'), '2026-06-17');
});

test('時刻が無い日付は、日付だけが取れて時刻はnullになる', () => {
  // 蒸留記録・残渣回収記録の日付は日付だけ。時刻が無いことを理由に行を落とさない
  assert.deepEqual(parseDateTimeParts('2026/06/17'), { date: '2026-06-17', time: null });
  assert.deepEqual(parseDateTimeParts('2026/08/18 8:05:04'), { date: '2026-08-18', time: '08:05' });
});

// --- CSVの読み込み ----------------------------------------------------------

test('Shift_JISとタブ区切りのCSVを読める', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const sjis = path.join(dir, 'sjis.csv');
  fs.writeFileSync(sjis, iconv.encode('資材名,数量\n300mlガラス瓶,1000\n', 'Shift_JIS'));
  assert.deepEqual(readCsv(sjis), [{ 資材名: '300mlガラス瓶', 数量: '1000' }]);

  const tsv = path.join(dir, 'tab.csv');
  fs.writeFileSync(tsv, '資材名\t数量\n300mlガラス瓶\t1000\n', 'utf8');
  assert.deepEqual(readCsv(tsv), [{ 資材名: '300mlガラス瓶', 数量: '1000' }]);

  assert.equal(readCsv(path.join(dir, 'ない.csv')), null);
});

// --- 通しで確認する ---------------------------------------------------------
//
// 符号の扱いは台帳の1行だけ見ても分からないので、実際に投入して
// タンクの残量がどちらへ動くかまで確かめる。

const { execFileSync } = require('node:child_process');

// 実データの置き場（scripts/data/csv・aliases.json）には触らない。
// 以前ここで本物のCSVを退避してから戻していたが、
//   ・途中で落ちると利用者のCSVが戻らない
//   ・手元の aliases.json の書き間違いで、関係のないこの試験が落ちる
// （実際に「aliases.json の10行目でつまずきました」で落ちた）
// 環境変数で置き場を差し替えて、この試験専用のフォルダだけを使う。
test('浄酎容器変動履歴を通すと、移動元が減って移動先が増える', (t) => {
  const root = path.resolve(__dirname, '..', '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const csvDir = path.join(dir, 'csv');
  fs.mkdirSync(csvDir);
  const dbPath = path.join(dir, 'e2e.sqlite');

  fs.writeFileSync(
    path.join(csvDir, 'tanks.csv'),
    '容器ID,容器名称,容器種別,最大容量(L),現在設置場所,ステータス,検尺定数,初期在庫量,現在液量(L),理論アルコール度数,備考\n' +
      'T-001,ステンレスタンク1,ステンレスタンク,1000,浄溜所,稼働中,,100,100,35,\n' +
      'T-004,一斗瓶2,斗瓶,19.9,浄溜所,空,,0,0,,\n',
    'utf8'
  );
  // シートと同じく、容器移動の数量は負で書かれている
  fs.writeFileSync(
    path.join(csvDir, 'tank_ledger.csv'),
    '日付,受入元,受払,瓶詰め商品,払出先,数量(L),アルコール度数,商品履歴ID,蒸留ID,データ区分,備考\n' +
      '2026/06/12,ステンレスタンク1,容器移動,,一斗瓶2,-19.9,35%,,,運用中（リアルタイム）,\n',
    'utf8'
  );

  execFileSync('node', [path.join(root, 'scripts', 'migrate-from-sheets.js'), '--allow-partial'], {
    cwd: root,
    env: {
      ...process.env,
      DB_PATH: dbPath,
      MIGRATION_CSV_DIR: csvDir,
      MIGRATION_REPORT_DIR: path.join(dir, 'report'),
      MIGRATION_ALIASES: path.join(dir, 'aliases.json'), // 置かない＝補正表なし
    },
    stdio: 'pipe',
  });

  const db = require('better-sqlite3')(dbPath);
  const volumes = new Map(
    db.prepare('SELECT name, current_volume_l FROM v_tank_monitor').all().map((r) => [r.name, r.current_volume_l])
  );

  // 100L から 19.9L 出て、一斗瓶へ 19.9L 入る
  assert.equal(volumes.get('ステンレスタンク1'), 80.1);
  assert.equal(volumes.get('一斗瓶2'), 19.9);

  // 台帳には正の数で入り、向きは受入元/払出先で表されている
  const row = db.prepare('SELECT * FROM tank_ledger').get();
  assert.equal(row.quantity_l, 19.9);
  assert.ok(row.from_tank_id != null && row.to_tank_id != null);
  db.close();
});
