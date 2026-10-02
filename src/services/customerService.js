// 得意先の本店・支店。
//
// カナカンのように支店を持つ会社は、支店ごとに得意先の行がある一方で、
// 請求・与信・担当は本店単位で決まっている。
// 支店の欄が空のときは本店の値を使う、という解決をここに集約する。
//
// 継承するのは請求まわりだけ。住所・電話・配送先は支店ごとに違うので継承しない。

const { getConnection } = require('../db/connection');
const { BusinessRuleError, NotFoundError } = require('../utils/errors');

// 支店が空欄なら本店から引き継ぐ項目
const INHERITED_COLUMNS = [
  'payment_term_months',
  'payment_term_day',
  'invoice_due_note',
  'invoice_email',
  'invoice_contact',
  'markup_rate',
];

// 親を辿る上限。データが壊れて輪になっていても止まらなくなることを防ぐ
const MAX_DEPTH = 10;

const isBlank = (v) => v == null || (typeof v === 'string' && v.trim() === '');

/**
 * 得意先から根（いちばん上の本店）までの並び。先頭が本人。
 * @returns {object[]}
 */
function lineage(db, customerId) {
  const chain = [];
  const seen = new Set();
  let id = customerId;

  for (let i = 0; i < MAX_DEPTH && id != null; i++) {
    if (seen.has(id)) break; // 輪になっていたらそこで止める
    seen.add(id);
    const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!row) break;
    chain.push(row);
    id = row.parent_id;
  }
  return chain;
}

/**
 * 請求まわりの値を、本店から引き継いだ状態で返す。
 *
 * 支店に値が入っていれば支店が勝つ。空のときだけ上を見る。
 * 3段以上でも根まで辿る。
 *
 * @returns {object|null} customersの1行に、継承後の値を上書きしたもの。
 *   どこから来た値かは `inheritedFrom`（項目名 → 本店の得意先名）で分かる。
 */
function resolveBilling(customerId, db = getConnection()) {
  const chain = lineage(db, customerId);
  if (!chain.length) return null;

  const resolved = { ...chain[0] };
  const inheritedFrom = {};

  for (const column of INHERITED_COLUMNS) {
    if (!isBlank(resolved[column])) continue;
    // 自分より上で、最初に値が入っている先祖を探す
    const ancestor = chain.slice(1).find((c) => !isBlank(c[column]));
    if (!ancestor) continue;
    resolved[column] = ancestor[column];
    inheritedFrom[column] = ancestor.name;
  }

  return { ...resolved, inheritedFrom, parentName: chain[1]?.name ?? null };
}

/**
 * 同じ本店につながる得意先のidを全部返す（自分自身を含む）。
 *
 * **まとめ入金のため。** 本店の口座に振り込まれても、請求は支店ごとに立っている
 * （カナカンのように支店が6つある得意先がある）。消し込みの候補を自分の行だけに
 * 絞ると、本店への入金が1件も消し込めない。
 *
 * 根まで上って（lineage）、そこから下を辿る。輪になっていても止まらなくならないよう、
 * 見たidを覚えて MAX_DEPTH で打ち切るのは lineage と同じ。
 */
function familyIds(db, customerId) {
  const root = rootCustomer(customerId, db);
  if (!root) return [];

  const ids = new Set([root.id]);
  let frontier = [root.id];

  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth += 1) {
    const placeholders = frontier.map(() => '?').join(',');
    const children = db
      .prepare(`SELECT id FROM customers WHERE parent_id IN (${placeholders})`)
      .all(...frontier)
      .map((r) => r.id)
      .filter((id) => !ids.has(id));
    for (const id of children) ids.add(id);
    frontier = children;
  }

  return [...ids];
}

/** いちばん上の本店（親がいなければ自分自身） */
function rootCustomer(customerId, db = getConnection()) {
  const chain = lineage(db, customerId);
  return chain.length ? chain[chain.length - 1] : null;
}

/**
 * 本店として指定してよいかを確かめる。
 * 自分自身と、輪になる指定（AをBの親にしたらBがAの先祖だった）を弾く。
 */
function assertValidParent(customerId, parentId, db = getConnection()) {
  if (parentId == null) return;
  if (customerId != null && Number(parentId) === Number(customerId)) {
    throw new BusinessRuleError('自分自身を本店にはできません');
  }
  const parent = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(parentId);
  if (!parent) throw new NotFoundError(`本店に指定した得意先が見つかりません (id=${parentId})`);

  if (customerId == null) return; // 新規登録なら輪にはならない

  // 指定した親をたどって自分に戻ってくるなら輪になる
  const ancestors = lineage(db, parentId);
  if (ancestors.some((c) => Number(c.id) === Number(customerId))) {
    throw new BusinessRuleError(
      `「${parent.name}」を本店にすると本店と支店が輪になります（この得意先が既に上位にあります）`
    );
  }
}

/** 名前から得意先を引く（CSV取り込み・画面の入力補助用） */
function findIdByName(name, db = getConnection()) {
  const { normalizeName } = require('../utils/normalizeName');
  if (isBlank(name)) return null;
  const target = normalizeName(name);
  const row = db
    .prepare('SELECT id, name FROM customers')
    .all()
    .find((c) => normalizeName(c.name) === target);
  return row ? row.id : null;
}

module.exports = {
  INHERITED_COLUMNS,
  resolveBilling,
  rootCustomer,
  familyIds,
  assertValidParent,
  findIdByName,
  lineage,
};
