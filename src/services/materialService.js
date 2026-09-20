// 資材まわりの業務ロジック（旧GASの submitMaterialReceipt / getMaterialDefaultPrice 相当）。
//
// これまで資材は瓶詰め・箱詰めによる「消費」しか記録されず、入荷で増やす手段がなかった。
// 資材マスタの登録・編集もここで扱う。

const { getConnection } = require('../db/connection');
const { generateUid } = require('../utils/uid');
const { nextMaterialHistoryCode } = require('../utils/codeGenerator');
const { today } = require('../utils/dateUtil');
const { NotFoundError, BusinessRuleError, ConflictError } = require('../utils/errors');
const { round6, assertNotWorseNegative } = require('../utils/stockGuard');
const operationLogService = require('./operationLogService');

/**
 * 資材入荷。仕入れた資材を在庫に加える。
 *
 * かつては資材マスタの「ロット数」の倍数でないと 422 で断っていた
 * （DATA_STRUCTURE.md 4-18 F列「この数の倍数でのみ入荷登録できる」）。**この縛りは外した。**
 *
 * 理由は、縛りが運用実態と最初から合っていなかったこと。
 * 移行した入荷38件のうち8件がロット数の倍数から外れており、
 * 正規の発注先である酒井硝子からの分も含まれている
 * （700mlガラス瓶 36本／ロット15、ガラス栓 267個／ロット48）。
 * 取り込みは台帳へ直接入れるためサービスを通らず、この8件は縛りをすり抜けていた。
 * 実際には正規ルート以外（ナオライ神石高原など）からの仕入れも入る。
 *
 * ロット数そのものも厳密な発注単位ではない。シートのセルには「500（3000）」のような
 * 注記付きの値があり（scripts/loaders/materials.js の parseNumberLoose）、
 * シートN列「単価×ロット数(円)」＝1ロットあたりの金額の計算に使う「1ロットの入り数」に近い。
 *
 * そのため lot_size は残し、**発注の目安として画面に出すだけ**にしている
 * （getReceiptDefaults が返す）。入荷数は縛らないし、警告も出さない。
 */
function submitMaterialReceipt(input, actor = null) {
  const db = getConnection();

  const run = db.transaction(() => {
    const txnDate = input.txnDate ?? today();

    const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(input.materialId);
    if (!material) throw new NotFoundError(`資材が見つかりません (id=${input.materialId})`);

    // 単価の指定がなければ資材マスタの基準単価を使う
    const unitPrice = input.unitPrice ?? material.unit_price ?? null;
    const totalPrice =
      input.totalPrice ?? (unitPrice != null ? unitPrice * input.quantity : null);

    const result = db
      .prepare(
        `INSERT INTO material_stock_ledger
           (history_code, txn_date, material_id, txn_type, quantity, counterparty,
            unit_price, total_price, data_kind, note, created_by)
         VALUES
           (@historyCode, @txnDate, @materialId, '入荷', @quantity, @counterparty,
            @unitPrice, @totalPrice, '運用中（リアルタイム）', @note, @createdBy)`
      )
      .run({
        historyCode: nextMaterialHistoryCode(db, txnDate),
        txnDate,
        materialId: input.materialId,
        quantity: input.quantity,
        counterparty: input.supplier ?? material.supplier_name ?? null,
        unitPrice,
        totalPrice,
        note: input.note ?? null,
        createdBy: actor?.id ?? null,
      });

    const after = db
      .prepare('SELECT * FROM v_material_stock WHERE material_id = ?')
      .get(input.materialId);

    operationLogService.record({
      user: actor,
      action: 'material.receipt',
      targetType: 'material_stock_ledger',
      targetId: result.lastInsertRowid,
      summary: `${material.name} を ${input.quantity}${material.unit ?? ''} 入荷（在庫 ${after.current_stock}）`,
    });

    return { ledgerId: result.lastInsertRowid, material: pick(material), after };
  });

  return run();
}

