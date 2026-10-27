# 経営数値シート（上司向け・閲覧専用のGoogleスプレッドシート）

受注管理システムの売上・受注・在庫・原価を、毎朝Googleスプレッドシートへ書き出します。
運用はこれまでどおりシステムで行い、スプレッドシートは**見るだけ**のコピーです。

```
Mac（このシステム） ──毎朝6:10──▶ Apps Script（受け口） ──▶ スプレッドシート「経営数値シート」
                                                                   ▲
                                                     上司（閲覧者）─┘
```

- DBは**読むだけ**です。何も書き換えません。
- 週次報告（[WEEKLY-REPORT.md](WEEKLY-REPORT.md)）と違い、**得意先の住所・連絡先も送ります**（得意先マスタのシート）。
  共有は上司だけを**閲覧者**にしてください。リンクを知っている全員、や社内全員には広げないでください。
- 各シートは保護してあり、編集できるのはオーナー（Apps Scriptを動かす人）だけです。手で直しても翌朝に書き直されます。

## シート

| シート | 内容 |
|---|---|
| サマリー | 最終更新日時、当月売上・目標・進捗、当月入金予定（入金済／未入金）、入金遅れ、要発注の資材の数 |
| 受注明細 | 全期間の受注明細。取消も「取消」列で区別して載せる。原価・粗利・酒税つき |
| 受注ベース売上高 | 日別の横並び。列は［月の合計］［その月の1日］［2日］…。月の合計の上の「+」で日別を開く（当月以外は畳んである） |
| 入金ベース | 同じ形で、入金予定額（入金予定日）・うち未入金・入金額（入金日） |
| 売上目標 | 月ごとの目標・実績・差・進捗率 |
| 入金遅れ | 入金予定日を過ぎて入金日がない伝票 |
| 委託販売実績 | 委託の報告の一覧（原価・粗利つき） |
| 商品在庫 | 商品＋仕掛品の合計、資材から**あと何本作れるか**、いちばん先に足りなくなる資材 |
| 資材在庫 | 在庫・適正在庫・単価・在庫金額。**適正在庫を下回った行は赤** |
| タンク・原酒 | 浄酎の容器の液量、原酒の容器の液量、原酒のロットごとの残りと金額 |
| 商品原価 | 商品ごとの中身の原価・資材の原価・合計・上代に対する原価率・酒税、足りない設定 |
| 資材マスタ / 得意先マスタ | マスタの全項目 |

## 数字の定義

売上・入金の数え方は週次報告と同じです（同じ関数を使っています）。

| 項目 | 定義 |
|---|---|
| 売上 | 売価（税抜）。買取は受注日、委託は**報告月**で数える。販売方法が「委託」の受注（預けただけ）と取消は数えない |
| 税込 | 売価 ＋ 売価の消費税 ＋ 送料 |
| 日別の横並び | 委託は日が無いので**月の合計の列にだけ**入る（日の合計と月の合計がずれるのはこのため） |
| 商品在庫 | 商品 ＋ 仕掛品 |
| あと作れる本数 | 資材の在庫 ÷ レシピの必要数量（瓶詰＋箱詰）のいちばん少ないもの。タンクの中身は数えていない |

### 商品原価（ざっくり）

```
商品原価   ＝ 中身の原価 ＋ 資材の原価
中身の原価 ＝ 容量(L) × 倍率 × 原酒の仕入単価(円/L)
倍率       ＝ 投入した原酒(L) ÷ 採れた浄酎(L)
資材の原価 ＝ Σ レシピの必要数量 × 資材の単価（瓶詰＋箱詰）
粗利       ＝ 売価（税抜） − 商品原価 × 本数
```

- 例：35度300ml、原酒1,000円/L → 0.3 × 2.0 × 1,000 ＝ **600円**
- 倍率（鳥屋酒造・一昨年度の原酒の実績）：35度は原酒30L→15L（2.0）、41度は30L→13L（約2.31）。
  `raw_sake_yield_rates` に入っています。度数の違う商品を作ったら行を足してください
- 原酒の単価は「マスタ → 原酒」で**ロットごと**に入れ、今使っている原酒1件に「原価に使う」のチェックを入れます
  （別の原酒にチェックすると前のものは外れます）
