// 瓶詰め・箱詰めの業務ロジック（旧GASの submitBottlingV2 / submitBoxing 相当）。
//
// この2機能は「1操作で複数台帳へ書き込む」典型例（DATA_STRUCTURE.md 5章）：
//   瓶詰め: 商品在庫変動履歴（瓶詰＝仕掛品+）／資材在庫変動履歴（レシピ消費）／浄酎容器変動履歴（タンク-）
//   箱詰め: 商品在庫変動履歴（箱詰＝仕掛品-・商品+）／資材在庫変動履歴（レシピ消費）
// GAS版はシートごとに順次appendRowしていたため途中で失敗すると不整合が残ったが、
// ここではSQLiteのトランザクションで全書き込みをまとめ、失敗時は全部ロールバックする。

const { getConnection } = require('../db/connection');
const wipLotService = require('./wipLotService');
const operationLogService = require('./operationLogService');
const { nextProductHistoryCode, nextMaterialHistoryCode } = require('../utils/codeGenerator');
const { today } = require('../utils/dateUtil');
const { NotFoundError, BusinessRuleError, ConflictError } = require('../utils/errors');

/**
 * 指定商品・工程のレシピを取得する（旧 getRecipeForProduct_）
 */
function getRecipe(db, productId, process) {
  return db
    .prepare(
      `SELECT r.*, m.name AS material_name
       FROM product_recipes r
       JOIN materials m ON m.id = r.material_id
       WHERE r.product_id = ? AND r.process = ?`
    )
    .all(productId, process);
}

/**
 * レシピに基づいて資材消費行を資材在庫変動履歴へ追加する。
 * どの瓶詰め/箱詰め作業による消費かを product_ledger_id で紐付ける（4-17 H列相当）。
 */
function consumeRecipeMaterials(db, { productId, quantity, process, txnDate, productLedgerId }) {
  const recipe = getRecipe(db, productId, process);
  const consumed = [];

  const stmt = db.prepare(
    `INSERT INTO material_stock_ledger
       (history_code, txn_date, material_id, txn_type, quantity, product_ledger_id, data_kind, note)
     VALUES
       (@historyCode, @txnDate, @materialId, '消費', @quantity, @productLedgerId,
        '運用中（リアルタイム）', @note)`
  );

  for (const item of recipe) {
    const consumeQty = item.qty_required * quantity;
    const result = stmt.run({
      historyCode: nextMaterialHistoryCode(db, txnDate),
      txnDate,
      materialId: item.material_id,
      quantity: consumeQty,
      productLedgerId,
      note: `${process}による自動消費`,
    });
    consumed.push({
      materialId: item.material_id,
      materialName: item.material_name,
      quantity: consumeQty,
      ledgerId: result.lastInsertRowid,
    });
  }

  return consumed;
}

/**
 * 瓶詰め登録。タンクから液を抜いて仕掛品を作る。
 *
 * @param {object} input
 * @param {number} input.productId
 * @param {number} input.quantity   - 瓶詰めした本数
 * @param {number} input.tankId     - 払出元タンク
 * @param {number} input.volumeL    - タンクから減らす量(L)
 * @param {string} [input.txnDate]  - 作業日（YYYY-MM-DD、既定は今日）
 * @param {number} [input.abv]      - 度数
 */
