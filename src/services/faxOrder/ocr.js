// FAXのPDF（スキャン画像）を文字にする。
//
// 無料・ローカル完結にするため、Tesseract（OCR）と poppler の pdftoppm（PDF→画像）を
// コマンドとして呼ぶ。npmの依存は増やさない。Macでは次で入る（docs/FAX-ORDER-IMPORT.md）。
//   brew install tesseract tesseract-lang poppler
//
// 帳票の罫線（=====）と同じ行の文字がまとめて崩れることがあるため、
// ページの読み方（psm）を変えて何度か読み、項目ごとに読めたものを採用する
// （どれを採用するかは faxOrderImportService が決める）。

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);

const TESSERACT = process.env.TESSERACT_BIN || 'tesseract';
const PDFTOPPM = process.env.PDFTOPPM_BIN || 'pdftoppm';

/**
 * 試す読み方の順番。実物（2026-10-10のカナカン発注書）では
 *   4: 全項目読めた / 11: 入庫日・発注番号は読めた / 6: 罫線の行が崩れた
 */
const DEFAULT_PSM_ORDER = [4, 11, 6];

/** PDFの各ページを300dpiのグレー画像にする。戻り値は画像パスの配列（ページ順） */
async function pdfToImages(pdfPath, workDir) {
  const prefix = path.join(workDir, 'page');
  await run(PDFTOPPM, ['-r', '300', '-gray', '-png', pdfPath, prefix]);
  return fs
    .readdirSync(workDir)
    .filter((f) => f.startsWith('page') && f.endsWith('.png'))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
    .map((f) => path.join(workDir, f));
}

async function ocrImage(imagePath, psm) {
  const { stdout } = await run(TESSERACT, [imagePath, '-', '-l', 'jpn', '--psm', String(psm)], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

/**
 * PDFをOCRして、読み方ごとのテキストを返す。
 * @param {string} pdfPath
 * @param {{psmOrder?: number[], stopWhen?: (text: string) => boolean}} [opts]
 *   stopWhen が true を返したら、残りの読み方は試さない（全項目読めたら打ち切る用）
 * @returns {Promise<{psm: number, text: string}[]>}
 */
async function ocrPdf(pdfPath, { psmOrder = DEFAULT_PSM_ORDER, stopWhen } = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fax-ocr-'));
  try {
    const images = await pdfToImages(pdfPath, workDir);
    if (!images.length) throw new Error(`PDFから画像を取り出せませんでした: ${pdfPath}`);

    const results = [];
    for (const psm of psmOrder) {
      const pages = [];
      for (const image of images) pages.push(await ocrImage(image, psm));
      const text = pages.join('\n');
      results.push({ psm, text });
      if (stopWhen?.(text)) break;
    }
    return results;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** OCRに必要なコマンドが入っているか（起動時・CLIの最初に確かめる） */
async function checkOcrTools() {
  const problems = [];
  try {
    const { stdout, stderr } = await run(TESSERACT, ['--list-langs']);
    if (!`${stdout}${stderr}`.split(/\s+/).includes('jpn')) {
      problems.push('Tesseractの日本語データ（jpn）がありません → brew install tesseract-lang');
    }
  } catch {
    problems.push('tesseract が見つかりません → brew install tesseract tesseract-lang');
  }
  try {
    await run(PDFTOPPM, ['-v']);
  } catch {
    problems.push('pdftoppm が見つかりません → brew install poppler');
  }
  return problems;
}

module.exports = { ocrPdf, checkOcrTools, DEFAULT_PSM_ORDER };
