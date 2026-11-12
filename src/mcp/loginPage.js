// コネクタのログイン画面（claude.ai から開かれる）。
// サイト本体は tailnet の中にしかないので、画面の CSS・JS には頼らず1枚で完結させる。

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {object} opts
 * @param {string} [opts.pendingId] - 無ければフォームを出さず、メッセージだけ出す
 * @param {string} [opts.clientName]
 * @param {string} [opts.username]
 * @param {string} [opts.error]
 */
function renderLoginPage({ pendingId, clientName, username, error } = {}) {
  const form = pendingId
    ? `<form method="post" action="/oauth/login">
    <input type="hidden" name="pendingId" value="${escapeHtml(pendingId)}">
    <label>ログインID<input name="username" autocomplete="username" required value="${escapeHtml(username)}"></label>
    <label>パスワード<input name="password" type="password" autocomplete="current-password" required></label>
    <label>認証アプリのコード（2要素認証）<input name="totpCode" inputmode="numeric" autocomplete="one-time-code" required></label>
    <button type="submit">ログインして許可する</button>
  </form>`
    : '';

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>受注管理システム｜コネクタのログイン</title>
<style>
  body { font-family: system-ui, -apple-system, "Hiragino Sans", sans-serif; background: #f5f5f4; color: #1c1917; margin: 0; }
  main { max-width: 420px; margin: 40px auto; padding: 24px 16px; background: #fff; border-radius: 12px; }
  h1 { font-size: 1.2rem; margin: 0 0 12px; }
  p { line-height: 1.6; font-size: .95rem; }
  label { display: block; margin: 14px 0 0; font-size: .9rem; }
  input { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 10px; font-size: 1rem; border: 1px solid #a8a29e; border-radius: 8px; }
  button { margin-top: 20px; width: 100%; padding: 12px; font-size: 1rem; border: 0; border-radius: 8px; background: #1d4ed8; color: #fff; }
  .error { background: #fef2f2; color: #991b1b; padding: 10px 12px; border-radius: 8px; }
  .scope { background: #f5f5f4; padding: 10px 12px; border-radius: 8px; font-size: .9rem; }
</style>
</head>
<body>
<main>
  <h1>NOTO Naorai 受注管理システム</h1>
  <p>${escapeHtml(clientName || 'Claude')} が、あなたのアカウントで次の操作をできるようにします。</p>
  <div class="scope">蒸留の開始・蒸留中の投入追加・完了報告の登録と、タンク・蒸留記録の読み取り（取消・修正・削除はできません）</div>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  ${form}
</main>
</body>
</html>`;
}

module.exports = { renderLoginPage };
