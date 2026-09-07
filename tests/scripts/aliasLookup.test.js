// aliases.json の対応表が、書き写しのぶれを越えて引けること。
//
// キーは unmatched-names.csv の rawValue をそのまま貼る前提だが、
// 手で書き写すと幅（全角/半角）や前後の空白がずれる。
// そこだけのために「書いたのに効かない」となるのは分かりにくいので、
// 正規化したキーでも引けるようにしてある。

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveId } = require('../../scripts/lib/loadHelper');
const { normalizeName } = require('../../src/utils/normalizeName');

function makeCtx(aliases, names) {
  const idMap = new Map(names.map((n, i) => [normalizeName(n), i + 1]));
  return {
    aliases,
    normalize: normalizeName,
    report: { unmatched: [], recordUnmatched(...a) { this.unmatched.push(a); } },
    idMap,
  };
}

function resolve(ctx, rawValue) {
  return resolveId(ctx, {
    sheet: '顧客リスト', column: '得意先', rawValue, idMap: ctx.idMap,
  });
}

test('キーがCSVの値と完全に一致すれば引ける', () => {
  const ctx = makeCtx(
    { 得意先: { 'のと空港セレンブティ': 'のと空港セレンディピティ' } },
    ['のと空港セレンディピティ']
  );
  assert.equal(resolve(ctx, 'のと空港セレンブティ'), 1);
  assert.equal(ctx.report.unmatched.length, 0);
});

test('キーの全角・半角や前後の空白がずれていても引ける', () => {
  const ctx = makeCtx(
    // 「ＱＢ００９」と全角で書き写し、うしろに空白も付いてしまった場合
    { 得意先: { 'ＱＢ００９ ': 'テナー9' } },
    ['テナー9']
  );
  assert.equal(resolve(ctx, 'QB009'), 1);
  assert.equal(ctx.report.unmatched.length, 0);
});

test('右辺がマスタに無い名前なら、不一致として報告される', () => {
  const ctx = makeCtx(
    { 得意先: { 'カナカン': 'カナカン株式会社' } },
    ['カナカン酒類石川']
  );
  assert.equal(resolve(ctx, 'カナカン'), null);
  assert.equal(ctx.report.unmatched.length, 1);
  // 生値はそのまま残す（レポートからCSVを探せるように）
  assert.equal(ctx.report.unmatched[0][2], 'カナカン');
});

test('対応表に無い値は、これまで通り正規化だけで引く', () => {
  const ctx = makeCtx({}, ['地域未来創造（コレゾCOREZO）']);
  assert.equal(resolve(ctx, '地域未来創造(コレゾCOREZO)'), 1);
});

// --- aliases.json に書いた内容が実際に効くかの検証 ---------------------------
//
// 「書いたのに効かない」が繰り返し起きているので、
// 移行スクリプトを実際に走らせて、警告が出ることを確かめる。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * この試験だけのCSV置き場・補正表・レポート出力先を用意して移行を走らせ、
 * 標準出力と標準エラーをまとめて返す（警告は console.warn に出る）。
 * リポジトリの scripts/data を書き換えると、並行して走る他の試験と取り合いになる。
 */
function runMigrate(t, { csv, aliases }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const csvDir = path.join(dir, 'csv');
  fs.mkdirSync(csvDir);
  for (const [name, content] of Object.entries(csv)) {
    fs.writeFileSync(path.join(csvDir, name), content, 'utf8');
  }
  const aliasPath = path.join(dir, 'aliases.json');
  fs.writeFileSync(aliasPath, JSON.stringify(aliases, null, 2), 'utf8');

  const r = spawnSync(
    'node',
    [path.join(ROOT, 'scripts', 'migrate-from-sheets.js'), '--dry-run', '--allow-partial'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        DB_PATH: path.join(dir, 'al.sqlite'),
        MIGRATION_CSV_DIR: csvDir,
        MIGRATION_ALIASES: aliasPath,
        MIGRATION_REPORT_DIR: path.join(dir, 'report'),
      },
    }
  );
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

const CUSTOMER_HEADER =
  '顧客ID,得意先名,区分,業態,掛率,住所,支払いサイト月数,支払いサイト日付,' +
  '請求日送付期日,備考,担当者,サブ担当者,流通経路,最終訪問日,取引開始月';
const CUSTOMER_CSV = `${CUSTOMER_HEADER}\nC0080,松本,小売,酒販店,0.7,金沢市,翌月,末日,,,,,,,\n`;

test('右辺がマスタに無い名前なら、候補を添えて警告する', (t) => {
  const out = runMigrate(t, {
    csv: { 'customers.csv': CUSTOMER_CSV },
    // マスタにあるのは「松本」で、「株式会社松本」という行は無い
    aliases: { 得意先名: { 近江町松本: '株式会社松本' } },
  });

  assert.match(out, /右辺がマスタに登録されていないので効きません/);
  assert.match(out, /似ている名前: .*松本/);
});

test('外側のキーがどの列にも当たらなければ警告する', (t) => {
  const out = runMigrate(t, {
    csv: { 'customers.csv': CUSTOMER_CSV },
    aliases: { 得意先マスタ名: { a: 'b' } }, // 正しくは「得意先名」
  });

  assert.match(out, /「得意先マスタ名」はどの列にも当たらない/);
  assert.match(out, /使える列: .*得意先名/);
});

test('右辺が正しければ何も言わない', (t) => {
  const out = runMigrate(t, {
    csv: { 'customers.csv': CUSTOMER_CSV },
    aliases: { 得意先名: { 近江町松本: '松本' } },
  });

  assert.doesNotMatch(out, /効きません/);
  assert.doesNotMatch(out, /どの列にも当たらない/);
});

test('__ignore__ に書いた値がマスタにあるなら、その行は不要だと言う', (t) => {
  const out = runMigrate(t, {
    csv: { 'customers.csv': CUSTOMER_CSV },
    aliases: { __ignore__: { 得意先名: ['松本'] } },
  });

  assert.match(out, /マスタに登録されているので、飛ばす必要がありません/);
});