function submitBottling(input) {
  const db = getConnection();

  const run = db.transaction(() => {
    const txnDate = input.txnDate ?? today();

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(input.productId);
    if (!product) throw new NotFoundError(`商品が見つかりません (id=${input.productId})`);

    const tank = db.prepare('SELECT * FROM tanks WHERE id = ?').get(input.tankId);
    if (!tank) throw new NotFoundError(`タンクが見つかりません (id=${input.tankId})`);

    // 1) 商品在庫変動履歴（瓶詰＝仕掛品の増加）
    const historyCode = nextProductHistoryCode(db, txnDate);
    const productLedgerResult = db
      .prepare(
        `INSERT INTO product_stock_ledger
           (history_code, txn_date, product_id, txn_type, quantity, counterparty,
            storage_place, data_kind, note)
         VALUES
           (@historyCode, @txnDate, @productId, '瓶詰', @quantity, @counterparty,
            @storagePlace, '運用中（リアルタイム）', @note)`
      )
      .run({
        historyCode,
        txnDate,
        productId: input.productId,
        quantity: input.quantity,
        counterparty: tank.name,
        storagePlace: input.storagePlace ?? '浄溜所',
        note: input.note ?? null,
      });
    const productLedgerId = productLedgerResult.lastInsertRowid;

    // 2) 資材在庫変動履歴（レシピに基づく消費）
    const consumedMaterials = consumeRecipeMaterials(db, {
      productId: input.productId,
      quantity: input.quantity,
      process: '瓶詰',
      txnDate,
      productLedgerId,
    });

    // 3) 浄酎容器変動履歴（タンクからの払出）
    const tankLedgerResult = db
      .prepare(
        `INSERT INTO tank_ledger
           (txn_date, from_tank_id, txn_type, product_id, to_tank_id, quantity_l, abv,
            product_ledger_id, data_kind, note)
         VALUES
           (@txnDate, @fromTankId, '瓶詰', @productId, NULL, @quantityL, @abv,
            @productLedgerId, '運用中（リアルタイム）', @note)`
      )
      .run({
        txnDate,
        fromTankId: input.tankId,
        productId: input.productId,
        quantityL: input.volumeL,
        abv: input.abv ?? tank.current_abv ?? null,
        productLedgerId,
        note: input.note ?? null,
      });

    return {
      productLedgerId,
      historyCode,
      tankLedgerId: tankLedgerResult.lastInsertRowid,
      consumedMaterials,
      stock: db.prepare('SELECT * FROM v_product_stock WHERE product_id = ?').get(input.productId),
    };
  });

  return run();
}

/**
 * 箱詰め登録。仕掛品を完成品に振り替える（在庫の増減方向はv_product_stockのCASE式が担う）。
 */
function submitBoxing(input) {
  const db = getConnection();

  const run = db.transaction(() => {
    const txnDate = input.txnDate ?? today();

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(input.productId);
    if (!product) throw new NotFoundError(`商品が見つかりません (id=${input.productId})`);

    // どの瓶詰めロットから引くかを先に決める。
    // ロットを指定された場合はそれを優先し、足りない分は古いロットから補う
    // （GAS版と同じ挙動。指定なしなら純粋なFIFO）。
    const allocations = wipLotService.allocate(db, {
      productId: input.productId,
      quantity: input.quantity,
      preferredLotId: input.lotLedgerId ?? null,
    });

    const historyCode = nextProductHistoryCode(db, txnDate);
    const productLedgerResult = db
      .prepare(
        `INSERT INTO product_stock_ledger
           (history_code, txn_date, product_id, txn_type, quantity,
            storage_place, data_kind, note)
         VALUES
           (@historyCode, @txnDate, @productId, '箱詰', @quantity,
            @storagePlace, '運用中（リアルタイム）', @note)`
      )
      .run({
        historyCode,
        txnDate,
        productId: input.productId,
        quantity: input.quantity,
        storagePlace: input.storagePlace ?? '浄溜所',
        note: input.note ?? null,
      });
    const productLedgerId = productLedgerResult.lastInsertRowid;

    wipLotService.saveAllocations(db, productLedgerId, allocations);

    const consumedMaterials = consumeRecipeMaterials(db, {
      productId: input.productId,
      quantity: input.quantity,
      process: '箱詰',
      txnDate,
      productLedgerId,
    });

    return {
      productLedgerId,
      historyCode,
      allocations,
      consumedMaterials,
      stock: db.prepare('SELECT * FROM v_product_stock WHERE product_id = ?').get(input.productId),
    };
  });

  return run();
}

