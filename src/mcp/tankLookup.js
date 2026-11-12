// 音声入力のコネクタ（MCP）で使う、タンク・蒸留記録の名前解決と液量の読み取り。
//
// 話し言葉では「タンク2」「原酒ポリ3」のように名前で言うので、IDに直してからサービスへ渡す。
// **1つに決まらないときは登録せず候補を返す。** 似た名前のタンクへ黙って入れると、
// 酒税の根拠になる液量がずれたまま気づけない。

const { normalizeName } = require('../utils/normalizeName');
const { tankContentsKind, computeTankAbv } = require('../services/tankService');

/** 利用者が直せる入力の誤り（候補つき）。ツールの結果としてそのまま返す */
class McpInputError extends Error {
  constructor(message, { code = 'invalid_input', candidates, details } = {}) {
    super(message);
    this.name = 'McpInputError';
    this.code = code;
    this.candidates = candidates;
    this.details = details;
  }
}

/** 比べるための形。全角半角・大文字小文字・空白の違いを無視する（「タンク 2」＝「タンク2」） */
function looseKey(value) {
  return normalizeName(String(value)).replace(/\s/g, '').toLowerCase();
}

function describeTank(tank) {
  return { id: tank.id, code: tank.code, name: tank.name, kind: tankContentsKind(tank) };
}

/**
 * タンクを1つに決める。
 *
 * @param {number|string} ref - ID（数値）または名前・容器ID
 * @param {object} opts
 * @param {'原酒'|'浄酎'|'残渣'} [opts.kind] - 同じ名前が複数あるとき、この種別を優先する
 * @param {string} opts.label - エラー文に出す呼び名（「投入元タンク」など）
 */
function resolveTank(db, ref, { kind, label }) {
  if (typeof ref === 'number') {
    const tank = db.prepare('SELECT * FROM tanks WHERE id = ?').get(ref);
    if (!tank) throw new McpInputError(`${label}が見つかりません (id=${ref})`, { code: 'tank_not_found' });
    return tank;
  }

  const tanks = db.prepare('SELECT * FROM tanks WHERE discarded_on IS NULL ORDER BY code').all();
  const exact = tanks.filter((t) => t.code === ref || t.name === ref);
  const key = looseKey(ref);
  const loose = tanks.filter((t) => looseKey(t.code) === key || looseKey(t.name) === key);
  const matches = exact.length ? exact : loose;

  if (kind && matches.length > 1) {
    const sameKind = matches.filter((t) => tankContentsKind(t) === kind);
    if (sameKind.length === 1) return sameKind[0];
  }
  if (matches.length === 1) return matches[0];

  if (matches.length > 1) {
    throw new McpInputError(`${label}「${ref}」に当てはまるタンクが複数あります。どれか指定してください`, {
      code: 'tank_ambiguous',
      candidates: matches.map(describeTank),
    });
  }

  const partial = tanks.filter((t) => looseKey(t.name).includes(key) || looseKey(t.code).includes(key));
  const ordered = kind
    ? [...partial.filter((t) => tankContentsKind(t) === kind), ...partial.filter((t) => tankContentsKind(t) !== kind)]
    : partial;
  throw new McpInputError(`${label}「${ref}」が見つかりません`, {
    code: 'tank_not_found',
    candidates: ordered.slice(0, 10).map(describeTank),
  });
}

/** 蒸留記録を ID（数値）または蒸留コード（D…）で1件に決める */
function resolveDistillation(db, ref) {
  const row =
    typeof ref === 'number'
      ? db.prepare('SELECT * FROM distillations WHERE id = ?').get(ref)
      : db
          .prepare('SELECT * FROM distillations WHERE distillation_code = ?')
          .get(normalizeName(String(ref)).replace(/\s/g, '').toUpperCase());
  if (!row) {
    throw new McpInputError(`蒸留記録「${ref}」が見つかりません`, {
      code: 'distillation_not_found',
      candidates: db
        .prepare(
          `SELECT id, distillation_code, started_on, started_time, input_summary
             FROM distillations WHERE status = '蒸留中' ORDER BY started_on DESC, id DESC`
        )
        .all(),
    });
  }
  return row;
}

/**
 * タンクの今の液量。**画面と同じ数え方**にするため、種別ごとに画面が使うビューを読む。
 *   原酒 … v_raw_sake_tank_volume（原酒タンク残量・蒸留の投入元と同じ）
 *   浄酎 … v_tank_monitor（タンクモニターと同じ）
 *   残渣 … v_residue_tank_collected の回収累計（残渣は払出の記録が無いので残量ではない）
 */
function tankVolume(db, tank) {
  const kind = tankContentsKind(tank);
  if (kind === '原酒') {
    return db.prepare('SELECT current_volume_l AS v FROM v_raw_sake_tank_volume WHERE tank_id = ?').get(tank.id)?.v ?? null;
  }
  if (kind === '残渣') {
    return db.prepare('SELECT collected_l AS v FROM v_residue_tank_collected WHERE tank_id = ?').get(tank.id)?.v ?? 0;
  }
  return db.prepare('SELECT current_volume_l AS v FROM v_tank_monitor WHERE tank_id = ?').get(tank.id)?.v ?? null;
}

function round3(value) {
  return value == null ? null : Number(Number(value).toFixed(3));
}

/** 指定したタンクの液量を控える。登録の前後で取って差を見せる */
function snapshotTanks(db, tankIds) {
  const abv = computeTankAbv(db);
  const out = new Map();
  for (const id of new Set(tankIds)) {
    const tank = db.prepare('SELECT * FROM tanks WHERE id = ?').get(id);
    if (!tank) continue;
    out.set(id, {
      ...describeTank(tank),
      volumeL: round3(tankVolume(db, tank)),
      abv: abv.get(id) ?? tank.current_abv ?? null,
      maxVolumeL: tank.max_volume_l ?? null,
    });
  }
  return out;
}

/** 前後の控えから「タンクの変化」の一覧を作る */
function diffTanks(before, after) {
  return [...before.values()].map((b) => {
    const a = after?.get(b.id);
    return {
      id: b.id,
      code: b.code,
      name: b.name,
      kind: b.kind,
      beforeL: b.volumeL,
      afterL: a ? a.volumeL : null,
      changeL: a && a.volumeL != null && b.volumeL != null ? round3(a.volumeL - b.volumeL) : null,
      afterAbv: a ? a.abv : null,
      maxVolumeL: b.maxVolumeL,
      note: b.kind === '残渣' ? '残渣タンクは回収累計（残量ではありません）' : undefined,
    };
  });
}

module.exports = {
  McpInputError,
  resolveTank,
  resolveDistillation,
  snapshotTanks,
  diffTanks,
  tankVolume,
  describeTank,
  round3,
};
