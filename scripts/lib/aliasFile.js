// aliases.json（表記ゆれの手動補正表）の読み込み。
//
// このファイルは人が手で書くので、JSONとしては崩れやすい。
// 実際に「行末のカンマ」「行頭の全角スペース」「全角の引用符」でつまずいた。
// データではなく設定ファイルなので、直せると分かる崩れは受け付けたうえで、
// それでも読めないときは**どの行・どの文字か**を示して止める。
//
// 直し方は3段階にしてある。上の段で読めたらそこで止める。
//   1段目 … BOM／文字列の外の全角スペース／末尾カンマ
//   2段目 … 全角の引用符（“”‘’）を半角の " にする
//   3段目 … 文字列の外の全角の記号（｛｝［］：，；）を半角にする
// 2段目・3段目は「1段目で読めなかった＝すでに壊れている」ときだけ動かす。
// 値の中身を書き換えてしまう可能性があるので、直したときは必ず警告に出す。

const fs = require('node:fs');
const { detectNotPlainText, notPlainTextMessage } = require('../../src/utils/fileFormat');

/** JSONの構文には現れないはずの文字。名前で呼べるようにしておく */
const SUSPICIOUS = new Map([
  ['“', '全角の引用符（“ U+201C）'],
  ['”', '全角の引用符（” U+201D）'],
  ['‘', '全角の引用符（‘ U+2018）'],
  ['’', '全角の引用符（’ U+2019）'],
  ['　', '全角スペース（U+3000）'],
  ['｛', '全角の波括弧（｛ U+FF5B）'],
  ['｝', '全角の波括弧（｝ U+FF5D）'],
  ['［', '全角の角括弧（［ U+FF3B）'],
  ['］', '全角の角括弧（］ U+FF3D）'],
  ['：', '全角のコロン（： U+FF1A）'],
  ['，', '全角のカンマ（， U+FF0C）'],
  ['；', '全角のセミコロン（； U+FF1B）'],
]);

/** 全角の引用符 → 半角の " 。文字列判定より先に当てる（下のコメント参照） */
const SMART_QUOTES = new Map([
  ['“', '"'],
  ['”', '"'],
  ['‘', '"'],
  ['’', '"'],
]);

/** 文字列の外にあれば半角にしてよい記号 */
const FULLWIDTH_PUNCT = new Map([
  ['｛', '{'],
  ['｝', '}'],
  ['［', '['],
  ['］', ']'],
  ['：', ':'],
  ['，', ','],
  ['；', ';'],
]);

function stripBom(text) {
  return text.replace(/^﻿/, '');
}

/**
 * 文字列（"..."）の外にある文字だけを置き換える。
 * 得意先名に全角スペースが入っていることがあるので（「強羅花壇　富士」）、
 * 引用符の中は必ず残す。
 */
function mapOutsideStrings(text, replace) {
  let inString = false;
  let escaped = false;
  let out = '';

  for (const ch of text) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    out += inString ? ch : (replace(ch) ?? ch);
  }
  return out;
}

/** 閉じ括弧の直前のカンマを落とす（文字列の外だけ） */
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

/**
 * 1段目。手で書きがちな崩れのうち、直しても中身が変わらないものだけを直す。
 */
function relax(text) {
  const out = mapOutsideStrings(stripBom(text), (ch) => (ch === '　' ? ' ' : ch));
  return removeTrailingCommas(out);
}

/**
 * 2段目。全角の引用符を半角にする。
 *
 * これは文字列判定より**先に**当てる必要がある。「“」は開き引用符として
 * 認識されないため、1段目の判定では inString が反転したままになり、
 * それ以降のファイル全体で全角スペースの変換も末尾カンマの除去も止まってしまう。
 * 1文字で修復機能が丸ごと無効になるので、判定の前に潰しておく。
 */
function fixSmartQuotes(text) {
  const fixes = [];
  let out = '';
  for (const ch of text) {
    const replacement = SMART_QUOTES.get(ch);
    if (replacement == null) {
      out += ch;
      continue;
    }
    fixes.push({ at: out.length, char: ch });
    out += replacement;
  }
  return { text: out, fixes };
}

/**
 * 3段目。文字列の外の全角記号を半角にする。
 * 2段目で引用符を直したあとなので、文字列判定はもう信用できる。
 */
function fixFullwidthPunct(text) {
  const fixes = [];
  let consumed = 0;
  const out = mapOutsideStrings(text, (ch) => {
    const replacement = FULLWIDTH_PUNCT.get(ch);
    if (replacement != null) fixes.push({ at: consumed, char: ch });
    consumed += ch.length;
    return replacement;
  });
  // mapOutsideStrings は文字列の中を通らないので at がずれる。
  // 位置は警告の行番号にしか使わないため、元の文字を探し直して補正する。
  return { text: out, fixes: fixes.map((f) => ({ ...f, at: text.indexOf(f.char) })) };
}

const CJK = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦　-〿]/;

/** ターミナル上の見た目の幅。キャレットの位置を合わせるのに使う */
function displayWidth(text) {
  let w = 0;
  for (const ch of text) w += CJK.test(ch) ? 2 : 1;
  return w;
}

/** 文字位置 → 行番号・列番号・その行の中身 */
function positionToPlace(text, pos) {
  const before = text.slice(0, pos);
  const line = before.split('\n').length;
  const column = pos - (before.lastIndexOf('\n') + 1) + 1;
  return { line, column, text: text.split('\n')[line - 1] ?? '' };
}

