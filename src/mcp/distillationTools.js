// 音声入力のコネクタ（MCP）から呼べる処理の中身。MCPの決まりごととは切り離してあり、
// テストからも直接呼べる。
//
// **登録は画面と同じ道を通す。** 名前をIDに直したあと、画面のAPIと同じ入力チェック
// （src/validators/distillationSchemas.js）を通し、同じサービス関数を呼ぶ。
// DBへ直接書いたり、チェックを省いたりしない。酒税の根拠になる数字なので、
// 画面から入れた場合と1円・0.1Lも変わってはいけない。
//
// ここに置くのは「開始」「投入の追加」「完了」と、その確認のための読み取りだけ。
// 取消・修正・削除はコネクタからはできない（画面で行う）。

const crypto = require('node:crypto');
const { getConnection } = require('../db/connection');
const distillationService = require('../services/distillationService');
const operationLogService = require('../services/operationLogService');
const { tankContentsKind, rawSakeTankSql, RESIDUE_TANK_PREFIX, computeTankAbv } = require('../services/tankService');
const { getMigrationState, migrationNotice } = require('../middlewares/migrationState');
const { today } = require('../utils/dateUtil');
const { startSchema, completeSchema, addDetailSchema } = require('../validators/distillationSchemas');
const {
  McpInputError,
  resolveTank,
  resolveDistillation,
  snapshotTanks,
  diffTanks,
  tankVolume,
  round3,
} = require('./tankLookup');
const { normalizePlannedDuration } = require('./plannedDuration');

/** 操作ログの一行目につける印。設定画面の操作ログで「音声入力から入った」と分かるように */
const VIA_LABEL = '【音声入力（MCP）経由】';

/** 度数が直近の平均からこれ以上離れていたら注意する（％ポイント） */
const ABV_DEVIATION_PT = 10;

/** 試し実行（preview）で巻き戻すための合図 */
const ROLLBACK = Symbol('preview-rollback');

/** undefined のキーを落とす。画面が送らない項目は、こちらも送らない（同じ入力にするため） */
function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function hashArgs(tool, input) {
  return crypto.createHash('sha256').update(JSON.stringify({ tool, input })).digest('hex');
}

function errorBody(err) {
  return compact({
    code: err.code ?? 'error',
    message: err.message,
    candidates: err.candidates,
    details: err.details,
  });
}

/**
 * 登録の共通の流れ。
 *
 * preview=true のとき：本番と同じサービス関数をトランザクションの中で実行し、
 *   結果を控えてから巻き戻す。**画面と同じチェックが必ず走り、何も保存されない。**
 * preview=false のとき：requestKey で二重登録を防ぎつつ、登録・操作ログ・
 *   requestKey の記録を1つのトランザクションで行う（どれかが失敗したら全部なかったことになる）。
 */
