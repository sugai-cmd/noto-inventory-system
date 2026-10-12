// マネーフォワード クラウド請求書に、納品書のCSVを一括追加する（送付はしない）。
//
// 画面の流れ（公式ガイド「CSV一括追加」より）
//   納品書一覧 →「CSV一括追加」→「CSVのアップロード」タブ →「ファイルを選択」→「アップロード」
// 取り込みの結果は、アップロードした人にメールでも届く。
//
// **ログイン後の画面は実物で確かめていない。** 初回は BROWSER_HEADED=1 で動かし、
// 止まったら logs/ship-docs/ の写真を見て文言を直す。
//
// .env
//   MF_EMAIL / MF_PASSWORD   マネーフォワードIDのメールアドレスとパスワード
//   MF_OFFICE_NAME           事業者を選ぶ画面が出るときの事業者名（例: NOTO Naorai）
//   MF_DELIVERY_SLIPS_URL    納品書一覧のURL（分かっていれば。既定は画面のメニューから辿る）

const { clickByText, fillFirst, bodyText, StepError } = require('./browser');

const TOP_URL = 'https://invoice.moneyforward.com/';

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * マネーフォワードIDの画面（id.moneyforward.com）を抜けて、請求書の画面に着くまで進める。
 *
 * トップを開くと、すぐには飛ばずに少し遅れて id.moneyforward.com へ移ることがある。
 * そのためURLを1回見るだけでは足りず、着くまで画面ごとに対応を繰り返す。
 *   - account_selector（どのアカウントで入るか）→ MF_EMAIL の行を押す。無ければ「別のアカウント」
 *   - メールアドレス欄 → 入れて「次へ」
 *   - パスワード欄 → 入れて「ログインする」
 *   - 二段階認証 → 自動では進めない（--login で一度手で入る）
 */
async function login(page, env, rec) {
  // 遅れて来る転送を待つ
  await page.waitForURL(/id\.moneyforward\.com/, { timeout: 5000 }).catch(() => {});

  for (let step = 0; step < 8; step++) {
    await page.waitForLoadState('networkidle').catch(() => {});
    const url = page.url();
    if (!/id\.moneyforward\.com/.test(url)) return; // 請求書の画面に着いた
    await rec.snap(page, `mf_login_${step}`);

    const text = await bodyText(page);
    if (/認証コード|確認コード|二段階|2段階|ワンタイム/.test(text)) {
      throw new StepError(
        'マネーフォワードで二段階認証を求められました。npm run ship-docs -- --login で一度手でログインしてください',
        { step: 'login', kind: 'login' }
      );
    }
    if (/パスワードが(違|正しくありません)|ログインできません|メールアドレスまたはパスワード/.test(text)) {
      throw new StepError('マネーフォワードのメールアドレスかパスワードが違います', { step: 'login', kind: 'login' });
    }

    if (/account_selector/.test(url)) {
      // 前にログインしたアカウントが並ぶ画面
      const picked =
        env.MF_EMAIL && (await clickByText(page, new RegExp(escapeRe(env.MF_EMAIL)), { timeout: 3000 }));
      if (!picked && !(await clickByText(page, /別のアカウント|他のアカウント|アカウントを追加|ログイン/, { timeout: 3000 }))) {
        throw new StepError('マネーフォワードのアカウント選択画面で先に進めません', { step: 'login', kind: 'login' });
      }
      continue;
    }

    if (!env.MF_EMAIL || !env.MF_PASSWORD) {
      throw new StepError('.env に MF_EMAIL と MF_PASSWORD を設定してください', { kind: 'login' });
    }
    // 入力欄は画面の読み込み後に表示されるので、出るまで待つ
    await page
      .locator('input[type=email], input[type=password], input[name*=email i]')
      .first()
      .waitFor({ state: 'visible', timeout: 10000 })
      .catch(() => {});
    if (await page.locator('input[type=password]').first().isVisible().catch(() => false)) {
      await fillFirst(page, ['input[type=password]'], env.MF_PASSWORD);
      await clickByText(page, /ログインする|ログイン|次へ/);
      continue;
    }
    if (await fillFirst(page, ['input[type=email]', 'input[name*=email i]'], env.MF_EMAIL)) {
      await clickByText(page, /次へ|ログインする|ログイン/);
      continue;
    }
    // 事業者・サービスの選択など、知らない画面
    if (/事業者を選択|事業者の選択/.test(text) && env.MF_OFFICE_NAME) {
      await clickByText(page, new RegExp(escapeRe(env.MF_OFFICE_NAME)));
      continue;
    }
    throw new StepError('マネーフォワードのログイン画面で先に進めません（logs/ship-docs の写真を確認）', {
      step: 'login', kind: 'login',
    });
  }
  throw new StepError('マネーフォワードのログインが終わりません（logs/ship-docs の写真を確認）', {
    step: 'login', kind: 'login',
  });
}

