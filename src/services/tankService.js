// タンク間の移動まわりの業務ロジック
// （旧GASの submitTankTransfer / submitTaxFreeTransfer 相当）。
//
// 浄酎容器変動履歴（tank_ledger）は to_tank_id を加算・from_tank_id を減算として
// 集計するため（3章 v_tank_monitor）、受払の種類ごとにどちらの列を埋めるかが決まる：
//   容器移動   : from と to の両方（タンク間の付け替え）
//   未納税移出 : from のみ（社外へ出るので受入先タンクはない）
//   継足       : to のみ（蒸留完了時。distillationService側で記録）
//   瓶詰       : from のみ（bottlingService側で記録）

const { getConnection } = require('../db/connection');
const { today } = require('../utils/dateUtil');
const { NotFoundError, BusinessRuleError } = require('../utils/errors');

function getTank(db, id, label) {
  const tank = db.prepare('SELECT * FROM tanks WHERE id = ?').get(id);
  if (!tank) throw new NotFoundError(`${label}が見つかりません (id=${id})`);
  return tank;
}

function getVolume(db, tankId) {
  return db.prepare('SELECT * FROM v_tank_monitor WHERE tank_id = ?').get(tankId);
}

/**
 * 払出元の残量が足りるかを検査する（GAS版にはなかったガード）。
 */
function assertEnoughVolume(db, tank, quantityL) {
  const state = getVolume(db, tank.id);
  if (state && state.current_volume_l < quantityL) {
    throw new BusinessRuleError(
      `タンク残量が不足しています（${tank.name}: 残${state.current_volume_l}L < 払出${quantityL}L）`
    );
  }
}

/**
 * 受入先の容量に収まるかを検査する。
 * 最大容量が未登録のタンクは検査をスキップする。
 */
function assertCapacity(db, tank, quantityL) {
  if (tank.max_volume_l == null) return;
  const state = getVolume(db, tank.id);
  const after = (state?.current_volume_l ?? 0) + quantityL;
  if (after > tank.max_volume_l) {
    throw new BusinessRuleError(
      `受入先タンクの容量を超えます（${tank.name}: ${after}L > 最大${tank.max_volume_l}L）`
    );
  }
}

/**
 * 容器移動。タンクAからタンクBへ中身を移す。
 * 1行で from/to 両方を埋めるので、ビュー側では自動的に払出＋受入として集計される。
 */
function submitTankTransfer(input) {
  const db = getConnection();

  const run = db.transaction(() => {
    const txnDate = input.txnDate ?? today();

    if (input.fromTankId === input.toTankId) {
      throw new BusinessRuleError('移動元と移動先に同じタンクは指定できません');
    }

    const fromTank = getTank(db, input.fromTankId, '移動元タンク');
    const toTank = getTank(db, input.toTankId, '移動先タンク');

    assertEnoughVolume(db, fromTank, input.quantityL);
    assertCapacity(db, toTank, input.quantityL);

    // 度数の指定がなければ移動元の理論度数を引き継ぐ
    const abv = input.abv ?? fromTank.current_abv ?? null;

    const result = db
      .prepare(
        `INSERT INTO tank_ledger
           (txn_date, from_tank_id, txn_type, product_id, to_tank_id, quantity_l, abv,
            data_kind, note)
         VALUES
           (@txnDate, @fromTankId, '容器移動', NULL, @toTankId, @quantityL, @abv,
            '運用中（リアルタイム）', @note)`
      )
      .run({
        txnDate,
        fromTankId: input.fromTankId,
        toTankId: input.toTankId,
        quantityL: input.quantityL,
        abv,
        note: input.note ?? null,
      });

    // 移動先の理論度数を、移動後の加重平均で更新する
    updateBlendedAbv(db, toTank.id, input.quantityL, abv);

    return {
      tankLedgerId: result.lastInsertRowid,
      from: { ...pickTank(fromTank), after: getVolume(db, fromTank.id) },
      to: { ...pickTank(toTank), after: getVolume(db, toTank.id) },
    };
  });

  return run();
}