function executeWrite({ tool, schema, input, args, tankIds, ctx, run, warnings, log, record }) {
  const db = getConnection();

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new McpInputError('入力内容に誤りがあります', {
      code: 'validation_error',
      details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const valid = parsed.data;
  const before = snapshotTanks(db, tankIds);
  const notes = warnings(db, valid, before);

  if (args.preview) {
    let outcome = null;
    let failure = null;
    try {
      db.transaction(() => {
        const result = run(valid);
        outcome = { record: record(db, result), after: snapshotTanks(db, tankIds) };
        throw ROLLBACK;
      })();
    } catch (err) {
      if (err !== ROLLBACK) failure = err;
    }
    if (failure && !(failure.status && failure.status < 500)) throw failure; // サーバー側の故障はそのまま上げる

    return compact({
      preview: true,
      saved: false,
      wouldSucceed: !failure,
      error: failure ? errorBody(failure) : undefined,
      warnings: notes,
      input: valid,
      // 採番（蒸留コードなど）は試し実行の時点の見込み。本登録で変わることがある
      record: outcome?.record,
      tanks: diffTanks(before, outcome?.after),
    });
  }

  if (!getMigrationState().ok) throw new McpInputError(migrationNotice(), { code: 'migration_failed' });

  const requestKey = typeof args.requestKey === 'string' ? args.requestKey.trim() : '';
  if (!requestKey) {
    throw new McpInputError(
      'requestKey がありません。確認表ごとに一意の文字列を付けてください（同じ登録の二重送信を防ぐため）',
      { code: 'request_key_required' }
    );
  }
  const argsHash = hashArgs(tool, valid);

  return db.transaction(() => {
    const prior = db.prepare('SELECT * FROM mcp_requests WHERE request_key = ?').get(requestKey);
    if (prior) {
      if (prior.tool !== tool || prior.args_hash !== argsHash) {
        throw new McpInputError(
          `requestKey「${requestKey}」は別の内容の登録に使われています。新しい requestKey で送り直してください`,
          { code: 'request_key_conflict' }
        );
      }
      return { ...JSON.parse(prior.result_json), duplicate: true };
    }

    const result = run(valid);
    const payload = compact({
      saved: true,
      warnings: notes,
      record: record(db, result),
      tanks: diffTanks(before, snapshotTanks(db, tankIds)),
    });

    const entry = log(result, valid);
    operationLogService.record({
      user: ctx.actor,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      summary: `${VIA_LABEL}${entry.summary}`,
      detail: compact({ via: 'mcp', tool, requestKey, clientName: ctx.clientName }),
    });

    db.prepare(
      `INSERT INTO mcp_requests (request_key, tool, args_hash, user_id, result_json)
       VALUES (?, ?, ?, ?, ?)`
    ).run(requestKey, tool, argsHash, ctx.actor?.id ?? null, JSON.stringify(payload));

    return payload;
  })();
}

// --- 注意点（警告だけ。登録できるかどうかは画面と同じルールで決まる） ---

function isFuture(dateOnly) {
  return dateOnly > today();
}

function checkAbv(label, abv, out) {
  if (abv == null) return;
  if (!(abv > 0 && abv <= 100)) out.push(`${label}が ${abv}% です（0〜100% の範囲外）`);
}

function recentAverageAbv(db) {
  const rows = db
    .prepare(
      `SELECT output_abv FROM distillations
        WHERE status = '完了' AND output_abv IS NOT NULL
        ORDER BY completed_on DESC, id DESC LIMIT 10`
    )
    .all();
  if (!rows.length) return null;
  return rows.reduce((s, r) => s + r.output_abv, 0) / rows.length;
}

/** 原酒の投入（開始・追加）に共通の注意点 */
function inputWarnings(before, draws) {
  const out = [];
  for (const [tankId, drawL] of draws) {
    const t = before.get(tankId);
    if (!t) continue;
    if (t.kind !== '原酒') out.push(`${t.name}（${t.code}）は${t.kind}タンクです。原酒タンクではありません`);
    if (t.volumeL != null && drawL > t.volumeL) {
      out.push(`${t.name} の残量 ${t.volumeL}L より投入量 ${round3(drawL)}L が多いです`);
    }
  }
  return out;
}

function drawsByTank(items) {
  const draws = new Map();
  for (const item of items) draws.set(item.tankId, (draws.get(item.tankId) ?? 0) + item.volumeL);
  return draws;
}

// --- 登録 ---

/** 蒸留開始 */
function startDistillation(args, ctx) {
  const db = getConnection();
  const items = args.items.map((item, i) => ({
    tank: resolveTank(db, item.tank, { kind: '原酒', label: `投入する原酒${args.items.length > 1 ? `（${i + 1}行目）` : ''}のタンク` }),
    volumeL: item.volumeL,
    note: item.note?.trim() || undefined,
  }));
  const duration = normalizePlannedDuration(args.plannedDuration);

  // 画面（distillation.html の startForm）が送るのと同じ形にする
  const input = compact({
    startedOn: args.startedOn,
    startedTime: args.startedTime,
    items: items.map((i) => compact({ tankId: i.tank.id, volumeL: i.volumeL, note: i.note })),
    plannedDuration: duration.value,
  });

  return executeWrite({
    tool: 'start_distillation',
    schema: startSchema,
    input,
    args,
    tankIds: items.map((i) => i.tank.id),
    ctx,
    run: (valid) => distillationService.submitDistillationStart(valid),
    warnings: (_db, valid, before) => {
      const out = inputWarnings(before, drawsByTank(valid.items));
      if (valid.startedOn && isFuture(valid.startedOn)) out.push(`投入開始日 ${valid.startedOn} が未来の日付です`);
      if (!duration.recognized) out.push(`蒸留設定時間「${duration.value}」を時間として読めませんでした（そのまま保存します）`);
      return out;
    },
    log: (result) => ({
      action: 'mcp.distillation.start',
      targetType: 'distillations',
      targetId: result.distillationId,
      summary: `蒸留 ${result.distillationCode} を開始（${items
        .map((i) => `${i.tank.name} ${i.volumeL}L`)
        .join(' / ')}）`,
    }),
    record: (_db, result) => distillationService.findById(result.distillationId),
  });
}

/** 蒸留中の投入追加 */
function addDistillationInput(args, ctx) {
  const db = getConnection();
  const distillation = resolveDistillation(db, args.distillation);
  const tank = resolveTank(db, args.tank, { kind: '原酒', label: '投入元タンク' });

  // 画面（adForm）と同じ形
  const input = compact({ tankId: tank.id, volumeL: args.volumeL, note: args.note?.trim() || undefined });

  return executeWrite({
    tool: 'add_distillation_input',
    schema: addDetailSchema,
    input,
    args,
    tankIds: [tank.id],
    ctx,
    run: (valid) => distillationService.addDistillationDetailItem(distillation.id, valid, ctx.actor),
    warnings: (_db, valid, before) => {
      const out = inputWarnings(before, new Map([[valid.tankId, valid.volumeL]]));
      if (distillation.status !== '蒸留中') out.push(`${distillation.distillation_code} は${distillation.status}です（蒸留中ではありません）`);
      return out;
    },
    log: (result, valid) => ({
      action: 'mcp.distillation.addDetail',
      targetType: 'distillation_details',
      targetId: result.detailId,
      summary: `蒸留 ${distillation.distillation_code} に投入を追加（${tank.name} ${valid.volumeL}L）`,
    }),
    record: () => distillationService.findById(distillation.id),
  });
}

/** 完了報告（残渣回収・食塩を含む） */
function completeDistillation(args, ctx) {
  const db = getConnection();
  const distillation = resolveDistillation(db, args.distillation);
  const outputTank = resolveTank(db, args.outputTank, { kind: '浄酎', label: '払出先タンク' });

  // 画面（completeForm）と同じ形：残渣を記録するときは回収日時＝完了日時、
  // 食塩は「無」が既定で、「無」なら投入量0で確定させる
  let residue;
  let residueTank = null;
  if (args.residue) {
    residueTank = resolveTank(db, args.residue.destinationTank, { kind: '残渣', label: '残渣の払出先タンク' });
    const saltStatus = args.residue.saltStatus ?? '無';
    residue = compact({
      collectedOn: args.completedOn,
      collectedTime: args.completedTime,
      saltStatus,
      saltInputQty: saltStatus === '有' ? args.residue.saltInputQty ?? 0 : 0,
      quantity: args.residue.quantityL,
      abv: args.residue.abv,
      saltConcentration: args.residue.saltConcentration,
      destinationTankId: residueTank.id,
    });
  }

  const input = compact({
    completedOn: args.completedOn,
    completedTime: args.completedTime,
    outputTankId: outputTank.id,
    outputL: args.outputL,
    outputAbv: args.outputAbv,
    residue,
  });

  return executeWrite({
    tool: 'complete_distillation',
    schema: completeSchema,
    input,
    args,
    tankIds: [outputTank.id, ...(residueTank ? [residueTank.id] : [])],
    ctx,
    run: (valid) => distillationService.completeDistillation(distillation.id, valid),
    warnings: (wdb, valid, before) => {
      const out = [];
      const t = before.get(valid.outputTankId);
      if (distillation.status !== '蒸留中') out.push(`${distillation.distillation_code} は${distillation.status}です（蒸留中ではありません）`);
      if (t && t.kind !== '浄酎') out.push(`払出先 ${t.name}（${t.code}）は${t.kind}タンクです。浄酎タンクではありません`);
      if (t && t.maxVolumeL != null && (t.volumeL ?? 0) + valid.outputL > t.maxVolumeL) {
        out.push(`払出先 ${t.name} の最大液量 ${t.maxVolumeL}L を超えます（${t.volumeL ?? 0}L ＋ ${valid.outputL}L ＝ ${round3((t.volumeL ?? 0) + valid.outputL)}L）`);
      }
      if (valid.outputAbv == null) out.push('蒸留した液の度数が入っていません');
      checkAbv('蒸留した液の度数', valid.outputAbv, out);
      const avg = recentAverageAbv(wdb);
      if (valid.outputAbv != null && avg != null && Math.abs(valid.outputAbv - avg) > ABV_DEVIATION_PT) {
        out.push(`度数 ${valid.outputAbv}% が直近10件の平均 ${round3(avg)}% から ${ABV_DEVIATION_PT}ポイント以上離れています`);
      }
      if (distillation.total_input_l != null && valid.outputL > distillation.total_input_l) {
        out.push(`蒸留量 ${valid.outputL}L が投入量の合計 ${distillation.total_input_l}L より多いです`);
      }
      const started = `${distillation.started_on} ${distillation.started_time ?? '00:00'}`;
      const completed = `${valid.completedOn ?? today()} ${valid.completedTime ?? '23:59'}`;
      if (completed < started) out.push(`完了日時 ${completed} が投入開始日時 ${started} より前です`);
      if (valid.completedOn && isFuture(valid.completedOn)) out.push(`完了日 ${valid.completedOn} が未来の日付です`);
      if (valid.residue) {
        const r = valid.residue;
        if (r.quantity == null) out.push('残渣の回収量が入っていません');
        checkAbv('残渣の度数', r.abv, out);
        if (r.saltStatus === '有' && !(r.saltInputQty > 0)) out.push('食塩「有」ですが投入量(g)が入っていません');
        if (r.saltConcentration != null && !(r.saltConcentration >= 0 && r.saltConcentration <= 100)) {
          out.push(`塩分濃度が ${r.saltConcentration}% です（0〜100% の範囲外）`);
        }
      }
      return out;
    },
    log: (_result, valid) => ({
      action: 'mcp.distillation.complete',
      targetType: 'distillations',
      targetId: distillation.id,
      summary:
        `蒸留 ${distillation.distillation_code} を完了（${outputTank.name}へ ${valid.outputL}L` +
        `${valid.outputAbv != null ? `・${valid.outputAbv}%` : ''}` +
        `${residueTank ? `、残渣 ${valid.residue.quantity ?? '量未記入'}L→${residueTank.name}` : ''}）`,
    }),
    record: () => ({
      ...distillationService.findById(distillation.id),
      outputs: distillationService.listDistillationOutputs(distillation.id),
    }),
  });
}

// --- 読み取り ---

/** タンク一覧（種別・現在液量・度数・最大液量） */
function listTanks({ kind } = {}) {
  const db = getConnection();
  const abv = computeTankAbv(db);
  return db
    .prepare('SELECT * FROM tanks WHERE discarded_on IS NULL ORDER BY code')
    .all()
    .map((t) => ({
      id: t.id,
      code: t.code,
      name: t.name,
      kind: tankContentsKind(t),
      currentVolumeL: round3(tankVolume(db, t)),
      abv: abv.get(t.id) ?? t.current_abv ?? null,
      maxVolumeL: t.max_volume_l ?? null,
      status: t.status ?? null,
    }))
    .filter((t) => !kind || t.kind === kind)
    .map((t) => (t.kind === '残渣' ? { ...t, note: '残渣は回収累計（残量ではありません）' } : t));
}

/** 蒸留中の記録（投入明細つき） */
function listActiveDistillations() {
  const { rows } = distillationService.list({ status: '蒸留中', limit: 100, offset: 0 });
  return rows.map((row) => {
    const full = distillationService.findById(row.id);
    return {
      id: full.id,
      distillationCode: full.distillation_code,
      startedOn: full.started_on,
      startedTime: full.started_time,
      plannedDuration: full.planned_duration,
      totalInputL: full.total_input_l,
      inputs: full.details
        .filter((d) => !d.is_cancelled)
        .map((d) => ({ detailId: d.id, tankId: d.source_tank_id, tankName: d.source_tank_name, inputL: d.input_l, note: d.note })),
    };
  });
}

/** 蒸留記録1件の詳細（投入明細・完了情報・残渣・払出） */
function getDistillation({ distillation }) {
  const db = getConnection();
  const row = resolveDistillation(db, distillation);
  return {
    ...distillationService.findById(row.id),
    outputs: distillationService.listDistillationOutputs(row.id),
  };
}

/** 画面の選択肢に当たるもの */
function getDistillationOptions() {
  const db = getConnection();
  const pick = (t) => ({ id: t.id, code: t.code, name: t.name, currentVolumeL: round3(tankVolume(db, t)), maxVolumeL: t.max_volume_l ?? null });
  const live = db.prepare('SELECT * FROM tanks WHERE discarded_on IS NULL ORDER BY code').all();
  return {
    // 投入元：画面と同じく原酒の容器だけ（/api/raw-sake-receipts/tanks と同じ条件）
    inputTanks: db
      .prepare(`SELECT t.* FROM tanks t WHERE ${rawSakeTankSql('t')} AND t.discarded_on IS NULL ORDER BY t.code`)
      .all()
      .map(pick),
    // 払出先：画面は全タンクを出すが、ふつうは浄酎タンク
    outputTanks: live.filter((t) => tankContentsKind(t) === '浄酎').map(pick),
    residueTanks: live.filter((t) => typeof t.code === 'string' && t.code.startsWith(`${RESIDUE_TANK_PREFIX}-`)).map(pick),
    saltStatus: ['無', '有'],
    plannedDurationFormat: '「8時間」「8時間30分」の形で保存します（8h・480分・8時間半なども読み替えます）',
    // 一覧の絞り込みで使う払出先（/api/distillations/options と同じ）
    filterOptions: distillationService.listFilterOptions(),
  };
}

module.exports = {
  VIA_LABEL,
  startDistillation,
  addDistillationInput,
  completeDistillation,
  listTanks,
  listActiveDistillations,
  getDistillation,
  getDistillationOptions,
  errorBody,
};
