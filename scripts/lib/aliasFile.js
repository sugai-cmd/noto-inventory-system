// aliases.json（表記ゆれの手動補正表）の読み込み。
//
// このファイルは人が手で書くので、JSONとしては崩れやすい。
// 実際に「行末のカンマ」と「行頭の全角スペース」でつまずいた。
// データではなく設定ファイルなので、その2つは受け付けたうえで、
// それでも読めないときは**どの行か**を示して止める。

const fs = require('node:fs');

/**
 * 手で書きがちな崩れを直してからJSONにする。
 * ここで直すのは「明らかに書き間違い」と分かるものだけで、
 * 値の中身（文字列の中のカンマや全角スペース）には触らない。
 */
function relax(text) {
  let out = text.replace(/^﻿/, ''); // BOM

  // 文字列の外にある全角スペースだけを半角に直す。
  // 得意先名に全角スペースが入っていることがあるので（「強羅花壇　富士」）、
  // 引用符の中は必ず残す。
  let inString = false;
  let escaped = false;
  let result = '';
  for (const ch of out) {
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    result += !inString && ch === '　' ? ' ' : ch;
  }
  out = result;

  // 閉じ括弧の直前のカンマを落とす（文字列の外だけ）
  out = removeTrailingCommas(out);
  return out;
}

function removeTrailingCommas(text) {
  let inString = false;
  let escaped = false;
  const chars = [...text];
  const keep = new Array(chars.length).fill(true);

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString || ch !== ',') continue;

    // 次に来る意味のある文字が } か ] なら、このカンマは余分
    let j = i + 1;
    while (j < chars.length && /\s/.test(chars[j])) j++;
    if (chars[j] === '}' || chars[j] === ']') keep[i] = false;
  }
  return chars.filter((_, i) => keep[i]).join('');
}

/** JSONのエラーメッセージにある position から、行番号と該当行を割り出す */
function locate(text, message) {
  const m = /position (\d+)/.exec(message ?? '');
  if (!m) return null;
  const pos = Number(m[1]);
  const before = text.slice(0, pos);
  const line = before.split('\n').length;
  const lines = text.split('\n');
  return { line, text: lines[line - 1] ?? '' };
}

/**
 * 読み込む。読めなければ、どの行でつまずいたかを添えて例外にする。
 * @returns {{aliases: object, warnings: string[]}}
 */
function readAliasFile(filePath) {
  if (!fs.existsSync(filePath)) return { aliases: {}, warnings: [] };

  const raw = fs.readFileSync(filePath, 'utf8');
  let aliases;
  try {
    aliases = JSON.parse(relax(raw));
  } catch (e) {
    const at = locate(raw, e.message);
    const where = at
      ? `${at.line}行目でつまずきました:\n    ${at.text.trim()}`
      : `読み取れませんでした（${e.message}）`;
    throw new Error(
      `${filePath} の${where}\n` +
        '  よくある原因: 引用符の閉じ忘れ／括弧の対応／全角の引用符（”）\n' +
        '  （行末の余分なカンマと全角スペースは自動で直すので、原因ではありません）'
    );
  }

  return { aliases, warnings: collectWarnings(aliases) };
}

/**
 * 書いても効かない内容を拾う。
 * 「名前を自分自身に対応づける」書き方が実際に多く書かれていたので、
 * 黙って無視せず教える。
 */
function collectWarnings(aliases) {
  const warnings = [];
  for (const [column, table] of Object.entries(aliases)) {
    if (column === '__ignore__' || column.startsWith('_')) continue;
    if (typeof table !== 'object' || table === null || Array.isArray(table)) {
      warnings.push(`「${column}」の中身が対応表になっていません（{"シートの値": "マスタの名前"} の形で書きます）`);
      continue;
    }
    for (const [from, to] of Object.entries(table)) {
      if (from === to) {
        warnings.push(
          `「${column}」の「${from}」→「${to}」は同じ名前なので効きません。` +
            '右辺にはマスタに登録されている名前を書いてください'
        );
      } else if (typeof to !== 'string') {
        warnings.push(`「${column}」の「${from}」の右辺が文字列ではありません`);
      }
    }
  }
  return warnings;
}

module.exports = { readAliasFile, relax, collectWarnings };
