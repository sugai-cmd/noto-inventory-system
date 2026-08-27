-- ログイン認証
--
-- 自宅からもアクセスする運用のため、社内LAN前提の「認証なし」から
-- ユーザー名＋パスワードによる認証に切り替える。
--
-- パスワードは平文で持たず、scrypt（Node.js標準のcrypto）でハッシュ化して保存する。
-- ソルトは利用者ごとにランダム生成し、ハッシュと一緒に保管する。

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  uid           TEXT NOT NULL UNIQUE,      -- 他マスタと同じ8桁ランダム小文字英数字
  username      TEXT NOT NULL UNIQUE,      -- ログインID
  display_name  TEXT NOT NULL,             -- 画面に出す名前
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- セッション。
-- トークンは推測不可能なランダム値（256bit）なので、これ自体が本人確認の鍵になる。
-- ブラウザにはHttpOnly Cookieとして渡し、JavaScriptからは読めないようにする。
CREATE TABLE sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  user_agent  TEXT
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
