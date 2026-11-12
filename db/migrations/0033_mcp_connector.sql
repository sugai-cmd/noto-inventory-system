-- 音声入力用コネクタ（MCP）のための表。
--
-- claude.ai のカスタムコネクタは OAuth でログインする。コネクタ（クライアント）の登録、
-- ログイン途中の状態、認可コード、トークンをここに持つ。
-- **トークンと認可コードはハッシュだけを保存する。** DBが漏れても、そのまま使えないようにするため。
--
-- mcp_requests は二重登録の防止用。音声の言い直しや通信の再送で同じ登録が2回届いても、
-- 同じ requestKey なら1回目の結果を返して2件目を作らない。登録と同じトランザクションで書く。

CREATE TABLE oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_json   TEXT NOT NULL,                       -- 登録時の内容（リダイレクト先など）
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ログイン画面を出してから、ID・パスワードが送られてくるまでの状態（10分で失効）
CREATE TABLE oauth_pending_authorizations (
  id              TEXT PRIMARY KEY,                  -- ログイン画面のフォームに埋める推測できない値
  client_id       TEXT NOT NULL REFERENCES oauth_clients(client_id),
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  state           TEXT,
  scopes          TEXT,
  resource        TEXT,
  expires_at      TEXT NOT NULL
);

CREATE TABLE oauth_codes (
  code_hash       TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES oauth_clients(client_id),
  user_id         INTEGER NOT NULL REFERENCES users(id),
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  scopes          TEXT,
  resource        TEXT,
  expires_at      TEXT NOT NULL,
  used_at         TEXT                               -- 1回使ったら二度と使えない
);

CREATE TABLE oauth_tokens (
  id              INTEGER PRIMARY KEY,
  token_hash      TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id       TEXT NOT NULL REFERENCES oauth_clients(client_id),
  user_id         INTEGER NOT NULL REFERENCES users(id),
  scopes          TEXT,
  resource        TEXT,
  expires_at      TEXT NOT NULL,
  revoked_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_oauth_tokens_user ON oauth_tokens(user_id);

CREATE TABLE mcp_requests (
  request_key   TEXT PRIMARY KEY,
  tool          TEXT NOT NULL,
  args_hash     TEXT NOT NULL,                       -- 同じキーで別の内容が来たら断るため
  user_id       INTEGER REFERENCES users(id),
  result_json   TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