/** 入荷画面で単価・ロット数を自動表示するための情報（旧 getMaterialDefaultPrice） */
function getReceiptDefaults(materialId) {
  const db = getConnection();
  const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(materialId);
  if (!material) throw new NotFoundError(`資材が見つかりません (id=${materialId})`);

  const stock = db.prepare('SELECT * FROM v_material_stock WHERE material_id = ?').get(materialId);

  return {
    material: pick(material),
    unitPrice: material.unit_price,
    lotSize: material.lot_size,
    unit: material.unit,
    supplierName: material.supplier_name,
    leadTimeDays: material.lead_time_days,
    currentStock: stock?.current_stock ?? 0,
    properStockQty: material.proper_stock_qty,
  };
}

function createMaterial(input, actor = null) {
  const db = getConnection();

  const name = (input.name ?? '').trim();
  if (!name) throw new BusinessRuleError('資材名を入力してください');
  if (db.prepare('SELECT id FROM materials WHERE name = ?').get(name)) {
    throw new BusinessRuleError(`資材「${name}」は既に登録されています`);
  }

  const result = db
    .prepare(
      `INSERT INTO materials
         (uid, code, name, category, unit, unit_price, lot_size, proper_stock_qty,
          initial_stock, supplier_name, supplier_address, supplier_contact, lead_time_days, note)
       VALUES
         (@uid, @code, @name, @category, @unit, @unitPrice, @lotSize, @properStockQty,
          @initialStock, @supplierName, @supplierAddress, @supplierContact, @leadTimeDays, @note)`
    )
    .run({
      uid: generateUid(db, 'materials'),
      code: input.code ?? null,
      name,
      category: input.category ?? null,
      unit: input.unit ?? null,
      unitPrice: input.unitPrice ?? null,
      lotSize: input.lotSize ?? null,
      properStockQty: input.properStockQty ?? null,
      initialStock: input.initialStock ?? 0,
      supplierName: input.supplierName ?? null,
      supplierAddress: input.supplierAddress ?? null,
      supplierContact: input.supplierContact ?? null,
      leadTimeDays: input.leadTimeDays ?? null,
      note: input.note ?? null,
    });

  operationLogService.record({
    user: actor,
    action: 'material.create',
    targetType: 'materials',
    targetId: result.lastInsertRowid,
    summary: `資材「${name}」を登録`,
  });

  return findById(result.lastInsertRowid);
}

function updateMaterial(id, input, actor = null) {
  const db = getConnection();
  if (!findById(id)) return null;

  db.prepare(
    `UPDATE materials SET
       code = COALESCE(@code, code),
       name = COALESCE(@name, name),
       category = COALESCE(@category, category),
       unit = COALESCE(@unit, unit),
       unit_price = COALESCE(@unitPrice, unit_price),
       lot_size = COALESCE(@lotSize, lot_size),
       proper_stock_qty = COALESCE(@properStockQty, proper_stock_qty),
       supplier_name = COALESCE(@supplierName, supplier_name),
       supplier_address = COALESCE(@supplierAddress, supplier_address),
       supplier_contact = COALESCE(@supplierContact, supplier_contact),
       lead_time_days = COALESCE(@leadTimeDays, lead_time_days),
       note = COALESCE(@note, note),
       updated_at = datetime('now')
     WHERE id = @id`
  ).run({
    id,
    code: input.code ?? null,
    name: input.name ?? null,
    category: input.category ?? null,
    unit: input.unit ?? null,
    unitPrice: input.unitPrice ?? null,
    lotSize: input.lotSize ?? null,
    properStockQty: input.properStockQty ?? null,
    supplierName: input.supplierName ?? null,
    supplierAddress: input.supplierAddress ?? null,
    supplierContact: input.supplierContact ?? null,
    leadTimeDays: input.leadTimeDays ?? null,
    note: input.note ?? null,
  });

  operationLogService.record({
    user: actor,
    action: 'material.update',
    targetType: 'materials',
    targetId: id,
    summary: `資材（id=${id}）を編集`,
  });

  return findById(id);
}

/**
 * 並べ替えに使ってよい列。
 *
 * 画面から来た文字列をそのままSQLに入れると、何でも実行できてしまう。
 * ここに載っている名前だけを通し、それ以外は既定に落とす
 * （ledgerCancelService.SORTABLE と同じ作法）。
 */
const LEDGER_SORTABLE = {
  txn_date: 'l.txn_date',
  history_code: 'l.history_code',
  txn_type: 'l.txn_type',
  material_name: 'm.name',
  quantity: 'l.quantity',
  total_price: 'l.total_price',
  counterparty: 'l.counterparty',
  is_cancelled: 'l.is_cancelled',
};
const LEDGER_DEFAULT_SORT = 'txn_date';

