-- ログイン試行の記録・2要素認証・操作ログ

-- ログイン失敗回数の制限に使う。
-- 成功・失敗の両方を記録し、直近の失敗が続いているときだけロックする。
CREATE TABLE login_attempts (
  id         INTEGER PRIMARY KEY,
  username   TEXT NOT NULL,
  succeeded  INTEGER NOT NULL,
  ip_address TEXT,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_login_attempts_lookup ON login_attempts(username, attempted_at);

-- 2要素認証（TOTP）。
-- totp_secret が入っていて totp_enabled=1 のときだけ、ログイン時にコードを要求する。
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
-- 認証器を無くしたときのための使い捨てコード（ハッシュ化してJSON配列で保持）
ALTER TABLE users ADD COLUMN totp_recovery_codes TEXT;

-- 操作ログ。誰がいつ何をしたかを時系列で残す。
-- 台帳そのものは各テーブルに残るので、ここは「操作の記録」に徹する。
CREATE TABLE operation_logs (
  id          INTEGER PRIMARY KEY,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id     INTEGER REFERENCES users(id),
  username    TEXT,              -- 利用者が削除されても誰の操作か分かるよう控えておく
  action      TEXT NOT NULL,     -- 例: 'order.create', 'bottling.submit'
  target_type TEXT,              -- 例: 'orders'
  target_id   INTEGER,
  summary     TEXT,              -- 画面に出す一行説明
  detail_json TEXT               -- 補足情報（任意）
);
CREATE INDEX idx_operation_logs_time ON operation_logs(occurred_at);
CREATE INDEX idx_operation_logs_user ON operation_logs(user_id);
CREATE INDEX idx_operation_logs_target ON operation_logs(target_type, target_id);

-- 主要な記録に「誰が登録したか」を持たせる。
-- SQLiteは ALTER TABLE ADD COLUMN に対応しているので、テーブルの作り直しは不要。
ALTER TABLE orders ADD COLUMN created_by INTEGER REFERENCES users(id);
ALTER TABLE product_stock_ledger ADD COLUMN created_by INTEGER REFERENCES users(id);
ALTER TABLE material_stock_ledger ADD COLUMN created_by INTEGER REFERENCES users(id);
ALTER TABLE tank_ledger ADD COLUMN created_by INTEGER REFERENCES users(id);
ALTER TABLE raw_sake_ledger ADD COLUMN created_by INTEGER REFERENCES users(id);
ALTER TABLE distillations ADD COLUMN created_by INTEGER REFERENCES users(id);
ALTER TABLE sample_shipments ADD COLUMN created_by INTEGER REFERENCES users(id);
ALTER TABLE consignment_reports ADD COLUMN created_by INTEGER REFERENCES users(id);