// ---------------------------------------------------------------------------
// 記録そのものを直す（日付・本数・数量(L)・度数・保管場所・備考）
//
// これまで、間違えた瓶詰め・箱詰めを直す手段は「取り消して入れ直す」だけだった。
// 日付を1日ずらすためだけに入れ直すと、履歴IDが新しい番号に変わってしまう。
//
// **ここは台帳を書き換える。** PR5（蒸留の投入明細）が
// 「取り消して入れ直す」だったのと逆の判断で、理由は履歴IDにある。
// 瓶詰めの history_code（L2607-0072 のような番号）は**ロットの名前**で、
// 箱詰め行の counterparty に文字で書かれていたり、現場の記録に残っていたりする。
// 入れ直すと番号が変わり、その参照が全部ずれる。
// 蒸留の明細にはそういう外からの参照が無いので、あちらは入れ直せた。
//
// 書き換える代わりに、変更前と変更後を操作ログに残す。
// ---------------------------------------------------------------------------

/** 直せるのは瓶詰めと箱詰めだけ。出荷・返品は受注や送り状と繋がっているので対象外 */
const EDITABLE_TXN_TYPES = ['瓶詰', '箱詰'];

/** 浮動小数のごみ（45 * (50/45) が 50.00000000000001 になるような）を落とす */
function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function productStockOf(db, productId) {
  return (
    db
      .prepare('SELECT product_stock, wip_stock FROM v_product_stock WHERE product_id = ?')
      .get(productId) ?? { product_stock: 0, wip_stock: 0 }
  );
}

function tankVolumeOf(db, tankId) {
  if (tankId == null) return null;
  return db.prepare('SELECT name, current_volume_l FROM v_tank_monitor WHERE tank_id = ?').get(tankId);
}

/**
 * 直した結果、在庫が**前より悪化して**マイナスになっていないか。書き込んだあとに確かめる。
 *
 * 「0以上であること」を条件にしていないのは、移行した実データに既にマイナスの
 * ものがあるため（出荷用ポリタンク3 が -13.2L、出荷用ポリ13 が -10L）。
 * そこに触る修正まで断ってしまうと、移行データを直すための機能なのに直せなくなる。
 * 前より悪くしないことだけを条件にする。
 */
function assertNotWorseNegative(label, before, after) {
  if (after < 0 && after < before) {
    throw new BusinessRuleError(
      `${label}が ${round6(after)} になります（いまは ${round6(before)}）。この直し方はできません`
    );
  }
}

/** 直すときに画面へ出す1件ぶんの中身（本体＋資材消費＋タンク移動＋引当済み本数） */
function getRecord(ledgerId) {
  const db = getConnection();

  const row = db
    .prepare(
      `SELECT l.*, p.name AS product_name, p.code AS product_code
         FROM product_stock_ledger l
         JOIN products p ON p.id = l.product_id
        WHERE l.id = ?`
    )
    .get(ledgerId);
  if (!row) throw new NotFoundError(`記録が見つかりません (id=${ledgerId})`);

  const materials = db
    .prepare(
      `SELECT m.id, m.history_code, m.txn_date, m.quantity, m.is_cancelled, mt.name AS material_name
         FROM material_stock_ledger m
         JOIN materials mt ON mt.id = m.material_id
        WHERE m.product_ledger_id = ?
        ORDER BY m.id`
    )
    .all(ledgerId);

  const tanks = db
    .prepare(
      `SELECT t.id, t.txn_date, t.from_tank_id, t.quantity_l, t.abv, t.is_cancelled,
              tk.name AS tank_name, tk.code AS tank_code
         FROM tank_ledger t
         LEFT JOIN tanks tk ON tk.id = t.from_tank_id
        WHERE t.product_ledger_id = ?
        ORDER BY t.id`
    )
    .all(ledgerId);

  // 瓶詰めなら「この瓶詰めから箱詰めに使われた本数」、箱詰めなら「引き当てた本数」
  const allocated =
    row.txn_type === '瓶詰'
      ? db
          .prepare(
            `SELECT COALESCE(SUM(a.quantity), 0) AS n FROM wip_lot_allocations a
               JOIN product_stock_ledger b ON b.id = a.boxing_ledger_id
              WHERE a.bottling_ledger_id = ? AND b.is_cancelled = 0`
          )
          .get(ledgerId).n
      : db
          .prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM wip_lot_allocations WHERE boxing_ledger_id = ?')
          .get(ledgerId).n;

  return {
    row,
    materials,
    tanks,
    allocated,
    editable: EDITABLE_TXN_TYPES.includes(row.txn_type) && !row.is_cancelled,
  };
}

