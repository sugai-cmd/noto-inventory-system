// aliases.json（表記ゆれの手動補正表）の読み込み。
//
// 人が手で書くファイルなので、実際に「行末のカンマ」と「行頭の全角スペース」で
// 読み込みに失敗した。その2つは受け付けたうえで、
// それでも読めないときは**どの行か**を示して止める。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readAliasFile, relax, collectWarnings } = require('../../scripts/lib/aliasFile');

function write(dir, content) {
  const p = path.join(dir, 'aliases.json');
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

test('行末の余分なカンマがあっても読める', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const p = write(dir, '{\n  "得意先": {\n    "a": "b",\n  },\n}\n');
  assert.deepEqual(readAliasFile(p).aliases, { 得意先: { a: 'b' } });
});

test('行頭の全角スペースがあっても読める', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const p = write(dir, '{\n　　"得意先": {\n　　　"a": "b"\n　　}\n}\n');
  assert.deepEqual(readAliasFile(p).aliases, { 得意先: { a: 'b' } });
});

test('値の中の全角スペースは残す（得意先名に入っていることがある）', () => {
  const parsed = JSON.parse(relax('{"得意先":{"強羅花壇　富士":"強羅花壇 富士"}}'));
  assert.deepEqual(parsed, { 得意先: { '強羅花壇　富士': '強羅花壇 富士' } });
});

test('BOM付きでも読める', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const p = write(dir, '﻿{"得意先":{"a":"b"}}');
  assert.deepEqual(readAliasFile(p).aliases, { 得意先: { a: 'b' } });
});

test('ファイルが無ければ空として扱う', () => {
  assert.deepEqual(readAliasFile('/tmp/存在しないファイル.json'), { aliases: {}, warnings: [] });
});

test('直せない壊れ方では、何行目の何文字目かとキャレットを示して止まる', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 3行目の引用符を閉じ忘れている
  const p = write(dir, '{\n  "得意先": {\n    "a: "b"\n  }\n}\n');
  assert.throws(
    () => readAliasFile(p),
    (e) => {
      assert.match(e.message, /3行目・\d+文字目でつまずきました/);
      assert.match(e.message, /\^/); // 該当箇所を指すキャレット
      assert.match(e.message, /引用符の閉じ忘れ/);
      return true;
    }
  );
});

test('名前を自分自身に対応づけている行を警告する（何もしないので）', () => {
  const warnings = collectWarnings({
    得意先: { カナカン: 'カナカン', のと空港セレンブティ: 'のと空港セレンディピティ' },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /「カナカン」→「カナカン」は同じ名前なので効きません/);
});

test('__ignore__ と _ で始まるキーは警告の対象にしない', () => {
  const warnings = collectWarnings({
    __ignore__: { 商品名称: ['白30ml サンプル用(旧)'] },
    _注意: ['これは案内です'],
  });
  assert.deepEqual(warnings, []);
});

test('対応表になっていない書き方を警告する', () => {
  const warnings = collectWarnings({ 得意先: 'カナカン' });
  assert.match(warnings[0], /対応表になっていません/);
});

test('貼られたそのままのファイル（先頭の全角スペース＋全角の引用符）が読める', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 実際に届いたファイルの形。
  //   1行目が「{」＋全角スペース → position 1 で落ちる
  //   値の側が全角の開き引用符「“」
  //   得意先名には全角スペースが入っている（これは残さないといけない）
  const p = write(
    dir,
    '{　\n' +
      '  "得意先名": {\n' +
      '    "強羅花壇　富士": "強羅花壇富士",\n' +
      '    "近江町松本": “株式会社松本"\n' +
      '  }\n' +
      '}\n'
  );

  const { aliases, warnings } = readAliasFile(p);
  assert.equal(aliases['得意先名']['近江町松本'], '株式会社松本');
  // 値の中の全角スペースは残す
  assert.equal(aliases['得意先名']['強羅花壇　富士'], '強羅花壇富士');

  // 直したことは黙っていない。何行目の何を直したかを言う
  const fixed = warnings.find((w) => w.includes('全角の引用符'));
  assert.ok(fixed, `全角の引用符を直した警告が出ていない: ${JSON.stringify(warnings)}`);
  assert.match(fixed, /4行目/);
});

test('全角の引用符があっても、それ以降の末尾カンマ除去が止まらない', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 「“」は開き引用符として認識されないため、文字列の内外の判定が反転する。
  // 判定より先に引用符を直しておかないと、これ以降の末尾カンマが落とせない。
  const p = write(
    dir,
    '{\n  "得意先": { "a": “b" },\n  "商品": { "c": "d", },\n}\n'
  );

  const { aliases } = readAliasFile(p);
  assert.equal(aliases['得意先']['a'], 'b');
  assert.equal(aliases['商品']['c'], 'd');
});

test('文字列の外の全角記号（｛：，）も直す', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const p = write(dir, '{\n  "得意先"： ｛ "a": "b"， "c": "d" ｝\n}\n');
  const { aliases, warnings } = readAliasFile(p);
  assert.equal(aliases['得意先']['a'], 'b');
  assert.equal(aliases['得意先']['c'], 'd');
  assert.ok(warnings.some((w) => w.includes('全角')));
});

test('全角の引用符そのものが直せない場所にあるときは、その文字を名指しで止まる', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 引用符を直しても括弧が閉じていないので読めない
  const p = write(dir, '{\n  "得意先": {\n    "a": “b"\n\n');
  assert.throws(
    () => readAliasFile(p),
    (e) => {
      assert.match(e.message, /行目・\d+文字目でつまずきました/);
      assert.match(e.message, /全角の引用符/);
      return true;
    }
  );
});
