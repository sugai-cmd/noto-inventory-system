# 週次報告の自動書き出し（Googleスプレッドシート）

NOTOメンバーMTGで報告する「売り上げ、在庫状況」の数字を、毎朝Googleスプレッドシートへ書き出します。
このシステムはTailscale内にあり、クラウド上のClaude（議事録案を作るスケジュール済みタスク）からは
直接読めないため、スプレッドシートを経由して数字を渡します。

```
Mac（このシステム） ──毎朝6:00──▶ Apps Script（受け口） ──▶ スプレッドシート「週次報告_売上在庫」
                                                                  ▲
                                         議事録案を作るClaude ──読む─┘
```

- DBは**読むだけ**です。何も書き換えません。
- 送るのは集計した数字だけです（得意先名・商品名・金額・在庫数）。住所や連絡先は送りません。

## 書き出す内容

| シート | 内容 |
|---|---|
| 推移 | 1日1行。同じ日に送り直しても行は増えません（上書き） |
| 最新サマリー | 最新の集計を項目ごとに縦に並べたもの。議事録づくりで読む |
| 得意先別 / 商品別 | 当月（受注日ベース）の売上の内訳 |
| 商品在庫 / 要発注資材 / タンク / 原酒タンク | 在庫の状況 |
| 入金遅れ | 入金予定日を過ぎて入金日が入っていない伝票 |

主な数字の定義:

| 項目 | 定義 |
|---|---|
| 当月売上（受注日ベース） | 受注日が当月1日〜前日の受注の売価（税抜）＋当月報告分の委託。取消済みは除く |
| 当月入金予定額（入金予定日ベース） | 入金予定日が当月の受注・委託の税込額（売価×1.1＋送料）。入金済／未入金に分ける |
| 当月入金額 | 入金日が当月1日〜前日のものの税込額 |
| 前週 | 集計日の前の週の月曜〜日曜 |
| 前月売上（受注日ベース・確定） | 前月1か月分。**前週の月曜が前月にある週は「前月の締めを報告する」=はい** になる |

売上を税抜の売価で数えるのは、売上目標の画面（`/sales-targets.html`）と揃えるためです。

## 設定手順（初回のみ）

### 1. スプレッドシートと受け口を用意する

1. 共有ドライブの「週次報告」フォルダにあるスプレッドシート「週次報告_売上在庫」を開く
2. メニューの **拡張機能 → Apps Script** を開く
3. 最初からある `コード.gs` の中身をすべて消し、このリポジトリの
   [`gas/weekly-report/Code.gs`](../gas/weekly-report/Code.gs) の中身を貼り付けて保存する
4. 左の歯車（プロジェクトの設定）→ 一番下の **スクリプト プロパティ** → 「プロパティを追加」
   - プロパティ: `REPORT_SECRET`
   - 値: 合言葉（ターミナルで `openssl rand -hex 24` を実行して出た文字列を使う）
5. 右上の **デプロイ → 新しいデプロイ**
   - 種類の選択（歯車）→ **ウェブアプリ**
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**
   - 「デプロイ」→ 権限を承認 → 表示された **ウェブアプリのURL**（`https://script.google.com/macros/s/…/exec`）を控える

> 「全員」にしても、合言葉を知らない送信は書き込まれません。合言葉は `.env` とスクリプト プロパティの2か所だけに置き、Slackやメールに貼らないでください。

### 2. Macの `.env` に書く

```bash
cd ~/noto-inventory-system
cat >> .env <<'ENV'
REPORT_WEBHOOK_URL=https://script.google.com/macros/s/（控えたURL）/exec
REPORT_WEBHOOK_SECRET=（手順1-4の合言葉）
ENV
```

### 3. 試しに送る

```bash
node scripts/export-weekly-report.js --dry-run   # 送らずに中身を確認
node scripts/export-weekly-report.js             # 送る
```

スプレッドシートに「推移」「最新サマリー」などのシートができていれば成功です。

### 4. 毎朝6時に自動で送る（launchd）

平日（月〜金）の6:00に送ります。会議が祝日などで火曜以降にずれても、その日の朝の数字が届きます。

```bash
cat > ~/Library/LaunchAgents/jp.noto-naorai.weekly-report.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>jp.noto-naorai.weekly-report</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>scripts/export-weekly-report.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/YOUR_NAME/noto-inventory-system</string>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>2</integer><key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>3</integer><key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>4</integer><key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>5</integer><key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key>
  <string>/Users/YOUR_NAME/noto-inventory-system/logs/weekly-report.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR_NAME/noto-inventory-system/logs/weekly-report.log</string>
</dict>
</plist>
PLIST

launchctl load ~/Library/LaunchAgents/jp.noto-naorai.weekly-report.plist
```

`/Users/YOUR_NAME/` と `/usr/local/bin/node` は [SETUP.md](SETUP.md) 4-1 と同じように書き換えてください。

> Macがスリープしていた場合、launchdは**起きたときに1回だけ**実行します。
> 6時に数字が届いていなければ、`tail logs/weekly-report.log` で確認してください。

月曜だけにしたい場合は、`<array>` の中を `Weekday` が `1` の1行だけにします。

## うまくいかないとき

| 症状 | 確認すること |
|---|---|
| `合言葉が一致しません` | `.env` の `REPORT_WEBHOOK_SECRET` とスクリプト プロパティの `REPORT_SECRET` が同じか |
| `送り先の応答が読めませんでした` | URLが `/exec` で終わっているか。Apps Scriptを直したあと「デプロイを管理 → 編集 → 新バージョン」で更新したか |
| ログに何も出ない | `launchctl list | grep weekly-report` で登録されているか |