/**
 * 資材の入出庫履歴。
 *
 * 瓶詰め・箱詰めに紐付く消費は `product_history_code` が入る。
 * 画面はこれを見て「ここからは直せない。瓶詰め・箱詰めタブへ」と案内する。
 *
 * **以前は既定200件で切れており、実データ205件のうち5件が画面に出ていなかった**
 * （サービスの既定値・APIの既定値・画面がlimitを送っていないこと、の3つが重なっていた。
 *  瓶詰めタブで同じことが起きたのと同じ形）。
 * total を返してページ送りできるようにする。
 *
 * @returns {{rows: object[], total: number}} total は同じ絞り込みでの全件数
 */
function listLedger({
  materialId,
  limit = 200,
  offset = 0,
  sort = LEDGER_DEFAULT_SORT,
  order = 'desc',
  txnType = null,
  counterparty = null,
  cancelled = null,
  from = null,
  to = null,
} = {}) {
  const db = getConnection();

  const where = [];
  const params = {};

  if (materialId) {
    where.push('l.material_id = @materialId');
    params.materialId = materialId;
  }
  if (txnType) {
    where.push('l.txn_type = @txnType');
    params.txnType = txnType;
  }
  if (counterparty) {
    where.push('l.counterparty LIKE @counterparty');
    params.counterparty = `%${counterparty}%`;
  }
  if (cancelled !== null) {
    where.push('l.is_cancelled = @cancelled');
    params.cancelled = cancelled ? 1 : 0;
  }
  if (from) {
    where.push('l.txn_date >= @from');
    params.from = from;
  }
  if (to) {
    where.push('l.txn_date <= @to');
    params.to = to;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const column = LEDGER_SORTABLE[sort] ?? LEDGER_SORTABLE[LEDGER_DEFAULT_SORT];
  const direction = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // 同じ値のときの並びが実行のたびに変わらないよう、idを第2キーにする
  const orderSql = `${column} ${direction}, l.id ${direction}`;

  const { total } = db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM material_stock_ledger l
       JOIN materials m ON m.id = l.material_id
       ${whereSql}`
    )
    .get(params);

  const rows = db
    .prepare(
      `SELECT l.*, m.name AS material_name, m.unit,
              b.history_code AS product_history_code, b.txn_type AS product_txn_type
       FROM material_stock_ledger l
       JOIN materials m ON m.id = l.material_id
       LEFT JOIN product_stock_ledger b ON b.id = l.product_ledger_id
       ${whereSql}
       ORDER BY ${orderSql}
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset });

  return { rows, total };
}

// ---------------------------------------------------------------------------
// 入出庫履歴の取り消しと編集
//
// 瓶詰め・箱詰めに入れたもの（PR #35）と同じ形。取り消しは is_cancelled を立てるだけで、
// 数量は書き戻さない（v_material_stock が取消済みの行を0として数えるため、
// フラグを立てれば在庫は自動で戻る。二重に戻す事故が起きない）。
// 編集は台帳の行そのものを書き換える。**履歴IDは変えない**（番号はロットの名前で、
// 外から参照されている。月をまたぐ日付に直しても M2608- のまま）。
// ---------------------------------------------------------------------------

/** 編集で直せる区分。区分そのものは直せない（別の記録になるので取り消して入れ直す） */
const OPERABLE_TXN_TYPES = ['入荷', '消費', '棚卸調整', '欠損'];

/** 棚卸が入れた行。数量を直すと備考の「理論→実測」と食い違うので、直した跡を残す */
const STOCKTAKING_TXN_TYPES = ['棚卸調整', '欠損'];

function materialStockOf(db, materialId) {
  return (
    db.prepare('SELECT current_stock FROM v_material_stock WHERE material_id = ?').get(materialId)
      ?.current_stock ?? 0
  );
}

/**
 * 取り消し・編集の前に通す関門。
 *
 * 瓶詰め・箱詰めに紐付く消費をここから触らせないのが要点。
 * bottlingService.updateRecord は本数を変えたとき、紐付く資材の行を
 * **本数の比で引き直し、日付も一緒に動かす**。ここで直しても、次に瓶詰めの記録を
 * 編集した瞬間に黙って上書きされる。実データでは消費167件のうち153件がこれに当たる。
 */
