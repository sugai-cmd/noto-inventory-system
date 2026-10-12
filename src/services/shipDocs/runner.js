// 送り状・納品書の登録を1回分まわす（毎朝8時のlaunchd・受注画面のボタン・コマンドから呼ぶ）。
//
//   対象の受注を選ぶ → CSVを作る → ブラウザでアップロード → 登録できた受注を記録 → 結果を返す
//
// 送り状と納品書は別々に扱う。片方が失敗しても、もう片方は進める。
// 失敗した側は記録しないので、次の実行でもう一度試す。

const fs = require('node:fs');
const path = require('node:path');
const shipDocsService = require('../shipDocsService');

const LABELS = { yupack: '送り状（Webゆうパックプリント）', moneyforward: '納品書（マネーフォワード）' };
const LOCK_STALE_MS = 30 * 60 * 1000;

function runStamp(now = new Date()) {
  const t = new Date(now.getTime() + 9 * 3600 * 1000).toISOString(); // 日本時間
  return t.slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
}

/** 二重起動を防ぐ（朝8時の実行中にボタンが押された場合など） */
function acquireLock(lockFile) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  try {
    const stat = fs.statSync(lockFile);
    if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) return false;
    fs.rmSync(lockFile, { force: true }); // 30分以上前のものは異常終了の残骸
  } catch {
    // 無ければ取れる
  }
  try {
    fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.logsDir         - logs/ship-docs
 * @param {boolean} [opts.dryRun]       - CSVを作るだけ（アップロード・記録しない）
 * @param {boolean} [opts.headed]       - 画面を出して動かす
 * @param {string[]} [opts.only]        - ['yupack'] など
 * @param {object} [opts.uploaders]     - 試験用の差し替え {yupack, moneyforward}
 * @param {Function} [opts.openBrowser] - 試験用の差し替え
 */
async function runShipDocs({
  logsDir,
  dryRun = false,
  headed = false,
  only = shipDocsService.TARGETS,
  env = process.env,
  uploaders,
  openBrowser,
  now = new Date(),
}) {
  const lockFile = path.join(logsDir, '.lock');
  if (!dryRun && !acquireLock(lockFile)) {
    return { skipped: true, reason: '別の実行がまだ動いています', results: [] };
  }

  const runDir = path.join(logsDir, runStamp(now));
  const browserMod = require('./browser');
  const rec = browserMod.createRecorder(runDir);
  const ups = uploaders ?? {
    yupack: require('./webYuPackPrint').uploadYuPack,
    moneyforward: require('./moneyForward').uploadMoneyForward,
  };
  const open = openBrowser ?? browserMod.openBrowser;

  let context = null;
  const results = [];
  try {
    const { customers, pending } = shipDocsService.findTargets(undefined, env);

    for (const target of only) {
      const orderNos = pending[target] ?? [];
      const built = shipDocsService.buildCsv(target, orderNos, runDir);
      const result = {
        target,
        label: LABELS[target],
        orderNos: built.orderNos,
        problems: built.problems,
        file: built.file,
        status: built.file ? 'pending' : 'nothing',
      };
      results.push(result);
      if (!built.file || dryRun) {
        if (built.file) result.status = 'dry_run';
        continue;
      }

      try {
        context ??= await open({ profileDir: path.resolve(logsDir, '..', '..', '.browser-profile'), headed, env });
        const { message } = await ups[target](context, built.file, { env, rec });
        shipDocsService.markUploaded(target, built.orderNos, path.relative(logsDir, built.file));
        result.status = 'uploaded';
        result.message = message;
      } catch (err) {
        result.status = 'failed';
        result.error = err.message;
        result.errorKind = err.kind ?? 'step';
      }
    }
    return { skipped: false, customers, results, runDir };
  } finally {
    if (context) await context.close().catch(() => {});
    if (!dryRun) fs.rmSync(lockFile, { force: true });
  }
}

/** Slackに送る文面。知らせることが無ければ null */
function buildSlackText(summary, { trigger = '自動' } = {}) {
  if (summary.skipped) return null;
  const lines = [];
  for (const r of summary.results) {
    if (r.status === 'uploaded') {
      lines.push(`:white_check_mark: ${r.label}に${r.orderNos.length}件登録しました（${r.orderNos.join(', ')}）${r.message ? ` — ${r.message}` : ''}`);
    } else if (r.status === 'failed') {
      lines.push(`:x: ${r.label}の登録に失敗しました（${r.orderNos.join(', ')}）: ${r.error}`);
      lines.push(r.errorKind === 'login'
        ? '　　→ ログインを確認してください（docs/SHIP-DOCS-UPLOAD.md「ログインできないとき」）'
        : '　　→ 次の実行でもう一度試します。続く場合は logs/ship-docs の写真を確認してください');
    }
    for (const p of r.problems) {
      lines.push(`:warning: ${r.label}: 受注 ${p.orderNo} は登録していません（${p.reason}）`);
    }
  }
  if (!lines.length) return null;
  return [`*送り状・納品書の登録（${trigger}）*`, ...lines].join('\n');
}

module.exports = { runShipDocs, buildSlackText, LABELS };