/**
 * 瓶詰め・箱詰めの記録を直す。
 *
 * 直せる項目: 日付 / 本数 / 数量(L)・度数（瓶詰めでタンクの行があるときだけ） /
 *             保管場所 / 備考
 * 直せない項目: 商品・区分・払出元タンク。これらを変えるのは別の作業を記録したのと
 *             同じなので、取り消して入れ直してもらう。
 *
 * 日付を変えると、この作業に紐付く資材消費とタンク移動の日付も一緒に動く
 * （同じ日の作業として記録されたものなので、片方だけ動くと辻褄が合わなくなる）。
 * **履歴IDは変えない。** 月をまたぐ日付に直しても L2607- のまま。番号はロットの名前で、
 * 外から参照されているため。
 */
function updateRecord(ledgerId, input, actor = null) {
  const db = getConnection();

  const run = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT l.*, p.name AS product_name FROM product_stock_ledger l
           JOIN products p ON p.id = l.product_id WHERE l.id = ?`
      )
      .get(ledgerId);
    if (!row) throw new NotFoundError(`記録が見つかりません (id=${ledgerId})`);
    if (!EDITABLE_TXN_TYPES.includes(row.txn_type)) {
      throw new ConflictError(
        `${row.history_code} は「${row.txn_type}」の記録です。` +
          `ここから直せるのは ${EDITABLE_TXN_TYPES.join('・')} だけです`
      );
    }
    if (row.is_cancelled) {
      throw new ConflictError(`${row.history_code} は取消済みです。直すなら、もう一度登録してください`);
    }

    const tankRows = db
      .prepare('SELECT * FROM tank_ledger WHERE product_ledger_id = ? AND is_cancelled = 0')
      .all(ledgerId);

    // 数量(L)と度数はタンクの行の中身。行が無ければ直しようがない。
    // 移行した瓶詰め26件のうち、タンクの行を持つのは5件だけ。
    const touchesTank = input.volumeL !== undefined || input.abv !== undefined;
    if (touchesTank) {
      if (row.txn_type !== '瓶詰') {
        throw new BusinessRuleError('数量(L)と度数を直せるのは瓶詰めだけです');
      }
      if (tankRows.length === 0) {
        throw new BusinessRuleError(
          `${row.history_code} にはタンクの記録がありません。数量(L)と度数は直せません`
        );
      }
      if (tankRows.length > 1) {
        throw new BusinessRuleError(
          `${row.history_code} にはタンクの記録が${tankRows.length}件あります。` +
            'どれを直すか決められないので、ここからは直せません'
        );
      }
    }
    const tankRow = tankRows.length === 1 ? tankRows[0] : null;

    const newQuantity = input.quantity ?? row.quantity;
    const newDate = input.txnDate ?? row.txn_date;

    // 本数を減らすとき、既に箱詰めと結び付いているぶんは割れない
    if (newQuantity !== row.quantity) {
      const { n: allocated } =
        row.txn_type === '瓶詰'
          ? db
              .prepare(
                `SELECT COALESCE(SUM(a.quantity), 0) AS n FROM wip_lot_allocations a
                   JOIN product_stock_ledger b ON b.id = a.boxing_ledger_id
                  WHERE a.bottling_ledger_id = ? AND b.is_cancelled = 0`
              )
              .get(ledgerId)
          : db
              .prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM wip_lot_allocations WHERE boxing_ledger_id = ?')
              .get(ledgerId);

      if (newQuantity < allocated) {
        throw new BusinessRuleError(
          row.txn_type === '瓶詰'
            ? `${row.history_code} は ${allocated} 本が箱詰めに使われています。` +
              `${newQuantity} 本には減らせません（先にその箱詰めを直してください）`
            : `${row.history_code} は瓶詰めロットから ${allocated} 本を引き当てています。` +
              `${newQuantity} 本に減らすなら、先に仕掛品ロットの紐付けを直してください`
        );
      }
    }

    const stockBefore = productStockOf(db, row.product_id);
    const tankBefore = tankRow ? tankVolumeOf(db, tankRow.from_tank_id) : null;

    db.prepare(
      `UPDATE product_stock_ledger
          SET txn_date = @txnDate, quantity = @quantity, storage_place = @storagePlace,
              note = @note, updated_at = datetime('now')
        WHERE id = @id`
    ).run({
      id: ledgerId,
      txnDate: newDate,
      quantity: newQuantity,
      storagePlace: input.storagePlace !== undefined ? input.storagePlace : row.storage_place,
      note: input.note !== undefined ? input.note : row.note,
    });

    // 本数を変えたら、この作業で消費した資材も同じ割合で直す。
    //
    // レシピから引き直さないのは、記録されている実績のほうが正しいから。
    // 実データの L2606-0010 は「紙垂（白）」を46枚消費しているが、いまのレシピに
    // その資材は入っていない。引き直すとこの行だけ置き去りになる。
    // 元が「レシピ×本数」で入っている行なら、比で直しても同じ数になる。
    let materialRowsScaled = 0;
    let materialsScaled = true;
    if (newQuantity !== row.quantity) {
      if (row.quantity === 0) {
        // 0で割れない。触らずに、直さなかったことを操作ログに残す
        materialsScaled = false;
      } else {
        const ratio = newQuantity / row.quantity;
        const mats = db
          .prepare(
            'SELECT id, quantity FROM material_stock_ledger WHERE product_ledger_id = ? AND is_cancelled = 0'
          )
          .all(ledgerId);
        const stmt = db.prepare(
          "UPDATE material_stock_ledger SET quantity = @q, updated_at = datetime('now') WHERE id = @id"
        );
        for (const m of mats) {
          stmt.run({ id: m.id, q: round6(m.quantity * ratio) });
          materialRowsScaled += 1;
        }
      }
    }

    // 日付は、紐付く資材消費とタンク移動も一緒に動かす
    let materialRowsMoved = 0;
    let tankRowsMoved = 0;
    if (newDate !== row.txn_date) {
      materialRowsMoved = db
        .prepare(
          "UPDATE material_stock_ledger SET txn_date = @d, updated_at = datetime('now') WHERE product_ledger_id = @id AND is_cancelled = 0"
        )
        .run({ d: newDate, id: ledgerId }).changes;
      tankRowsMoved = db
        .prepare(
          "UPDATE tank_ledger SET txn_date = @d, updated_at = datetime('now') WHERE product_ledger_id = @id AND is_cancelled = 0"
        )
        .run({ d: newDate, id: ledgerId }).changes;
    }

    if (tankRow && touchesTank) {
      db.prepare(
        "UPDATE tank_ledger SET quantity_l = @q, abv = @abv, updated_at = datetime('now') WHERE id = @id"
      ).run({
        id: tankRow.id,
        q: input.volumeL !== undefined ? input.volumeL : tankRow.quantity_l,
        abv: input.abv !== undefined ? input.abv : tankRow.abv,
      });
    }

    // 書き込んだあとで在庫を確かめる。悪化していたら全部やり直し（トランザクション）
    const stockAfter = productStockOf(db, row.product_id);
    assertNotWorseNegative('商品在庫', stockBefore.product_stock, stockAfter.product_stock);
    assertNotWorseNegative('仕掛品在庫', stockBefore.wip_stock, stockAfter.wip_stock);
    if (tankRow && tankBefore) {
      const tankAfter = tankVolumeOf(db, tankRow.from_tank_id);
      assertNotWorseNegative(
        `${tankBefore.name} の残量`,
        tankBefore.current_volume_l,
        tankAfter.current_volume_l
      );
    }

    // 変わった項目だけを、前後の値つきで控える
    const changes = {};
    const note = (v) => (v ?? null);
    if (newDate !== row.txn_date) changes.txnDate = { before: row.txn_date, after: newDate };
    if (newQuantity !== row.quantity) changes.quantity = { before: row.quantity, after: newQuantity };
    if (input.storagePlace !== undefined && input.storagePlace !== row.storage_place) {
      changes.storagePlace = { before: note(row.storage_place), after: input.storagePlace };
    }
    if (input.note !== undefined && input.note !== row.note) {
      changes.note = { before: note(row.note), after: input.note };
    }
    if (tankRow && input.volumeL !== undefined && input.volumeL !== tankRow.quantity_l) {
      changes.volumeL = { before: tankRow.quantity_l, after: input.volumeL };
    }
    if (tankRow && input.abv !== undefined && input.abv !== tankRow.abv) {
      changes.abv = { before: note(tankRow.abv), after: input.abv };
    }

    return {
      row,
      changes,
      materialsScaled,
      materialRowsScaled,
      materialRowsMoved,
      tankRowsMoved,
      stock: stockAfter,
    };
  });

  const result = run();
  const labels = {
    txnDate: '日付',
    quantity: '本数',
    volumeL: '数量(L)',
    abv: '度数',
    storagePlace: '保管場所',
    note: '備考',
  };
  const summaryParts = Object.entries(result.changes).map(
    ([key, v]) => `${labels[key] ?? key}: ${v.before ?? '(空)'} → ${v.after ?? '(空)'}`
  );

  operationLogService.record({
    user: actor,
    action: 'ledger.update',
    targetType: 'product_stock_ledger',
    targetId: ledgerId,
    summary:
      `${result.row.history_code}（${result.row.txn_type}）を直しました` +
      (summaryParts.length ? `／${summaryParts.join('、')}` : '／変更なし') +
      (result.materialRowsScaled ? `／資材${result.materialRowsScaled}件を同じ割合で調整` : '') +
      (result.materialsScaled ? '' : '／元の本数が0のため資材は調整していません'),
    // 直す前の値も残す。間違えたときに戻せるようにするため
    detail: {
      before: result.changes && Object.fromEntries(Object.entries(result.changes).map(([k, v]) => [k, v.before])),
      after: Object.fromEntries(Object.entries(result.changes).map(([k, v]) => [k, v.after])),
      materialRowsScaled: result.materialRowsScaled,
      materialRowsMoved: result.materialRowsMoved,
      tankRowsMoved: result.tankRowsMoved,
    },
  });

  return {
    ledgerId,
    historyCode: result.row.history_code,
    txnType: result.row.txn_type,
    changes: result.changes,
    materialsScaled: result.materialsScaled,
    materialRowsScaled: result.materialRowsScaled,
    materialRowsMoved: result.materialRowsMoved,
    tankRowsMoved: result.tankRowsMoved,
    stock: result.stock,
  };
}

module.exports = {
  submitBottling,
  submitBoxing,
  getRecipe,
  getRecord,
  updateRecord,
  EDITABLE_TXN_TYPES,
};
