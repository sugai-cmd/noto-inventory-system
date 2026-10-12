# 送り状・納品書の自動登録（Webゆうパックプリント・マネーフォワード）

未出荷のカナカン・COREZOの受注を、毎朝8時に次の2か所へ登録します。**印刷と送付は人が行います。**

| 登録先 | 登録されるもの | 人がすること |
|---|---|---|
| Webゆうパックプリント | 出荷予定データ（送り状の元）。カナカンは品名が「浄酎 発注番号73068150」になる | 「印字予定」から送り状を印刷 |
| マネーフォワード クラウド請求書 | 納品書（納品日＝納品希望日、ステータス「未納品」、備考に発注番号） | 内容を確認して印刷・送付 |

- **FAXが追加で届いた日**は、受注画面の「送り状・納品書を今すぐ登録（カナカン・COREZO）」ボタンで手動実行できます（どのPCから押しても、サーバーのMacで動きます）。コマンドなら `npm run ship-docs`。
- 一度登録できた受注は二度と登録しません。失敗した側は記録せず、次の実行でもう一度試します。
- 結果はSlackに届きます（[FAX-AUTO-IMPORT.md](FAX-AUTO-IMPORT.md) ③ と同じ設定）。
- 対象は「未着手」の受注だけです。発送済・取消済は対象外です。

## 登録しないもの（Slackで「要確認」と届く）

- 段ボール対応表に無い商品×本数（送り状のサイズが決まらないため）
- 住所を分解できない受注
- 1つの受注に商品が複数ある受注（段ボールが決まらないため）

直したあと、次の実行（または手動のボタン）で登録されます。

## 設定手順（最初の1回だけ）

### ① アプリを更新して、ブラウザ操作の部品を入れる

[SETUP.md](SETUP.md) 7章の手順で `git pull` → `npm install` まで行います（`playwright-core` が入ります）。
ブラウザは**Macに入っている Google Chrome** を使います（追加のダウンロードはありません）。

### ② `.env` にログイン情報を書く

`.env` は、Macの中にある設定用のメモ帳のようなファイルです。ここにログイン情報を書いておくと、
自動実行のときにそれを読んでログインします。**作業はすべてサーバーのMacのターミナルで行います。**

**1. 受注管理システムのフォルダに移動する**

ターミナル（Launchpad →「その他」→「ターミナル」）を開いて、次を入力して Enter を押します。

```bash
cd ~/noto-inventory-system
```

**2. `.env` ファイルがあるか確認する**

```bash
ls -a | grep env
```

- `.env` と表示された場合 → 3へ
- `.env.example` だけが表示された場合 → 次を実行して `.env` を作ってから3へ

  ```bash
  cp .env.example .env
  ```

名前が「.」で始まるファイルは、Finderでは普段表示されません。そのためターミナルから開きます。

**3. テキストエディットで開く**

```bash
open -e .env
```

**4. いちばん下に4行を書き足して保存する（⌘S）**

```bash
WEBYUPACK_ID=ゆうIDに登録したメールアドレス
WEBYUPACK_PASSWORD=ゆうIDのパスワード
MF_EMAIL=マネーフォワードにログインするメールアドレス
MF_PASSWORD=マネーフォワードのパスワード
```

記入例：

```bash
WEBYUPACK_ID=sugai@naorai.co
WEBYUPACK_PASSWORD=abcd1234
```

書くときの注意：

- `=` の前後にスペースを入れない
- `" "` などの引用符で囲まない
- 行の先頭に `#` を付けない（`#` で始まる行は無視されます）
- マネーフォワードにログインしたとき「事業者を選択」画面が出る場合だけ、`MF_OFFICE_NAME=NOTO Naorai` のように事業者名の行も足す

**5. 他の人から読めないようにする**

保存してテキストエディットを閉じたら、ターミナルで次を実行します。

```bash
chmod 600 .env
```

何も表示されなければ成功です。これでこのMacの自分のアカウント以外からは、このファイルを開けなくなります。

**6. 書けたか確認する**

```bash
grep -c "WEBYUPACK_ID\|MF_EMAIL" .env
```

`2` 以上の数字が出ればOKです。

> パスワードはチャットやSlackには貼らないでください。Macの `.env` に書くだけで十分です。
> 同じ `.env` には、FAX自動取込の `FAX_INBOX_DIR` やSlackの設定（`SLACK_BOT_TOKEN` など）も書きます（[FAX-AUTO-IMPORT.md](FAX-AUTO-IMPORT.md)）。

### ③ 対象を確認する（登録はしない）

```bash
cd ~/noto-inventory-system
npm run ship-docs -- --dry-run
```

「対象の得意先」にカナカンの支店とCOREZOが並び、作られたCSV（`logs/ship-docs/日時/`）の中身が正しいことを確認します。
得意先が足りない・多い場合は、`.env` に `SHIP_DOCS_CUSTOMER_IDS=8,9,36` のように得意先IDを並べて指定できます。

### ④ 初回は画面を出して動かす

```bash
npm run ship-docs -- --headed
```

Chromeが開き、ログイン → アップロードまで自動で進みます。

- マネーフォワードで**二段階認証**を求められたら、開いた画面で手で認証してください。ログイン状態は専用のプロファイル（`.browser-profile/`）に残るので、しばらくは聞かれません。
- **途中で止まった場合**は、`logs/ship-docs/日時/` に各画面の写真（png）が残っています。どの画面で止まったか分かるので、その写真を共有してもらえれば文言を合わせて直します（ログイン後の画面は、実物を見ずに公式マニュアルの文言で作っています）。

### ⑤ 毎朝8時に動かす（launchd）

```bash
cat > ~/Library/LaunchAgents/jp.noto-naorai.ship-docs.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>jp.noto-naorai.ship-docs</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>scripts/ship-docs.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/YOUR_NAME/noto-inventory-system</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key>
  <string>/Users/YOUR_NAME/noto-inventory-system/logs/ship-docs.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR_NAME/noto-inventory-system/logs/ship-docs.log</string>
</dict>
</plist>
PLIST

launchctl load ~/Library/LaunchAgents/jp.noto-naorai.ship-docs.plist
```

`/Users/YOUR_NAME/` と `/usr/local/bin/node` は [SETUP.md](SETUP.md) 4-1 と同じように書き換えてください。
Macがスリープしていた場合は、起きたときに1回動きます（SETUP.md 4-3 のスリープさせない設定を推奨）。

> FAXの取込（Gmailは4時間おき）で朝8時より後に登録された受注は、8時の実行には入りません。
> その日のうちに出荷するなら、受注画面のボタンで手動実行してください。

## ログインできないとき

| Slackの表示 | すること |
|---|---|
| ゆうIDかパスワードが違います | `.env` の `WEBYUPACK_ID` / `WEBYUPACK_PASSWORD` |
| 二段階認証を求められました | `npm run ship-docs -- --headed --only moneyforward` で開いた画面から手で認証 |
| 〜が見つかりません | サイトの画面が変わった可能性。`logs/ship-docs/` の写真を確認 |

## 注意

- Webゆうパックプリントの利用規約に自動操作を直接禁止する条文はありませんが、第12条（運営の妨害・当社が不適切と判断する場合）に当たらないよう、実行は1日数回にとどめています。
- マネーフォワードの取り込み結果は、アップロードした人にメールでも届きます。
- 納品書のCSVはこれまで使っていなかった形式です。初回に取り込みエラーが出たら、エラーの内容を共有してください。
