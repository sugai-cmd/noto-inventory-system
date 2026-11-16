# 音声入力用コネクタ（MCP）

現場や外出先から Claude に話しかけて、受注管理システムに記録を登録するための入口です。
claude.ai の「カスタムコネクタ」として登録して使います。

- できること：**新しい記録の登録**と、そのための読み取り
  - 現場：蒸留（開始・投入追加・完了）、原酒入荷、瓶詰め、箱詰め、容器移動、未納税移出、資材入荷
  - 受注・出荷：受注、発送済み、返品、無償出荷、委託販売の報告、見積
  - 入金：入金の記録、消し込み（1件ずつ足す）
  - マスタ：得意先（営業メモ）、商品（レシピ1行）、タンク、酒蔵、原酒銘柄、資材
- できないこと：**取消・修正・削除**（これまでどおり画面で行う）、棚卸

## 1. しくみ

```
スマホ・PCの Claude ──(インターネット)──> noto-mcp.tail1c017e.ts.net:443（Funnel）──> このMacの 127.0.0.1:3100（コネクタ専用）
各PCのブラウザ    ──(tailnet の中だけ)──> notonaoraimacbook-air.tail1c017e.ts.net:443（serve）──> このMacの 127.0.0.1:3000（画面・API）
```

- コネクタは**サイト本体とは別のポート（3100）**で待ち受けます。3100番で返すのは `/mcp`（ツール）、
  ログイン（OAuth）、その案内だけで、それ以外は 404 です。
- インターネットに出すのは、**コネクタ専用の機器名 `noto-mcp`** だけです。
  - claude.ai は443番以外のポートに接続できない（8443番・10000番は届かなかった）ため、
    同じMacで2つ目の Tailscale を動かし、その名前の443番を Funnel で公開しています。
  - 画面の名前（`notonaoraimacbook-air`）は tailnet の中だけのままです。
- サーバー（`npm start`／launchd）を起動すると、3100番も一緒に起動します。止めたいときは環境変数 `MCP_PORT=0`。

### 登録の決まり

- 登録は**画面と同じ入力チェック・同じ処理**を通ります（各ルートの zod スキーマとサービス関数をそのまま使う）。
  画面が自分で補っている既定値（受注の入金予定日、発送の段ボールの推奨、コードの続き番号など）も同じように補います。
- Claude はまず `preview`（保存しない試し実行）で確認表を作り、「OK」をもらってから本登録します。
  preview は本番と同じ処理をトランザクションの中で実行してから巻き戻すので、画面と同じチェックが走り、何も保存されません。
- 本登録には `requestKey` が必要です。同じキーで2回届いても、2件目は作られません（言い直し・再送対策）。
- タンク・得意先・商品などは名前でも指定できます。1つに決まらないときは登録せず、候補を返します。
- 画面にない注意点（瓶詰めの残量超過、ほぼ同じ名前のマスタ、同じ日・同じ金額の入金など）は `warnings` で知らせます。
  **登録できるかどうかは画面と同じルールで決まります**（コネクタだけ厳しく・緩くはしません）。
- 入金の消し込みは、画面の口が「全件差し替え」なので、既存の割り当てをそのまま入れ直して1件を足します。既存を変えることはしません。
- 製品レシピは、同じ組み合わせが既にあれば断ります（画面の口は上書きするが、上書き＝修正は画面で行う）。
- 登録すると、設定画面の**操作ログ**に「【音声入力（MCP）経由】」と登録者が残ります（操作の種類は `mcp.` で始まる）。

### ログイン（認証）

- claude.ai でコネクタを「連携」すると、このシステムのログイン画面が開きます。**画面と同じID・パスワード**に加えて、
  **2要素認証（認証アプリ）のコードが必須**です。2要素認証を有効にしていない利用者はログインできません。
- 失敗が続いたときのロックは画面のログインと共通です（15分に5回）。
- ログインは30日ごとに更新されます（使っていれば自動で延長）。2要素認証を無効にすると、その時点で使えなくなります。

## 2. 共用Macの設定（設定済み。作り直すときの手順）

### 2-1. 2要素認証を有効にする

画面の「設定」→ 2要素認証 で、認証アプリに登録して有効にします。

### 2-2. 2つ目の Tailscale（コネクタ専用）

```bash
brew install tailscale
brew unlink tailscale      # ふだんの tailscale コマンドは今のアプリのままにする
mkdir -p ~/.noto-mcp-tailscale && chmod 700 ~/.noto-mcp-tailscale
```

`~/Library/LaunchAgents/jp.noto-naorai.mcp-tailscale.plist` で、次のように常駐させます（Macのネットワーク設定には触らない userspace モード）。

```
/opt/homebrew/opt/tailscale/bin/tailscaled --tun=userspace-networking \
  --statedir=/Users/notonorai/.noto-mcp-tailscale \
  --socket=/Users/notonorai/.noto-mcp-tailscale/tailscaled.sock --port=41642
```