/**
 * どこでつまずいたかを割り出す。
 *
 * V8 のメッセージは2種類あり、`position` が入るとは限らない。
 *   Expected property name or '}' in JSON at position 1 (line 1 column 2)
 *   Unexpected token '“', "..." is not valid JSON     ← position が無い
 * 後者に落ちると行番号が出せないので、JSONに現れないはずの文字を
 * こちらで探して場所を割り出す。
 */
function locate(text, message) {
  const m = /position (\d+)/.exec(message ?? '');
  if (m) {
    const pos = Number(m[1]);
    const hint = SUSPICIOUS.get(text[pos]);
    if (hint) return { ...positionToPlace(text, pos), hint };
    // position はあるが、そこに手がかりが無いこともある。
    // 「“」で文字列が閉じないまま最後まで行くと、position は
    // ファイルの末尾を指してしまい、本当の原因の行が分からない。
    // 使えない文字が残っているなら、そちらを原因として挙げる。
    return findSuspicious(text) ?? { ...positionToPlace(text, pos), hint: null };
  }

  return findSuspicious(text);
}

/**
 * JSONの構文として絶対に成り立たない文字を探す。
 * 全角スペースは文字列の中なら正しい（「強羅花壇　富士」）ので対象にしない。
 */
function findSuspicious(text) {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '　') continue;
    const hint = SUSPICIOUS.get(ch);
    if (hint) return { ...positionToPlace(text, i), hint };
  }
  return null;
}

/** 該当行とキャレットを添えたメッセージを組み立てる */
function describePlace(filePath, place) {
  const line = place.text.replace(/\s+$/, '');
  const caret = ' '.repeat(displayWidth(line.slice(0, place.column - 1)));
  const lines = [
    `${filePath} の${place.line}行目・${place.column}文字目でつまずきました:`,
    `    ${line}`,
    `    ${caret}^`,
  ];
  if (place.hint) {
    lines.push(`  ${place.hint}です。半角の文字に直してください。`);
  } else {
    lines.push('  よくある原因: 引用符の閉じ忘れ／括弧の対応／コロンの書き忘れ');
  }
  lines.push('  （行末の余分なカンマと全角スペースは自動で直すので、原因ではありません）');
  return lines.join('\n');
}

/**
 * 読み込む。読めなければ、どこでつまずいたかを添えて例外にする。
 * @returns {{aliases: object, warnings: string[]}}
 */
function readAliasFile(filePath) {
  if (!fs.existsSync(filePath)) return { aliases: {}, warnings: [] };

  const buffer = fs.readFileSync(filePath);

  // JSONの構文を疑う前に、そもそもテキストかどうかを見る。
  // テキストエディットの既定はリッチテキストなので、貼って保存すると中身がRTFになる。
  // このとき「引用符の閉じ忘れ」などと言っても、原因はそこではない。
  const format = detectNotPlainText(buffer);
  if (format) throw new Error(notPlainTextMessage(filePath, format, 'JSON'));

  const raw = buffer.toString('utf8');
  const repairWarnings = [];
  let lastError;

  // 中身が無いファイルは「補正表なし」として通す。書き始める前の空ファイルで
  // 移行が止まる理由がない。
  if (raw.trim() === '') {
    return { aliases: {}, warnings: [`${filePath} は中身が空なので、補正表なしとして進みます`] };
  }

  // 1段目
  try {
    const aliases = JSON.parse(relax(raw));
    return { aliases, warnings: collectWarnings(aliases) };
  } catch (e) {
    lastError = e;
  }

  // 2段目: 全角の引用符
  const quoted = fixSmartQuotes(stripBom(raw));
  if (quoted.fixes.length) {
    try {
      const aliases = JSON.parse(relax(quoted.text));
      pushFixWarnings(repairWarnings, raw, quoted.fixes);
      return { aliases, warnings: [...repairWarnings, ...collectWarnings(aliases)] };
    } catch (e) {
      lastError = e;
    }
  }

  // 3段目: 文字列の外の全角記号
  const punct = fixFullwidthPunct(quoted.text);
  if (punct.fixes.length) {
    try {
      const aliases = JSON.parse(relax(punct.text));
      pushFixWarnings(repairWarnings, raw, [...quoted.fixes, ...punct.fixes]);
      return { aliases, warnings: [...repairWarnings, ...collectWarnings(aliases)] };
    } catch (e) {
      lastError = e;
    }
  }

  const place = locate(raw, lastError.message);
  throw new Error(
    place
      ? describePlace(filePath, place)
      : `${filePath} を読み取れませんでした（${lastError.message}）\n` +
          '  よくある原因: 引用符の閉じ忘れ／括弧の対応／コロンの書き忘れ'
  );
}

/** 直した箇所を「何行目の何を直したか」で伝える */
function pushFixWarnings(warnings, raw, fixes) {
  for (const fix of fixes) {
    const place = positionToPlace(raw, fix.at);
    warnings.push(
      `${place.line}行目の${SUSPICIOUS.get(fix.char) ?? fix.char}を直して読み込みました。` +
        `意図した文字か確認してください: ${place.text.trim()}`
    );
  }
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

module.exports = { readAliasFile, relax, collectWarnings, locate };
