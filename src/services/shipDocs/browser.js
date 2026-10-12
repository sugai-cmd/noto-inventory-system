// 送り状・納品書の登録で使うブラウザ（Mac に入っている Google Chrome を Playwright で動かす）。
//
// - 専用のプロファイル（.browser-profile/）を使う。普段使いのChromeとは混ざらない。
//   ログイン状態はここに残るので、毎回ログインし直さずに済む
// - 画面ごとに写真（png）とHTMLを logs/ship-docs/<実行日時>/ に残す。
//   画面が変わって止まったとき、どこで止まったかを後から見て直せるようにするため
//
// .env
//   BROWSER_CHANNEL   既定 chrome（Google Chrome）。msedge なども可
//   BROWSER_HEADED=1  画面を出して動かす（最初の確認・調整のとき）
//   BROWSER_EXECUTABLE  ブラウザ本体の場所を直接指定する場合

const fs = require('node:fs');
const path = require('node:path');

class StepError extends Error {
  constructor(message, { step, kind = 'step' } = {}) {
    super(message);
    this.step = step;
    this.kind = kind; // 'login' | 'step' | 'upload'
  }
}

async function openBrowser({ profileDir, headed, env = process.env }) {
  const { chromium } = require('playwright-core');
  fs.mkdirSync(profileDir, { recursive: true });
  return chromium.launchPersistentContext(profileDir, {
    // BROWSER_EXECUTABLE があればそのブラウザ本体を使う（試験・Chrome以外の場合）
    ...(env.BROWSER_EXECUTABLE
      ? { executablePath: env.BROWSER_EXECUTABLE }
      : { channel: env.BROWSER_CHANNEL || 'chrome' }),
    headless: !(headed || env.BROWSER_HEADED === '1'),
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
}

/** 画面の記録係。step名ごとに 01_xxx.png / 01_xxx.html を残す */
function createRecorder(dir) {
  let n = 0;
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    async snap(page, name) {
      n++;
      const base = path.join(dir, `${String(n).padStart(2, '0')}_${name}`);
      try {
        await page.screenshot({ path: `${base}.png`, fullPage: true });
        fs.writeFileSync(`${base}.html`, await page.content());
      } catch {
        // 記録の失敗で本体を止めない
      }
    },
  };
}

/**
 * 文字でボタン・リンクを探して押す。押せたら true。
 * サイト側の部品の作り（button / a / input）が分からないので、順に試す。
 */
async function clickByText(page, pattern, { timeout = 8000 } = {}) {
  const candidates = [
    page.getByRole('button', { name: pattern }),
    page.getByRole('link', { name: pattern }),
    page.getByRole('tab', { name: pattern }),
    page.locator('input[type=submit], input[type=button]').filter({ hasText: pattern }),
    page.getByText(pattern),
  ];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const loc of candidates) {
      const first = loc.first();
      if (await first.isVisible().catch(() => false)) {
        await first.click();
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        return true;
      }
    }
    // input[type=submit] は value に文字があるので別に探す
    const byValue = page.locator('input[type=submit], input[type=button]');
    const count = await byValue.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = byValue.nth(i);
      const value = (await el.getAttribute('value').catch(() => '')) ?? '';
      if (pattern.test(value) && (await el.isVisible().catch(() => false))) {
        await el.click();
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        return true;
      }
    }
    await page.waitForTimeout(300);
  }
  return false;
}

/** 見えている最初の入力欄に書く。書けたら true */
async function fillFirst(page, selectors, value) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.fill(value);
      return true;
    }
  }
  return false;
}

async function bodyText(page) {
  return (await page.locator('body').innerText().catch(() => '')) ?? '';
}

module.exports = { openBrowser, createRecorder, clickByText, fillFirst, bodyText, StepError };
