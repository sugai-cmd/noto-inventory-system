// 画面共通のユーティリティ。

/** APIを叩く。エラーレスポンス(4xx/5xx)は例外にしてメッセージを引き継ぐ。 */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();

  // JSONでない応答（ログイン画面へのリダイレクトHTMLや、
  // 古いサーバーが返すExpress既定の404ページなど）をそのままJSON.parseすると
  // 「Unexpected token '<'」という、原因の分からないエラーになる。
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      const err = new Error(
        res.status === 404
          ? `この機能がサーバーにありません（${path}）。サーバー機でアプリを再起動してください。`
          : `サーバーから予期しない応答が返りました（HTTP ${res.status}／${path}）。`
      );
      err.status = res.status;
      throw err;
    }
  }

  if (!res.ok) {
    const err = new Error(data?.message || `エラーが発生しました (HTTP ${res.status})`);
    err.status = res.status;
    err.details = data?.details;
    throw err;
  }
  return data;
}

const apiGet = (path) => api('GET', path);
const apiPost = (path, body) => api('POST', path, body);
const apiPatch = (path, body) => api('PATCH', path, body);

function el(id) {
  return document.getElementById(id);
}

function showMessage(containerId, type, text, details) {
  const box = el(containerId);
  if (!box) return;
  const list = details?.length
    ? `<ul>${details.map((d) => `<li>${escapeHtml(d.path)}: ${escapeHtml(d.message)}</li>`).join('')}</ul>`
    : '';
  box.innerHTML = `<div class="msg ${type}">${escapeHtml(text)}${list}</div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearMessage(containerId) {
  const box = el(containerId);
  if (box) box.innerHTML = '';
}

function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function yen(value) {
  if (value == null || value === '') return '';
  return `¥${Number(value).toLocaleString('ja-JP')}`;
}

function num(value, digits = 0) {
  if (value == null || value === '') return '';
  return Number(value).toLocaleString('ja-JP', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 今日の日付を YYYY-MM-DD で返す（2.0の方針通り日付のみ） */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 現在時刻を HH:MM で返す（日付とは別カラムに保存するため分離） */
function nowTimeStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * インクリメンタル検索つきセレクタ（DB_SCHEMA_DESIGN.md 2.2）。
 * AppSheetで使えていた「入力しながら絞り込む」操作感を再現する。
 *
 * @param {object} opts
 * @param {string} opts.inputId      - 検索テキストボックスのid
 * @param {string} opts.resultsId    - 候補リストのid
 * @param {string} opts.chosenId     - 選択済み表示のid
 * @param {string} opts.endpoint     - 例 '/api/customers/search'
 * @param {(item:object)=>string} opts.renderLabel
 * @param {(item:object)=>string} [opts.renderSub]
 * @param {(item:object|null)=>void} [opts.onSelect]
 */
function createSearchSelect(opts) {
  const input = el(opts.inputId);
  const results = el(opts.resultsId);
  const chosen = el(opts.chosenId);
  let selected = null;
  let items = [];
  let activeIndex = -1;
  let timer = null;

  function renderResults() {
    results.innerHTML = items
      .map((item, i) => {
        const sub = opts.renderSub ? `<div class="sub">${escapeHtml(opts.renderSub(item))}</div>` : '';
        return `<div data-index="${i}" class="${i === activeIndex ? 'active' : ''}">${escapeHtml(opts.renderLabel(item))}${sub}</div>`;
      })
      .join('');
  }

  function choose(item) {
    selected = item;
    items = [];
    activeIndex = -1;
    results.innerHTML = '';
    input.style.display = 'none';
    chosen.style.display = 'flex';
    chosen.querySelector('.name').textContent = opts.renderLabel(item);
    if (opts.onSelect) opts.onSelect(item);
  }

  function reset() {
    selected = null;
    input.value = '';
    input.style.display = '';
    chosen.style.display = 'none';
    results.innerHTML = '';
    if (opts.onSelect) opts.onSelect(null);
    input.focus();
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      try {
        items = await apiGet(`${opts.endpoint}?q=${encodeURIComponent(q)}`);
        activeIndex = items.length ? 0 : -1;
        renderResults();
      } catch {
        items = [];
        results.innerHTML = '';
      }
    }, 150);
  });

  input.addEventListener('keydown', (e) => {
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % items.length;
      renderResults();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
      renderResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0) choose(items[activeIndex]);
    } else if (e.key === 'Escape') {
      items = [];
      results.innerHTML = '';
    }
  });

  results.addEventListener('mousedown', (e) => {
    const row = e.target.closest('[data-index]');
    if (row) choose(items[Number(row.dataset.index)]);
  });

  input.addEventListener('blur', () => {
    // クリックでの選択を拾えるよう少し待つ
    setTimeout(() => { results.innerHTML = ''; }, 200);
  });

  chosen.querySelector('button').addEventListener('click', reset);
  chosen.style.display = 'none';

  return {
    get value() { return selected; },
    reset,
  };
}

/** 全画面共通のヘッダを描画する */
function renderNav(current) {
  const pages = [
    ['index.html', 'ダッシュボード'],
    ['orders.html', '受注'],
    ['bottling.html', '瓶詰め・箱詰め'],
    ['shipments.html', '返品・サンプル・委託'],
    ['distillation.html', '蒸留'],
    ['tanks.html', 'タンク操作'],
    ['materials.html', '資材'],
    ['stock.html', '在庫'],
    ['stocktaking.html', '棚卸'],
    ['audit.html', '在庫監査'],
    ['sales-targets.html', '売上目標'],
    ['quotations.html', '見積'],
    ['masters.html', 'マスタ'],
    ['shipping.html', '送料設定'],
    ['settings.html', '設定'],
  ];
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<header class="site">
       <div class="site-top">
         <h1>NOTO Naorai 受注・製造管理システム</h1>
         <div class="site-user" id="siteUser"></div>
       </div>
       <nav class="site">
         ${pages
           .map(
             ([href, label]) =>
               `<a href="${href}" class="${href === current ? 'active' : ''}">${label}</a>`
           )
           .join('')}
       </nav>
     </header>`
  );

  renderCurrentUser();
}

/** ヘッダにログイン中のユーザー名とログアウトボタンを出す */
async function renderCurrentUser() {
  const box = el('siteUser');
  if (!box) return;

  try {
    const { user } = await apiGet('/api/auth/me');
    box.innerHTML =
      `<span>${escapeHtml(user.displayName)}</span>` +
      `<button type="button" id="logoutBtn" class="secondary small">ログアウト</button>`;

    el('logoutBtn').addEventListener('click', async () => {
      await apiPost('/api/auth/logout');
      location.href = '/login.html';
    });
  } catch {
    // 未ログインならサーバー側のリダイレクトに任せる
  }
}
