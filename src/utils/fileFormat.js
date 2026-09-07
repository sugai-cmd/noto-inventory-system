// 「テキストのつもりで置かれた、テキストではないファイル」を見分ける。
//
// macOS のテキストエディットは既定がリッチテキストなので、新規ファイルに
// 貼って保存すると中身が RTF になる。拡張子は .json や .csv のままなので、
// 開くまで気づけない。実際に aliases.json がこれで読めなかった。
//
// CSV の方はもっとたちが悪く、RTF でもエラーにならずに読めてしまう。
// 見出しが「{\rtf1...」の1列だけになるので、以降の項目が全部空になり、
// 「得意先名が空です」が何百件も並ぶだけで原因が分からない。
//
// ここでは**先頭のバイト列を見るだけ**にして、中身の解釈はしない。
// RTF を読み解いて中のJSONを取り出すこともしない。書き出し側の癖を推測で
// パースすることになり、外したときに黙って壊れた設定を読むことになるため。

/** 先頭がこのバイト列なら、その形式とみなす */
const SIGNATURES = [
  { bytes: Buffer.from('{\\rtf'), name: 'リッチテキスト書類（RTF）', textEdit: true },
  { bytes: Buffer.from('PK\x03\x04', 'latin1'), name: 'Excel・Wordなどの書類（.xlsx / .docx）' },
  {
    bytes: Buffer.from('d0cf11e0a1b11ae1', 'hex'),
    name: '古いExcel・Wordの書類（.xls / .doc）',
  },
  { bytes: Buffer.from('%PDF-'), name: 'PDF' },
  { bytes: Buffer.from('SQLite format 3\0', 'latin1'), name: 'データベースファイル' },
  { bytes: Buffer.from('\x89PNG', 'latin1'), name: '画像（PNG）' },
];

/** 先頭の空白を読み飛ばしてから比べる（HTMLは字下げされていることがある） */
const HTML_HEADS = ['<!doctype html', '<html'];

/**
 * テキストとして扱えないファイルなら、その形式の呼び名を返す。
 * 普通のテキスト（CSV・JSON）なら null。
 *
 * @param {Buffer} buffer
 * @returns {{name: string, textEdit: boolean}|null}
 */
function detectNotPlainText(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;

  for (const sig of SIGNATURES) {
    if (buffer.subarray(0, sig.bytes.length).equals(sig.bytes)) {
      return { name: sig.name, textEdit: sig.textEdit === true };
    }
  }

  const head = buffer.subarray(0, 64).toString('latin1').trimStart().toLowerCase();
  if (HTML_HEADS.some((h) => head.startsWith(h))) {
    return { name: 'Webページとして保存されたもの（HTML）', textEdit: false };
  }

  return null;
}

/**
 * 直し方まで含めた案内を組み立てる。
 *
 * @param {string} filePath - どのファイルかを必ず言う（21シートのうちどれか分からないと直せない）
 * @param {{name: string, textEdit: boolean}} format - detectNotPlainText の戻り値
 * @param {string} expected - 本来あるべきもの（'JSON' / 'CSV'）
 */
function notPlainTextMessage(filePath, format, expected) {
  const lines = [`${filePath} は、${expected}ではなく${format.name}でした。`];

  if (format.textEdit) {
    lines.push(
      '  テキストエディット（TextEdit）の既定の保存形式です。',
      '',
      '  直し方（どちらでも）:',
      '    1. テキストエディットで開き、「フォーマット」→「標準テキストにする」',
      '       （⇧⌘T）を選んでから保存し直す',
      `    2. ターミナルで: textutil -convert txt -output "${filePath}" "${filePath}"`
    );
  } else if (expected === 'CSV') {
    lines.push(
      '  スプレッドシートから「ファイル → ダウンロード → カンマ区切り形式(.csv)」で',
      '  書き出したものを、そのまま置いてください。'
    );
  } else {
    lines.push('  ただのテキストとして書き直してください。');
  }

  return lines.join('\n');
}

module.exports = { detectNotPlainText, notPlainTextMessage };
