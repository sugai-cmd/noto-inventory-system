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
const apiPut = (path, body) => api('PUT', path, body);

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

/**
 * 度数の表示。34.47% の形（小数2桁）。
 *
 * 台帳から計算できなかったタンクは「—」。以前は 0 と出していたが、
 * それは 0%（＝水）という意味になってしまう。
 * 棚卸で実測の度数を入れれば、それ以降はその値が出る。
 */
function abvText(value) {
  return value == null ? '—' : `${Number(value).toFixed(2)}%`;
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
    ['lots.html', 'ロット追跡'],
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

// --- 一覧のページ送り・並べ替え -------------------------------------------
//
// 瓶詰めタブ（public/bottling.html）で先に作った形を、他の一覧でも使えるように
// ここへ出した。**絞り込みは各画面に残す** — 一覧ごとに項目が違うので、
// 1つの関数に押し込むと、どの画面が何を送るのか読めなくなる。
//
// view は { sort, order, offset, total } を持つただのオブジェクト。
// ids は { limit, prev, next, range } の要素id。

/** 一覧の状態。画面ごとに1つ作って、下のヘルパに渡す */
function createListView(sort, order = 'desc') {
  return { sort, order, offset: 0, total: 0 };
}

/**
 * 一覧APIの返りを受け取る。**古い形（行の配列）で返ってきても、一覧は出す。**
 *
 * 一覧は `{rows, total}` を返すよう変えたが、`git pull` したあとサーバーを
 * 再起動していないと、画面だけが新しくなる（`public/` はディスクから毎回読まれるが、
 * `src/` は起動時に読まれたものが動き続ける）。
 * 古いサーバーは行の配列を返すので、`{rows, total}` に分解すると rows が undefined になり、
 * 利用者には「Cannot read properties of undefined」としか出ない（原因が分からない）。
 *
 * **ここで止めてしまうと一覧が1行も出ず、仕事が止まる。**
 * 行そのものは返ってきているのだから、更新前と同じ見え方で出す。
 * ページ送りと総件数だけが効かないので、それは黄色の帯で知らせる。
 *
 * （存在しないAPIには src/app.js が同じ趣旨の案内を404で返しているが、
 *   形が変わっただけの場合は404にならず素通りしてしまう。そこを塞ぐのがここ）
 */
function asListResult(res, endpoint) {
  if (!Array.isArray(res)) return res;

  warnStaleServer(endpoint);
  // 総件数が無いので、いま届いている行数を件数として扱う
  return { rows: res, total: res.length, stale: true };
}

/** 再起動の案内。画面を開くたびに何度も出しても仕方ないので1回だけ */
let staleServerWarned = false;
function warnStaleServer(endpoint) {
  if (staleServerWarned) return;
  staleServerWarned = true;
  showMessage(
    'messages',
    'warn',
    `サーバーが更新前のまま動いています（${endpoint}）。一覧は表示できていますが、` +
      'ページ送りと総件数、新しく足した絞り込みは効きません。' +
      'サーバー機でアプリを再起動してください。'
  );
}

/** limit / offset / sort / order を載せた URLSearchParams を作る（絞り込みは呼び手が足す） */
function listQuery(view, ids) {
  return new URLSearchParams({
    limit: el(ids.limit).value,
    offset: String(view.offset),
    sort: view.sort,
    order: view.order,
  });
}

/**
 * 並べ替えの向きを見出しに出す。
 *
 * 見出しの文字は data-label に控えてあるので、矢印だけを付け替える
 * （textContent を読み直すと、前回の矢印まで名前に取り込んでしまう）。
 */
function renderSortMarks(view, root = document) {
  for (const btn of root.querySelectorAll('[data-sort]')) {
    const mark = btn.dataset.sort === view.sort ? (view.order === 'asc' ? '▲' : '▼') : '';
    btn.innerHTML = `${escapeHtml(btn.dataset.label ?? btn.textContent)}<span class="dir">${mark}</span>`;
  }
}

/** 「120件中 51〜100件」と、前へ／次への押せる・押せないを出す */
function renderPager(view, ids, shown) {
  const limit = Number(el(ids.limit).value);
  const start = view.total ? view.offset + 1 : 0;
  el(ids.range).textContent = view.total
    ? `${view.total}件中 ${start}〜${view.offset + shown}件`
    : '該当する記録がありません';
  el(ids.prev).disabled = view.offset <= 0;
  el(ids.next).disabled = view.offset + limit >= view.total;
}

/**
 * 件数選択・前へ・次への配線。
 *
 * filterIds に絞り込みの欄を渡すと、変えたときに1ページ目へ戻す
 * （3ページ目で絞り込むと、該当0件なのに「次へ」だけ押せる状態になるため）。
 */
function wirePager(view, ids, reload, filterIds = []) {
  for (const id of [ids.limit, ...filterIds]) {
    el(id).addEventListener('change', () => {
      view.offset = 0;
      reload();
    });
  }
  el(ids.prev).addEventListener('click', () => {
    view.offset = Math.max(0, view.offset - Number(el(ids.limit).value));
    reload();
  });
  el(ids.next).addEventListener('click', () => {
    view.offset += Number(el(ids.limit).value);
    reload();
  });
}

/** 見出しを押すと並べ替える。同じ見出しをもう一度押すと昇順・降順が入れ替わる */
function wireSortHeaders(view, tbodyId, reload) {
  const thead = el(tbodyId).closest('table').querySelector('thead');
  // 見出しの文字を控えておく。矢印を付け替えても名前が崩れない
  for (const btn of thead.querySelectorAll('[data-sort]')) btn.dataset.label = btn.textContent;

  thead.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sort]');
    if (!btn) return;
    if (view.sort === btn.dataset.sort) {
      view.order = view.order === 'asc' ? 'desc' : 'asc';
    } else {
      view.sort = btn.dataset.sort;
      view.order = 'desc';
    }
    view.offset = 0; // 並べ替えたら1ページ目に戻す
    reload();
  });
}
