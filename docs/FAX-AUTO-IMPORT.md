# FAX発注書の自動取込（Gmail → 共有ドライブ → 受注登録）

カナカンの発注書FAXを、人の手を介さずに受注へ登録します。

```
ブラザー複合機 → Gmail（From_BrotherFAX）
   │  ① Apps Script（4時間おき）がPDFを共有ドライブ「FAX」フォルダに保存
   ▼
共有ドライブ FAX/ ──（Googleドライブ パソコン版で同期）──▶ サーバーのMac
   │  ② Mac（1時間おき）が新しいPDFを読み取り（OCR）、カナカンの発注書なら受注に登録
   ▼
FAX/取込済・要確認・未分類 に仕分け ＋ Slackで通知
```

- Gmailの確認は4時間おきです。Mac側は1時間おきにフォルダを見ます。新しいPDFが無ければ何もしません。
  そのため、FAXの受信から受注登録までは最大で約5時間かかります。
- 読み取りと登録の中身は [FAX-ORDER-IMPORT.md](FAX-ORDER-IMPORT.md) と同じです（手動のコマンドも引き続き使えます）。

## フォルダの使い分け

| フォルダ | 入るもの | 人がすること |
|---|---|---|
| `FAX/`（直下） | 届いたばかりのPDF | なし（次の確認で仕分けられる） |
| `FAX/取込済/` | 受注に登録したカナカンの発注書。名前は `発注日_得意先_発注番号.pdf` | なし |
| `FAX/要確認/` | カナカンの発注書だが登録できなかったもの・読めなかったもの | 中身を見て、受注画面から手で登録 |
| `FAX/未分類/` | カナカン以外のFAX | 中身を見て、要らなければ `不要/` へ移す |
| `FAX/不要/` | 要らないFAX | なし（置いてから30日で自動削除。ドライブのゴミ箱にさらに30日残る） |

`要確認/` の原因（得意先や商品のマスタ不足など）を直したあとで、PDFを `FAX/` 直下に戻すと、次の確認でもう一度取り込みます。

## 設定手順（最初の1回だけ）

### ① Apps Script（Gmail → 共有ドライブ）

1. https://script.google.com を **sugai@naorai.co** で開き、「新しいプロジェクト」を作る（名前は「FAX保存」など）
2. `gas/fax-saver/Code.gs` の中身を貼り付けて保存する
3. 上の関数の選択欄で **`setup`** を選び「実行」を押す。権限の確認が出たら許可する
   - これで4時間おきの実行が登録され、1回目がすぐに動きます
   - 1回目は**過去14日分**のFAXを保存します（取込済みのものは、Mac側で「登録済み」として `取込済/` に入るだけです）
4. Gmailで、FAXのメールに `FAX保存済` ラベルが付いていれば成功です

### ② Mac（共有ドライブ → 受注登録）

1. FAXフォルダの場所（パス）を調べます。

   - Finderの左の「Google Drive」（または「場所」の下のGoogle Drive）→「共有ドライブ」→ 共有ドライブ →「FAX」フォルダを表示する
   - 「FAX」フォルダを **option キーを押しながら右クリック** →「“FAX”のパス名をコピー」を選ぶ

   Finderに「Google Drive」が出ていない場合は、Googleドライブ（パソコン版）にログインしていません。
   メニューバーのGoogleドライブのアイコンから、FAXを受け取るアカウント（sugai@naorai.co など）でログインしてください。

2. `.env` を開き（`cd ~/noto-inventory-system` → `open -e .env`）、いちばん下に1行書き足して保存（⌘S）します。
   `=` のあとに、1でコピーしたパスを貼り付け（⌘V）ます。

   ```bash
   FAX_INBOX_DIR=（ここに貼り付け）
   ```

   例: `FAX_INBOX_DIR=/Users/notonorai/Library/CloudStorage/GoogleDrive-sugai@naorai.co/共有ドライブ/NOTO Naorai/FAX`
   （パスに空白が入っていても、引用符で囲む必要はありません）

3. 試しに、登録も移動もせずに動かしてみます。

   ```bash
   cd ~/noto-inventory-system
   node scripts/fax-inbox.js --dry-run
   ```

4. 1時間おきに自動で動くよう登録します。

   ```bash
   cat > ~/Library/LaunchAgents/jp.noto-naorai.fax-inbox.plist <<'PLIST'
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
     "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key>
     <string>jp.noto-naorai.fax-inbox</string>
     <key>ProgramArguments</key>
     <array>
       <string>/usr/local/bin/node</string>
       <string>scripts/fax-inbox.js</string>
     </array>
     <key>WorkingDirectory</key>
     <string>/Users/YOUR_NAME/noto-inventory-system</string>
     <key>EnvironmentVariables</key>
     <dict>
       <!-- launchd はターミナルのPATHを引き継がないので、tesseract の場所を教える -->
       <key>PATH</key>
       <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
     </dict>
     <key>StartInterval</key>
     <integer>3600</integer>
     <key>RunAtLoad</key>
     <true/>
     <key>StandardOutPath</key>
     <string>/Users/YOUR_NAME/noto-inventory-system/logs/fax-inbox.log</string>
     <key>StandardErrorPath</key>
     <string>/Users/YOUR_NAME/noto-inventory-system/logs/fax-inbox.log</string>
   </dict>
   </plist>
   PLIST

   launchctl load ~/Library/LaunchAgents/jp.noto-naorai.fax-inbox.plist
   ```

   `/Users/YOUR_NAME/` と `/usr/local/bin/node` は [SETUP.md](SETUP.md) 4-1 と同じように書き換えてください。

5. `tail logs/fax-inbox.log` で「FAX ○件を確認」と出ていれば動いています。

### ③ Slack通知（ボットからのDM）

1. https://api.slack.com/apps →「Create New App」→「From scratch」（名前は「FAX取込」など、ワークスペースを選ぶ）
2. 「OAuth & Permissions」→ Bot Token Scopes に **`chat:write`** を追加 →「Install to Workspace」
3. 表示された **Bot User OAuth Token**（`xoxb-` で始まる）を控える
4. Slackで自分のプロフィール →「︙」→「メンバーIDをコピー」（`U` で始まる）
5. `.env` に書き足す

   ```bash
   SLACK_BOT_TOKEN=xoxb-…
   SLACK_CHANNEL=U…（自分のメンバーID。チャンネルに流したい場合はチャンネルID）
   ```

通知されるのは「登録した」「要確認」「カナカン以外のFAXが来た」「不要フォルダを掃除した」「実行に失敗した」ときです。
何も届いていないときは通知しません。

## うまくいかないとき

| 症状 | 確認すること |
|---|---|
| Slackに「FAXフォルダが見つかりません」 | Googleドライブ（パソコン版）が起動しているか。`.env` の `FAX_INBOX_DIR` |
| ログに `Operation not permitted` | システム設定 → プライバシーとセキュリティ → フルディスクアクセス に `node`（`which node` の場所）を追加 |
| Slackに「OCRの準備ができていません」 | `brew install tesseract tesseract-lang poppler`。plist の `PATH` |
| FAXが共有ドライブに来ない | Apps Scriptの「実行数」でエラーを確認。トリガーが消えていたら `setup` をもう一度実行 |
| Macがスリープしていた | 起きたときに1回動きます（[SETUP.md](SETUP.md) 4-3 のスリープさせない設定を推奨） |
