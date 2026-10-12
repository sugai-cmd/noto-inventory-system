// Webゆうパックプリントに「出荷予定データ」のCSVをアップロードする（印刷はしない）。
//
// 画面の流れ（公式マニュアル Web_operation / Web_upload より）
//   ログイン（ゆうID）→ メインメニュー「一覧」→「印字予定を見る／直す」（出荷予定データ一覧）
//   →「アップロード」→ ファイル変換定義を選ぶ →「参照」でCSV →「アップロード」→ 件数と完了の表示
//
// **ログイン後の画面は実物で確かめていない。** 初回は BROWSER_HEADED=1 で動かし、
// 止まったら logs/ship-docs/ の写真を見て文言を直す。
//
// .env
//   WEBYUPACK_ID / WEBYUPACK_PASSWORD   ゆうID（メールアドレス）とパスワード
//   WEBYUPACK_URL                       入口（既定はサービスのトップ）
//   WEBYUPACK_CONVERSION                ファイル変換定義の名前に含まれる文字（既定「標準」）

const { clickByText, fillFirst, bodyText, StepError } = require('./browser');

const DEFAULT_URL = 'https://www.post.japanpost.jp/web-yu-packprint/';

async function login(page, env, rec) {
  // すでにログイン済みなら「ログアウト」がある
  if (/ログアウト/.test(await bodyText(page))) return;

  await clickByText(page, /^ログイン|ログインする|ログインはこちら/, { timeout: 5000 });
  await rec.snap(page, 'yupack_login_page');

  if (!env.WEBYUPACK_ID || !env.WEBYUPACK_PASSWORD) {
    throw new StepError('.env に WEBYUPACK_ID と WEBYUPACK_PASSWORD を設定してください', { kind: 'login' });
  }
  const idOk = await fillFirst(
    page,
    ['input[type=email]', 'input[name*=mail i]', 'input[name*=id i]:not([type=hidden])', 'input[type=text]'],
    env.WEBYUPACK_ID
  );
  const pwOk = await fillFirst(page, ['input[type=password]'], env.WEBYUPACK_PASSWORD);
  if (!idOk || !pwOk) throw new StepError('ログイン画面の入力欄が見つかりません', { step: 'login', kind: 'login' });

  await clickByText(page, /ログイン/);
  await page.waitForLoadState('networkidle').catch(() => {});
  await rec.snap(page, 'yupack_after_login');

  const text = await bodyText(page);
  if (/パスワードが(違|正しくありません)|認証に失敗|ログインできません/.test(text)) {
    throw new StepError('ゆうIDかパスワードが違います', { step: 'login', kind: 'login' });
  }
  if (/認証コード|確認コード|ワンタイム/.test(text)) {
    throw new StepError('追加の認証（確認コード）を求められました。BROWSER_HEADED=1 で一度手でログインしてください', {
      step: 'login', kind: 'login',
    });
  }
}

/**
 * @returns {Promise<{message: string}>}
 */
async function uploadYuPack(context, csvFile, { env = process.env, rec }) {
  const page = await context.newPage();
  try {
    await page.goto(env.WEBYUPACK_URL || DEFAULT_URL, { waitUntil: 'domcontentloaded' });
    await rec.snap(page, 'yupack_top');
    await login(page, env, rec);

    // 出荷予定データ一覧へ
    if (!(await clickByText(page, /印字予定を見る|出荷予定データ一覧/, { timeout: 3000 }))) {
      await clickByText(page, /^一覧$|一覧/);
      await rec.snap(page, 'yupack_menu_list');
      if (!(await clickByText(page, /印字予定を見る|出荷予定データ一覧/))) {
        throw new StepError('「印字予定を見る／直す」が見つかりません', { step: 'list' });
      }
    }
    await rec.snap(page, 'yupack_schedule_list');

    if (!(await clickByText(page, /^アップロード$|アップロード/))) {
      throw new StepError('出荷予定データ一覧に「アップロード」が見つかりません', { step: 'open_upload' });
    }
    await rec.snap(page, 'yupack_upload_page');

    // ファイル変換定義（標準フォーマット）
    const select = page.locator('select').first();
    if (await select.isVisible().catch(() => false)) {
      const want = env.WEBYUPACK_CONVERSION || '標準';
      const options = await select.locator('option').allInnerTexts();
      const label = options.find((o) => o.includes(want));
      if (label) await select.selectOption({ label });
    }

    const fileInput = page.locator('input[type=file]').first();
    if (!(await fileInput.count())) {
      throw new StepError('CSVを選ぶ欄が見つかりません', { step: 'choose_file' });
    }
    await fileInput.setInputFiles(csvFile);
    await rec.snap(page, 'yupack_file_chosen');

    // 画面上の「アップロード」は見出しにも使われるので、ボタンを優先する
    const clicked =
      (await page.getByRole('button', { name: /アップロード/ }).last().click().then(() => true).catch(() => false)) ||
      (await clickByText(page, /アップロード/));
    if (!clicked) throw new StepError('「アップロード」ボタンが押せません', { step: 'submit' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await rec.snap(page, 'yupack_result');

    const text = await bodyText(page);
    if (/エラー内容ダウンロード|エラーがあります|エラーが発生/.test(text)) {
      throw new StepError('Webゆうパックプリントがエラーを返しました（logs/ship-docs の写真を確認）', {
        step: 'result', kind: 'upload',
      });
    }
    const ok = text.match(/[0-9０-９]+\s*件[^\n]{0,30}(アップロード|登録|作成)[^\n]{0,20}/);
    if (!ok && !/完了|正常に/.test(text)) {
      throw new StepError('アップロードの完了表示が確認できません（logs/ship-docs の写真を確認）', {
        step: 'result', kind: 'upload',
      });
    }
    return { message: ok ? ok[0] : '完了' };
  } catch (err) {
    await rec.snap(page, 'yupack_error');
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { uploadYuPack };