/** 請求書側で「事業者を選択」画面が出たとき */
async function chooseOffice(page, env) {
  const text = await bodyText(page);
  if (/事業者を選択|事業者の選択/.test(text) && env.MF_OFFICE_NAME) {
    await clickByText(page, new RegExp(escapeRe(env.MF_OFFICE_NAME)));
    await page.waitForLoadState('networkidle').catch(() => {});
  }
}

async function uploadMoneyForward(context, csvFile, { env = process.env, rec }) {
  const page = await context.newPage();
  try {
    await page.goto(TOP_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await login(page, env, rec);
    await chooseOffice(page, env);
    await rec.snap(page, 'mf_home');

    if (env.MF_DELIVERY_SLIPS_URL) {
      await page.goto(env.MF_DELIVERY_SLIPS_URL, { waitUntil: 'domcontentloaded' });
    } else if (!(await clickByText(page, /^納品書$|納品書一覧|納品書/))) {
      throw new StepError('メニューに「納品書」が見つかりません', { step: 'list' });
    }
    await page.waitForLoadState('networkidle').catch(() => {});
    await rec.snap(page, 'mf_delivery_slips');

    if (!(await clickByText(page, /CSV一括追加/))) {
      throw new StepError('納品書一覧に「CSV一括追加」が見つかりません', { step: 'open_upload' });
    }
    await rec.snap(page, 'mf_csv_dialog');
    await clickByText(page, /CSVのアップロード/, { timeout: 4000 });

    const fileInput = page.locator('input[type=file]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
    if (!(await fileInput.count())) throw new StepError('CSVを選ぶ欄が見つかりません', { step: 'choose_file' });
    await fileInput.setInputFiles(csvFile);
    await rec.snap(page, 'mf_file_chosen');

    // 「ご注意事項」に同意のチェックがある場合は入れる
    const agree = page.getByRole('checkbox').first();
    if (await agree.isVisible().catch(() => false)) await agree.check().catch(() => {});

    const clicked =
      (await page.getByRole('button', { name: /^アップロード$|アップロード/ }).last().click().then(() => true).catch(() => false)) ||
      (await clickByText(page, /アップロード/));
    if (!clicked) throw new StepError('「アップロード」ボタンが押せません', { step: 'submit' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000);
    await rec.snap(page, 'mf_result');

    const text = await bodyText(page);
    if (/エラー|失敗|できませんでした/.test(text) && !/受け付け|開始しました/.test(text)) {
      throw new StepError('マネーフォワードがエラーを返しました（logs/ship-docs の写真を確認）', {
        step: 'result', kind: 'upload',
      });
    }
    // 取り込みは裏で進み、結果はメールで届く。画面では受付までしか分からないことがある
    return { message: /受け付け|開始しました|アップロードしました|追加しました/.test(text) ? '受付完了（結果はメールでも届きます）' : '送信済み（結果はメールで確認）' };
  } catch (err) {
    await rec.snap(page, 'mf_error');
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { uploadMoneyForward };