```bash
launchctl load ~/Library/LaunchAgents/jp.noto-naorai.mcp-tailscale.plist
TS=/opt/homebrew/opt/tailscale/bin/tailscale
SOCK=/Users/notonorai/.noto-mcp-tailscale/tailscaled.sock
$TS --socket=$SOCK up --hostname=noto-mcp --accept-dns=false --accept-routes=false   # 出たURLでログイン
$TS --socket=$SOCK funnel --bg http://127.0.0.1:3100
$TS --socket=$SOCK funnel status
```

- Tailscale の管理画面で `noto-mcp` を「Disable key expiry」にします（しないと約180日でログアウトする）。
- 画面用の Tailscale（`tailscale funnel status`）は「tailnet only」だけになっていることを確かめます。

### 2-3. サーバーの設定

`~/Library/LaunchAgents/jp.noto-naorai.inventory.plist` の `EnvironmentVariables` に
`MCP_PUBLIC_URL=https://noto-mcp.tail1c017e.ts.net` を入れて再起動します（既定値も同じURL）。

```bash
launchctl unload ~/Library/LaunchAgents/jp.noto-naorai.inventory.plist
launchctl load   ~/Library/LaunchAgents/jp.noto-naorai.inventory.plist
tail -n 20 logs/server.log   # 「MCP connector listening … 公開URL https://noto-mcp.tail1c017e.ts.net/mcp」
```

### 2-4. claude.ai に登録する

1. claude.ai の 設定 → コネクタ → 「カスタムコネクタを追加」
2. URL に `https://noto-mcp.tail1c017e.ts.net/mcp`
3. **OAuthクライアントは「自動的に登録」を選ぶ**（「Claudeの公開アイデンティティを使用」には対応していない）
4. 「連携」→ ID・パスワード・認証アプリのコードでログイン
5. ツールを「常に許可」にする（ツールを足したときは、増えた分も「常に許可」にする）

## 3. ツール

| 区分 | ツール | 内容 |
|---|---|---|
| 読み取り | list_tanks / list_active_distillations / get_distillation / get_distillation_options | タンク・蒸留記録 |
| 読み取り | search_master / find_orders / list_open_invoices / list_wip_lots / list_pending_consignments / get_registration_options | マスタ・受注・請求・ロット・選択肢 |
| 蒸留 | start_distillation / add_distillation_input / complete_distillation | 開始・投入追加・完了 |
| 現場 | receive_raw_sake / record_bottling / record_boxing / transfer_tank / record_tax_free_transfer / receive_material | 原酒入荷・瓶詰め・箱詰め・容器移動・未納税移出・資材入荷 |
| 受注・出荷 | create_order / ship_order / record_return / record_sample / record_consignment_report / create_quotation | 受注・発送済み・返品・無償出荷・委託報告・見積 |
| 入金 | record_payment / allocate_payment | 入金・消し込み（1件ずつ足す） |
| マスタ | create_customer / add_customer_note / create_product / add_recipe_row / create_tank / create_brewery / create_raw_sake_brand / create_material | 各マスタの新規登録 |

## 4. 困ったとき

| 症状 | 確かめること |
|---|---|
| claude.ai で「接続できない」 | `$TS --socket=$SOCK funnel status` に noto-mcp が出ているか。`logs/server.log` に MCP connector の行があるか |
| ログインで「2要素認証が有効になっていません」 | 設定画面で2要素認証を有効にする |
| 「ログインの受付が期限切れ」 | ログイン画面を開いて10分以上たった。claude.ai から接続し直す |
| 急に使えなくなった | 30日以上使っていない、または2要素認証を無効にした。claude.ai から接続し直す |

### 接続を取り消す（スマホをなくしたときなど）

```bash
npm run mcp-revoke          # 有効な接続の一覧（何も変えない）
npm run mcp-revoke -- --all # すべて取り消す
```

### コネクタを止める

```bash
/opt/homebrew/opt/tailscale/bin/tailscale --socket=/Users/notonorai/.noto-mcp-tailscale/tailscaled.sock funnel --https=443 off
```

インターネットからの入口だけが閉じます（画面には影響しません）。

## 5. 設定（環境変数）

| 名前 | 既定 | 内容 |
|---|---|---|
| `MCP_PORT` | 3100 | コネクタの待ち受けポート（このMacの中だけ）。`0` で起動しない |
| `MCP_PUBLIC_URL` | `https://noto-mcp.tail1c017e.ts.net` | 外から見たURL。Funnel の公開URLと一致させる（ログインの発行元になる） |

関係するコード：
- `src/mcp/`：コネクタ。`writeFlow.js` が登録の共通の流れ、`registrationTools.js` と `distillationTools.js` が中身
- 各ルートの `module.exports.schemas`：画面と共通の入力チェック。蒸留は `src/validators/distillationSchemas.js`
- `db/migrations/0033_mcp_connector.sql`：ログイン情報と二重登録防止の表
- `tests/services/mcpConnector.test.js`、`tests/services/mcpRegistrations.test.js`
