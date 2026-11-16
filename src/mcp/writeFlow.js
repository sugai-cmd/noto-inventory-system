// 音声入力のコネクタ（MCP）から登録するときの共通の流れ。
//
// **登録は画面と同じ道を通す。** 名前をIDに直したあと、画面のAPIと同じ入力チェック
// （各ルートの zod スキーマ）を通し、同じサービス関数を呼ぶ。DBへ直接書いたり、
// チェックを省いたりしない。酒税・在庫の根拠になる数字なので、画面から入れた場合と
// 1円・0.1Lも変わってはいけない。
//
// preview=true のとき：本番と同じ処理をトランザクションの中で実行し、結果を控えてから
//   巻き戻す。**画面と同じチェックが必ず走り、何も保存されない。**
// preview=false のとき：requestKey で二重登録を防ぎつつ、登録・操作ログ・requestKey の
//   記録を1つのトランザクションで行う（どれかが失敗したら全部なかったことになる）。

const crypto = require('node:crypto');
const { getConnection } = require('../db/connection');
const operationLogService = require('../services/operationLogService');
const { getMigrationState, migrationNotice } = require('../middlewares/migrationState');
const { constraintMessage } = require('../middlewares/errorHandler');
const { McpInputError } = require('./tankLookup');

/** 操作ログの一行目につける印。設定画面の操作ログで「音声入力から入った」と分かるように */
const VIA_LABEL = '【音声入力（MCP）経由】';

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
 * SQLite の制約違反（同じ名前の登録など）を、利用者が直せる誤りとして扱う。
 * そのままだとサーバーの故障に見えてしまう。
 */
function asUserError(err) {
  if (typeof err?.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
    const message =
      err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY'
        ? '指定した相手の記録（酒蔵・得意先など）が見つかりません。'
        : constraintMessage(err);
    return new McpInputError(message, { code: 'constraint_violation' });
  }
  return err;
}

function isUserError(err) {
  return err instanceof McpInputError || (err?.status && err.status < 500);
}

/**
 * @param {object} o
 * @param {string} o.tool - ツール名（二重登録の判定と操作ログに使う）
 * @param {import('zod').ZodType} o.schema - 画面のAPIと同じスキーマ
 * @param {object} o.input - 画面が送るのと同じ形に組み立てた入力
 * @param {object} o.args - ツールの引数（preview・requestKey を読む）
 * @param {object} o.ctx - { actor, clientName }
 * @param {(valid: object) => any} o.run - 画面のAPIと同じサービス関数を呼ぶ
 * @param {(db, valid, before) => string[]} [o.warnings] - 注意点（登録は止めない）
 * @param {(result, valid) => {action, targetType, targetId, summary}} o.log - 操作ログの中身
 * @param {(db, result) => any} [o.record] - 返す記録（無ければ run の結果）
 * @param {(db, valid) => any} [o.snapshot] - 変化を見せるための控え（在庫・液量など）
 * @param {(before, after) => any} [o.diff] - 控えの前後から「変化」を作る
 * @param {string} [o.effectsKey] - 変化を返すキーの名前
 * @param {object} [o.scope] - 入力に含まれない対象（受注・蒸留記録・入金のIDなど）。二重登録の判定に含める
 */
function executeWrite({
  tool,
  schema,
  input,
  args,
  ctx,
  run,
  warnings = () => [],
  log,
  record = (_db, result) => result,
  snapshot = () => null,
  diff = () => undefined,
  effectsKey = 'changes',
  scope,
}) {
  const db = getConnection();

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new McpInputError('入力内容に誤りがあります', {
      code: 'validation_error',
      details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const valid = parsed.data;
  const before = snapshot(db, valid);
  const notes = warnings(db, valid, before);

  if (args.preview) {
    let outcome = null;
    let failure = null;
    try {
      db.transaction(() => {
        const result = run(valid);
        outcome = { record: record(db, result), after: snapshot(db, valid) };
        throw ROLLBACK;
      })();
    } catch (err) {
      if (err !== ROLLBACK) failure = asUserError(err);
    }
    if (failure && !isUserError(failure)) throw failure; // サーバー側の故障はそのまま上げる

    return compact({
      preview: true,
      saved: false,
      wouldSucceed: !failure,
      error: failure ? errorBody(failure) : undefined,
      warnings: notes,
      input: valid,
      // 採番（受注番号・コードなど）は試し実行の時点の見込み。本登録で変わることがある
      record: outcome?.record,
      [effectsKey]: diff(before, outcome?.after),
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
  const argsHash = hashArgs(tool, scope === undefined ? valid : { scope, valid });

  try {
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
        [effectsKey]: diff(before, snapshot(db, valid)),
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
  } catch (err) {
    throw asUserError(err);
  }
}

module.exports = { executeWrite, compact, errorBody, isUserError, VIA_LABEL };