- **過去の受注も、いまの単価で計算します。** 原酒を切り替えると過去の粗利も変わります（目安として見るためのもの）
- 単価が空の資材は0円で足し、「商品原価」シートの「注意」に名前が出ます。原酒が選ばれていない・倍率がない商品は、0円にせず空欄にします
- 取消と委託（預け）の受注には粗利を出しません

## 設定手順（初回のみ）

### 0. 原酒の単価を入れる

1. 受注管理システムを再起動する（起動するときに 0032 が自動で当たり、原酒の単価・原価に使う・倍率が増えます。
   `npm run migrate` を別に打つ必要はありません）。再起動の前に `backups/` へDBのバックアップを取っておく
2. 画面の **マスタ → 原酒** で各ロットを開き、「仕入単価(円/L)」を入れる
   - 一昨年度（BYR6）: 8,000Lで8,000,000円 → `1000`
   - 昨年度（BYR7）: `1400`
3. 今使っている原酒（一昨年度）の1件に「この原酒の単価で商品原価を出す」をチェックして保存

### 1. スプレッドシートと受け口を用意する

1. Googleドライブで新しいスプレッドシートを作る（名前の例：「経営数値シート」）
2. **拡張機能 → Apps Script** を開き、`コード.gs` の中身を [`gas/management-sheet/Code.gs`](../gas/management-sheet/Code.gs) に置き換えて保存
3. 歯車（プロジェクトの設定）→ **スクリプト プロパティ** に追加
   - プロパティ: `MANAGEMENT_SECRET`
   - 値: 合言葉。ターミナルで `openssl rand -hex 24` を実行し、**出てきた48文字の英数字**を貼る
     （`openssl rand -hex 24` という文字そのものを合言葉にしない）。週次報告とは**別の**合言葉にする
4. **デプロイ → 新しいデプロイ → ウェブアプリ**
   - 次のユーザーとして実行: **自分** ／ アクセスできるユーザー: **全員**
   - 表示された **ウェブアプリのURL**（`…/exec`）を控える

### 2. Macの `.env` に書く

```bash
cd ~/noto-inventory-system
cat >> .env <<'ENV'
MANAGEMENT_WEBHOOK_URL=https://script.google.com/macros/s/（控えたURL）/exec
MANAGEMENT_WEBHOOK_SECRET=（手順1-3の合言葉）
ENV
```

### 3. 試しに送る

```bash
node scripts/export-management-sheet.js --dry-run   # 送らずに中身を確認
node scripts/export-management-sheet.js             # 送る
```

13枚のシートができ、「受注ベース売上高」で月の合計の上の「+」から日別が開ければ成功です。

### 4. 上司に共有する

スプレッドシートの **共有** で上司のアカウントだけを **閲覧者** で追加します。
「一般的なアクセス」は **制限付き** のままにしてください（得意先の住所・連絡先が載っています）。

### 5. 毎朝6:10に自動で送る（launchd）

週次報告（6:00）と重ならないよう10分ずらします。毎日送ります。

```bash
cat > ~/Library/LaunchAgents/jp.noto-naorai.management-sheet.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>jp.noto-naorai.management-sheet</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>scripts/export-management-sheet.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/YOUR_NAME/noto-inventory-system</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>10</integer></dict>
  <key>StandardOutPath</key>
  <string>/Users/YOUR_NAME/noto-inventory-system/logs/management-sheet.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR_NAME/noto-inventory-system/logs/management-sheet.log</string>
</dict>
</plist>
PLIST

launchctl load ~/Library/LaunchAgents/jp.noto-naorai.management-sheet.plist
```

`/Users/YOUR_NAME/` と `/usr/local/bin/node` は [SETUP.md](SETUP.md) 4-1 と同じように書き換えてください。

## うまくいかないとき

| 症状 | 確認すること |
|---|---|
| `合言葉が一致しません` | `.env` の `MANAGEMENT_WEBHOOK_SECRET` とスクリプト プロパティの `MANAGEMENT_SECRET` が同じか |
| `送り先の応答が読めませんでした` | URLが `/exec` で終わっているか。Code.gs を直したら「デプロイを管理 → 編集 → 新バージョン」で更新したか |
| `no such table: raw_sake_yield_rates` | 0032 が当たっているか。受注管理システムを再起動すると当たる（手順0） |
| 商品原価が空欄 | 「商品原価」シートの「注意」列。原酒の単価・「原価に使う」・倍率・容量・度数のどれが足りないかが出ます |
| ログに何も出ない | `launchctl list \| grep management-sheet` で登録されているか |