function loadOperableRow(db, ledgerId, { forCancel }) {
  const row = db
    .prepare(
      `SELECT l.*, m.name AS material_name, m.unit,
              b.history_code AS product_history_code, b.txn_type AS product_txn_type
         FROM material_stock_ledger l
         JOIN materials m ON m.id = l.material_id
         LEFT JOIN product_stock_ledger b ON b.id = l.product_ledger_id
        WHERE l.id = ?`
    )
    .get(ledgerId);
  if (!row) throw new NotFoundError(`資材の入出庫履歴が見つかりません (id=${ledgerId})`);

  if (row.product_ledger_id != null) {
    // 出荷（段ボール）は受注タブ、瓶詰め・箱詰めは瓶詰めタブが親になる。
    // 親を指さないと、利用者が無いタブを探しに行くことになる
    const where = row.product_txn_type === '出荷'
      ? '受注タブでその受注の発送を取り消してください'
      : '瓶詰め・箱詰めタブでその記録を直してください';
    throw new BusinessRuleError(
      `${row.history_code} は ${row.product_history_code ?? '瓶詰め・箱詰め'}` +
        `（${row.product_txn_type ?? '作業'}）で消費した記録です。` +
        where +
        '（こちらで直しても、あちらを直したときに上書きされます）'
    );
  }

  if (!OPERABLE_TXN_TYPES.includes(row.txn_type)) {
    throw new BusinessRuleError(
      `${row.txn_type} は対象外です（対象: ${OPERABLE_TXN_TYPES.join('・')}）`
    );
  }

  if (row.is_cancelled) {
    throw new ConflictError(
      forCancel
        ? `${row.history_code} は既に取消済みです`
        : `${row.history_code} は取消済みです。直すなら、もう一度登録してください`
    );
  }

  return row;
}

/** 編集の画面に出す1件ぶんの中身 */
function getLedgerRecord(ledgerId) {
  const db = getConnection();
  const row = db
    .prepare(
      `SELECT l.*, m.name AS material_name, m.unit,
              b.history_code AS product_history_code, b.txn_type AS product_txn_type
         FROM material_stock_ledger l
         JOIN materials m ON m.id = l.material_id
         LEFT JOIN product_stock_ledger b ON b.id = l.product_ledger_id
        WHERE l.id = ?`
    )
    .get(ledgerId);
  if (!row) throw new NotFoundError(`資材の入出庫履歴が見つかりません (id=${ledgerId})`);

  return {
    row,
    currentStock: materialStockOf(db, row.material_id),
    linkedTo: row.product_ledger_id != null ? row.product_history_code : null,
  };
}

/**
 * 入出庫履歴の1行を直す。
 *
 * 直せる項目: 日付 / 数量 / 単価 / 相手先 / 備考
 * 直せない項目: 資材・区分。別の記録になるので、取り消して入れ直してもらう。
 */
