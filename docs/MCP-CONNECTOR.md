# 音声入力用コネクタ（MCP）

現場から Claude に話しかけて、蒸留の記録を登録するための入口です。
claude.ai の「カスタムコネクタ」として登録して使います。

- できること：**蒸留開始・蒸留中の投入追加・完了報告（残渣回収・食塩を含む）**の登録と、そのためのタンク・蒸留記録の読み取り
- できないこと：取消・修正・削除・原酒入荷（これまでどおり画面で行う）

## 1. しくみ

```
スマホ・PCの Claude ──(インターネット)──> Tailscale Funnel :8443 ──> このMacの 127.0.0.1:3100（コネクタ専用）
各PCのブラウザ    ──(tailnet の中だけ)──> Tailscale serve  :443  ──> このMacの 127.0.0.1:3000（画面・API）
```

- コネクタは**サイト本体とは別のポート（3100）**で待ち受けます。インターネットに出すのはこのポートだけで、
  画面と `/api` はこれまでどおり tailnet の中だけです。
- 3100番で返すのは `/mcp`（ツール）、ログイン（OAuth）、その案内だけです。それ以外は 404 です。
- サーバー（`npm start`／launchd）を起動すると、3100番も一緒に起動します。止めたいときは環境変数 `MCP_PORT=0`。

### 登録の決まり

- 登録は**画面と同じ入力チェック・同じ処理**を通ります。結果（タンク液量・蒸留記録・酒税集計）は画面から入れた場合と同じです。
- Claude はまず `preview`（保存しない試し実行）で確認表を作り、「OK」をもらってから本登録します。
- 本登録には `requestKey` が必要です。同じキーで2回届いても、2件目は作られません（言い直し・再送対策）。
- タンクは名前でも指定できます。1つに決まらないときは登録せず、候補を返します。
- 蒸留設定時間は「8時間」「8時間30分」の形にそろえて保存します（8h・480分・8時間半なども読み替え）。
- 登録すると、設定画面の**操作ログ**に「【音声入力（MCP）経由】」と登録者が残ります（操作の種類 `mcp.distillation.*`）。

### ログイン（認証）

- claude.ai でコネクタを「接続」すると、このシステムのログイン画面が開きます。**画面と同じID・パスワード**に加えて、
  **2要素認証（認証アプリ）のコードが必須**です。2要素認証を有効にしていない利用者はログインできません。
- 失敗が続いたときのロックは画面のログインと共通です（15分に5回）。
- ログインは30日ごとに更新されます（使っていれば自動で延長）。2要素認証を無効にすると、その時点で使えなくなります。

## 2. 初めて使うとき（サーバー機で1回だけ）

### 2-1. 2要素認証を有効にする

画面の「設定」→ 2要素認証 で、認証アプリ（Google Authenticator など）に登録して有効にします。

### 2-2. サーバーを更新して再起動する

```bash
cd ~/noto-inventory-system
git pull
npm install          # 追加の部品（@modelcontextprotocol/sdk）を入れる
launchctl unload ~/Library/LaunchAgents/jp.noto-naorai.inventory.plist
launchctl load   ~/Library/LaunchAgents/jp.noto-naorai.inventory.plist
tail -n 20 logs/server.log   # 「MCP connector listening on http://127.0.0.1:3100/mcp」が出ていればOK
```

### 2-3. 3100番だけをインターネットに出す（Tailscale Funnel）

Tailscale の管理画面（Access controls）で、このMacに Funnel が許可されている必要があります。
許可されていないときは、次のコマンドが案内のURLを出すので、そこで許可します。

```bash
tailscale funnel --bg --https=8443 http://127.0.0.1:3100
tailscale funnel status
```

`status` で次の2つが出ていれば正しい状態です。

- `https://notonaoraimacbook-air.tail1c017e.ts.net (tailnet only)` … 画面（443番）。これまでどおり
- `https://notonaoraimacbook-air.tail1c017e.ts.net:8443 (Funnel on)` … コネクタだけ

外から届くかを確かめます（スマホのモバイル回線などで）。

- `https://notonaoraimacbook-air.tail1c017e.ts.net:8443/.well-known/oauth-protected-resource/mcp` … JSONが出る
- `https://notonaoraimacbook-air.tail1c017e.ts.net/` … **開けない**（tailnet の外からは届かない）こと

### 2-4. claude.ai に登録する

1. claude.ai の 設定 → コネクタ → 「カスタムコネクタを追加」
2. URL に `https://notonaoraimacbook-air.tail1c017e.ts.net:8443/mcp` を入れて追加
3. 「接続」→ 開いたログイン画面で ID・パスワード・認証アプリのコードを入れる
4. コネクタのツール一覧で、7つのツールを「常に許可」にする

| ツール | 内容 |
|---|---|
| list_tanks | タンク一覧（種別・現在液量・度数・最大液量） |
| list_active_distillations | 蒸留中の記録 |
| get_distillation | 蒸留記録1件の詳細 |
| get_distillation_options | 選択肢（投入元・払出先・残渣タンクなど） |
| start_distillation | 蒸留開始 |
| add_distillation_input | 蒸留中の投入追加 |
| complete_distillation | 完了報告（残渣回収・食塩を含む） |

## 3. 困ったとき

| 症状 | 確かめること |
|---|---|
| claude.ai で「接続できない」 | `tailscale funnel status` に 8443 が出ているか。`logs/server.log` に MCP connector の行があるか |
| ログイン画面で「2要素認証が有効になっていません」 | 設定画面で2要素認証を有効にする |
| 「ログインの受付が期限切れ」 | ログイン画面を開いて10分以上たった。claude.ai から接続し直す |
| 急に使えなくなった | 30日以上使っていない、または2要素認証を無効にした。claude.ai から接続し直す |

### 接続を取り消す（スマホをなくしたときなど）

```bash
npm run mcp-revoke          # 有効な接続の一覧（何も変えない）
npm run mcp-revoke -- --all # すべて取り消す
```

### コネクタを止める

```bash
tailscale funnel --https=8443 off   # インターネットからの入口を閉じる（画面には影響なし）
```

## 4. 設定（環境変数）

| 名前 | 既定 | 内容 |
|---|---|---|
| `MCP_PORT` | 3100 | コネクタの待ち受けポート（このMacの中だけ）。`0` で起動しない |
| `MCP_PUBLIC_URL` | `https://notonaoraimacbook-air.tail1c017e.ts.net:8443` | 外から見たURL。Funnel の公開URLと一致させる（ログインの発行元になる） |

関係するコード：`src/mcp/`（コネクタ）、`src/validators/distillationSchemas.js`（画面と共通の入力チェック）、
`db/migrations/0033_mcp_connector.sql`（ログイン情報と二重登録防止の表）、`tests/services/mcpConnector.test.js`。