/**
 * 未納税移出。社外（他の酒造場等）へ未納税のまま搬出する。
 * 受入先タンクは自社内にないので to_tank_id は NULL とし、搬出先は note に残す。
 */
function submitTaxFreeTransfer(input) {
  const db = getConnection();

  const run = db.transaction(() => {
    const txnDate = input.txnDate ?? today();
    const fromTank = getTank(db, input.fromTankId, '払出元タンク');

    assertEnoughVolume(db, fromTank, input.quantityL);

    const noteParts = [`搬出先: ${input.destination}`];
    if (input.note) noteParts.push(input.note);

    const result = db
      .prepare(
        `INSERT INTO tank_ledger
           (txn_date, from_tank_id, txn_type, product_id, to_tank_id, quantity_l, abv,
            data_kind, note)
         VALUES
           (@txnDate, @fromTankId, '未納税移出', NULL, NULL, @quantityL, @abv,
            '運用中（リアルタイム）', @note)`
      )
      .run({
        txnDate,
        fromTankId: input.fromTankId,
        quantityL: input.quantityL,
        abv: input.abv ?? fromTank.current_abv ?? null,
        note: noteParts.join(' / '),
      });

    return {
      tankLedgerId: result.lastInsertRowid,
      from: { ...pickTank(fromTank), after: getVolume(db, fromTank.id) },
      destination: input.destination,
    };
  });

  return run();
}

/**
 * 受入によって変化したタンクの理論アルコール度数を加重平均で更新する。
 * 現行システムの「加重平均で自動計算される度数」（4-13 G列）に相当する。
 *
 * 受入前の液量・度数と、受け入れた液量・度数から算出する。
 * どちらかの度数が不明な場合は更新せず、既存値をそのまま残す。
 */
function updateBlendedAbv(db, tankId, addedVolumeL, addedAbv) {
  if (addedAbv == null) return;

  const tank = db.prepare('SELECT * FROM tanks WHERE id = ?').get(tankId);
  const after = getVolume(db, tankId)?.current_volume_l ?? 0;
  const before = after - addedVolumeL;

  // 受入前が空、または元の度数が不明なら、受け入れた液の度数がそのままタンクの度数になる
  if (before <= 0 || tank.current_abv == null) {
    db.prepare('UPDATE tanks SET current_abv = ? WHERE id = ?').run(addedAbv, tankId);
    return;
  }

  const blended = (before * tank.current_abv + addedVolumeL * addedAbv) / after;
  db.prepare('UPDATE tanks SET current_abv = ? WHERE id = ?').run(
    Math.round(blended * 100) / 100,
    tankId
  );
}

function pickTank(tank) {
  return { id: tank.id, code: tank.code, name: tank.name };
}

/** タンクの入出庫履歴（浄酎容器変動履歴） */
function listLedger({ tankId, limit = 200 } = {}) {
  const db = getConnection();
  const where = tankId ? 'WHERE l.from_tank_id = @tankId OR l.to_tank_id = @tankId' : '';
  return db
    .prepare(
      `SELECT l.*, ft.name AS from_tank_name, tt.name AS to_tank_name,
              p.name AS product_name, d.distillation_code
       FROM tank_ledger l
       LEFT JOIN tanks ft ON ft.id = l.from_tank_id
       LEFT JOIN tanks tt ON tt.id = l.to_tank_id
       LEFT JOIN products p ON p.id = l.product_id
       LEFT JOIN distillations d ON d.id = l.distillation_id
       ${where}
       ORDER BY l.txn_date DESC, l.id DESC
       LIMIT @limit`
    )
    .all({ tankId, limit });
}

module.exports = { submitTankTransfer, submitTaxFreeTransfer, listLedger };