function updateLedgerRecord(ledgerId, input, actor = null) {
  const db = getConnection();

  const run = db.transaction(() => {
    const row = loadOperableRow(db, ledgerId, { forCancel: false });
    const before = materialStockOf(db, row.material_id);

    const next = {
      txnDate: input.txnDate ?? row.txn_date,
      quantity: input.quantity ?? row.quantity,
      unitPrice: input.unitPrice !== undefined ? input.unitPrice : row.unit_price,
      counterparty: input.counterparty !== undefined ? input.counterparty : row.counterparty,
      note: input.note !== undefined ? input.note : row.note,
    };

    // 金額は単価×数量で引き直す。片方だけ直すと金額が合わなくなる
    const totalPrice = next.unitPrice != null ? round6(next.unitPrice * next.quantity) : null;

    // 棚卸の行は備考が「棚卸: 理論100 → 実測95」。数量だけ直すと備考が嘘になるので跡を残す
    let note = next.note;
    if (STOCKTAKING_TXN_TYPES.includes(row.txn_type) && next.quantity !== row.quantity) {
      note = `${note ? `${note} ` : ''}（編集: 数量 ${round6(row.quantity)} → ${round6(next.quantity)}）`;
    }

    db.prepare(
      `UPDATE material_stock_ledger
          SET txn_date = @txnDate, quantity = @quantity, unit_price = @unitPrice,
              total_price = @totalPrice, counterparty = @counterparty, note = @note,
              updated_at = datetime('now')
        WHERE id = @id`
    ).run({ ...next, totalPrice, note, id: ledgerId });

    const after = materialStockOf(db, row.material_id);
    assertNotWorseNegative(`${row.material_name}の在庫`, before, after);

    // 台帳の行が書き換わるので、元の値は操作ログにしか残らない
    const changes = {};
    const fields = [
      ['txn_date', 'txnDate', row.txn_date, next.txnDate],
      ['quantity', 'quantity', row.quantity, next.quantity],
      ['unit_price', 'unitPrice', row.unit_price, next.unitPrice],
      ['total_price', 'totalPrice', row.total_price, totalPrice],
      ['counterparty', 'counterparty', row.counterparty, next.counterparty],
      ['note', 'note', row.note, note],
    ];
    for (const [column, , from, to] of fields) {
      if (from !== to) changes[column] = { from, to };
    }

    operationLogService.record({
      user: actor,
      action: 'material.ledger.update',
      targetType: 'material_stock_ledger',
      targetId: ledgerId,
      summary:
        `${row.history_code}（${row.txn_type} ${row.material_name}）を編集` +
        `／${Object.keys(changes).join('・') || '変更なし'}` +
        `／在庫 ${round6(before)} → ${round6(after)}${row.unit ?? ''}`,
      detail: { changes, stockBefore: before, stockAfter: after },
    });

    return {
      ledgerId,
      historyCode: row.history_code,
      txnType: row.txn_type,
      changes,
      row: db.prepare('SELECT * FROM material_stock_ledger WHERE id = ?').get(ledgerId),
      stock: db.prepare('SELECT * FROM v_material_stock WHERE material_id = ?').get(row.material_id),
    };
  });

  return run();
}

/** 入出庫履歴の1行を取り消す。理由は必須。行は消さずに残る */
function cancelLedgerRecord(ledgerId, { reason } = {}, actor = null) {
  const db = getConnection();
  if (!reason || !String(reason).trim()) {
    throw new BusinessRuleError('取消理由は必須です');
  }

  const run = db.transaction(() => {
    const row = loadOperableRow(db, ledgerId, { forCancel: true });
    const before = materialStockOf(db, row.material_id);

    db.prepare(
      `UPDATE material_stock_ledger
          SET is_cancelled = 1, cancel_reason = @reason, cancelled_at = datetime('now'),
              cancelled_by = @by, updated_at = datetime('now')
        WHERE id = @id`
    ).run({ reason: String(reason).trim(), by: actor?.id ?? null, id: ledgerId });

    const after = materialStockOf(db, row.material_id);

    operationLogService.record({
      user: actor,
      action: 'material.ledger.cancel',
      targetType: 'material_stock_ledger',
      targetId: ledgerId,
      summary:
        `${row.history_code}（${row.txn_type} ${row.material_name} ${round6(row.quantity)}${row.unit ?? ''}）を取消` +
        `／在庫 ${round6(before)} → ${round6(after)}${row.unit ?? ''}` +
        `／理由: ${String(reason).trim()}`,
      detail: { stockBefore: before, stockAfter: after, reason: String(reason).trim() },
    });

    return {
      cancelled: db.prepare('SELECT * FROM material_stock_ledger WHERE id = ?').get(ledgerId),
      material: { id: row.material_id, name: row.material_name, unit: row.unit },
      stock: db.prepare('SELECT * FROM v_material_stock WHERE material_id = ?').get(row.material_id),
    };
  });

  return run();
}

function findById(id) {
  const db = getConnection();
  return db.prepare('SELECT * FROM materials WHERE id = ?').get(id);
}

function pick(material) {
  return { id: material.id, name: material.name, unit: material.unit };
}

module.exports = {
  submitMaterialReceipt,
  getReceiptDefaults,
  createMaterial,
  updateMaterial,
  listLedger,
  getLedgerRecord,
  updateLedgerRecord,
  cancelLedgerRecord,
  findById,
  OPERABLE_TXN_TYPES,
};
