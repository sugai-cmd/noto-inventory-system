// マイグレーションが失敗したまま動いているときの扱い。
//
// 移行SQLが1つ落ちただけでサーバーが起動しないと、画面が一切出ないため
// 利用者からは「急に全部繋がらない」としか見えない（実際に業務が止まった）。
// サーバーは起動させたうえで、
//   ・何が起きたかを全画面に出す（/api/migration-state を画面が読む）
//   ・中途半端なスキーマで記録を増やさないよう、更新系だけ止める
// という形にする。読み取りは通すので、調べ物や印刷は続けられる。

const { BusinessRuleError } = require('../utils/errors');

let state = { ok: true, failed: null, message: null };

function setMigrationState(next) {
  state = { ok: Boolean(next?.ok), failed: next?.failed ?? null, message: next?.message ?? null };
}

function getMigrationState() {
  return state;
}

/** 画面に出す一行。利用者がそのまま読んで動ける文にする */
function migrationNotice() {
  if (state.ok) return null;
  return (
    `データベースの取り込みが完了していません（${state.failed ?? '不明なファイル'} で失敗）。` +
    '記録の追加・変更はできません。サーバー機で logs/error.log を確認してください。'
  );
}

/**
 * 更新系を止める。**読み取り（GET/HEAD）とログインは通す。**
 * 止めないと、まだ無い列や表に書こうとして中途半端なデータが増える。
 */
function blockWritesWhenMigrationFailed(req, res, next) {
  if (state.ok) return next();
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.path.startsWith('/api/auth/')) return next();   // ログイン・ログアウトは通す

  return next(new BusinessRuleError(migrationNotice()));
}

module.exports = {
  setMigrationState,
  getMigrationState,
  migrationNotice,
  blockWritesWhenMigrationFailed,
};
