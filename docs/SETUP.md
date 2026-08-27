# 導入手順書

会社と自宅の両方から使う構成での、サーバー機の準備と各PCの設定手順です。

---

## 1. 構成の全体像

```
                    Tailscale（暗号化された専用ネットワーク）
                              │
   ┌──────────────────────────┼──────────────────────────┐
   │                          │                          │
[サーバー機]              [ノートPC]                 [自宅PC]
 Mac・常時起動          会社／自宅で使用            自宅のみで使用
 アプリとDBを持つ         ブラウザだけ               ブラウザだけ
```

**データはサーバー機の1ファイル（`db/database.sqlite`）だけに入ります。**
他のPCにはアプリもデータも置かず、ブラウザで接続するだけです。
そのため在庫数や受注が全員で共有され、食い違いが起きません。

**インターネットには公開しません。** Tailscaleは各端末同士を直接つなぐ仕組みなので、
ルーターのポート開放が不要で、外部から攻撃される入口ができません。

| 項目 | 内容 |
|---|---|
| サーバー機 | Mac 1台（常時起動） |
| 利用PC | 5台程度 |
| 接続方法 | Tailscale経由のHTTPS |
| ログイン | ユーザーID＋パスワード |

---

## 2. サーバー機（Mac）の準備

### 2-1. Node.jsをインストールする

ターミナル（アプリケーション → ユーティリティ → ターミナル）を開いて確認します。

```bash
node -v
```

`v20` 以上が表示されればOKです。「command not found」と出たらインストールします。

- <https://nodejs.org/ja> から **LTS版** をダウンロードしてインストール
- インストール後、ターミナルを開き直して `node -v` を再確認

### 2-2. アプリを配置する

```bash
cd ~
git clone https://github.com/sugai-cmd/noto-inventory-system.git
cd noto-inventory-system
npm install
```

`npm install` は数分かかることがあります。

### 2-3. 設定ファイルを作る

```bash
cp .env.example .env
```

そのままで動きます。ポートを変えたい場合だけ `.env` を編集してください。

### 2-4. 起動を確認する

```bash
npm start
```

`NOTO inventory server listening on http://localhost:3000` と出れば成功です。
`ログインユーザーが登録されていません` という警告も出ますが、次の手順で作ります。

`Control + C` で一度止めます。

### 2-5. 最初の管理者を作る

```bash
npm run create-user
```

ログインID・表示名・パスワード（8文字以上）を聞かれるので入力します。
最初の1人は自動的に管理者になります。

> パスワードは入力しても画面に表示されません。打ち間違いに注意してください。

2人目以降も同じコマンドで追加できます。登録済みの確認は次のコマンドです。

```bash
node scripts/create-user.js --list
```

### 2-6. 動作を確認する

```bash
npm start
```

Macのブラウザで <http://localhost:3000> を開き、作成したIDでログインできれば成功です。

---

## 3. Tailscaleの設定（自宅から使えるようにする）

### 3-1. アカウントを作る

<https://tailscale.com> でアカウントを作成します（個人利用は無料枠で足ります）。
GoogleアカウントやGitHubアカウントでログインできます。

### 3-2. サーバー機にインストールする

<https://tailscale.com/download/mac> からダウンロードしてインストールし、
メニューバーのアイコンからログインします。

インストールできたら、ターミナルでHTTPSを有効にします。

```bash
# 管理画面 https://login.tailscale.com/admin/dns で
# 「MagicDNS」と「HTTPS Certificates」を有効にしてから実行してください
tailscale serve --bg 3000
```

これで `https://（サーバー機の名前）.（あなたの組織名）.ts.net` でアクセスできるようになります。
表示されたURLを控えてください。

```bash
tailscale serve status    # 設定内容の確認
```

> `tailscale serve` が証明書を自動で用意するため、**ブラウザの警告は出ません**。
> アプリ側で証明書を設定する必要もありません。

### 3-3. 各PCにインストールする

利用する5台それぞれで、同じことをします。

1. <https://tailscale.com/download> からインストール
2. **サーバー機と同じアカウント**でログイン
3. ブラウザで 3-2 で控えたURLを開く
4. ログイン画面が出たら成功。ブックマークしておいてください

Node.jsのインストールは不要です。ブラウザだけあれば使えます。

---

## 4. 常時起動の設定（Macの再起動後も自動で立ち上がる）

macOSの `launchd` に登録します。

### 4-1. 設定ファイルを作る

```bash
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/jp.noto-naorai.inventory.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>jp.noto-naorai.inventory</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>src/server.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/YOUR_NAME/noto-inventory-system</string>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/YOUR_NAME/noto-inventory-system/logs/server.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR_NAME/noto-inventory-system/logs/error.log</string>
</dict>
</plist>
PLIST
```

**2箇所を書き換えてください。**

1. `/Users/YOUR_NAME/` → 実際のパス。`cd ~/noto-inventory-system && pwd` で確認できます
2. `/usr/local/bin/node` → `which node` の結果に合わせる
   （Apple Silicon の Mac では `/opt/homebrew/bin/node` のことが多いです）

### 4-2. ログ置き場を作って登録する

```bash
cd ~/noto-inventory-system
mkdir -p logs
launchctl load ~/Library/LaunchAgents/jp.noto-naorai.inventory.plist
```

ブラウザでアクセスできれば成功です。

```bash
launchctl list | grep noto      # 動作確認
tail -f logs/server.log         # ログを見る
```

停止・再開は次の通りです。

```bash
launchctl unload ~/Library/LaunchAgents/jp.noto-naorai.inventory.plist   # 停止
launchctl load   ~/Library/LaunchAgents/jp.noto-naorai.inventory.plist   # 開始
```

### 4-3. スリープさせない設定

システム設定 → バッテリー（または省エネルギー）で、
**「ディスプレイがオフのときに自動でスリープさせない」** を有効にしてください。
Macがスリープすると他のPCから接続できなくなります。

---

## 5. バックアップ

**データはすべて `db/database.sqlite` の1ファイルです。** これを定期的に控えます。

### 5-1. 毎日自動でバックアップする

```bash
mkdir -p ~/noto-inventory-system/backups

cat > ~/Library/LaunchAgents/jp.noto-naorai.backup.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>jp.noto-naorai.backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>cd /Users/YOUR_NAME/noto-inventory-system &amp;&amp; sqlite3 db/database.sqlite ".backup backups/database-$(date +\%Y\%m\%d).sqlite" &amp;&amp; find backups -name "database-*.sqlite" -mtime +30 -delete</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>2</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
</dict>
</plist>
PLIST

launchctl load ~/Library/LaunchAgents/jp.noto-naorai.backup.plist
```

`/Users/YOUR_NAME/` を実際のパスに書き換えてください。
毎日2時にバックアップを取り、30日より古いものは自動で消します。

> `sqlite3 ... ".backup"` を使っています。ファイルをコピーするだけだと、
> 書き込み中に壊れたバックアップができることがあるためです。

### 5-2. 手動でバックアップする

```bash
cd ~/noto-inventory-system
sqlite3 db/database.sqlite ".backup backups/database-$(date +%Y%m%d-%H%M).sqlite"
```

### 5-3. バックアップから戻す

```bash
cd ~/noto-inventory-system
launchctl unload ~/Library/LaunchAgents/jp.noto-naorai.inventory.plist   # 一度止める
cp backups/database-20260827.sqlite db/database.sqlite                   # 戻したい日付のもの
launchctl load ~/Library/LaunchAgents/jp.noto-naorai.inventory.plist     # 再開
```

**バックアップは別の場所にも置いてください。** Macが故障すると本体ごと失われます。
`backups/` フォルダをiCloud DriveやDropboxの中に作る、外付けHDDに定期コピーする、
などの二重化をおすすめします。

---

## 6. 動作確認チェックリスト

導入直後と、アップデート後に確認してください。

### 6-1. サーバー機で確認すること

- [ ] `npm test` が全て通る（83件）
- [ ] `npm start` でエラーなく起動する
- [ ] <http://localhost:3000> でログイン画面が出る
- [ ] 作成したIDでログインできる
- [ ] 間違ったパスワードでログインを断られる
- [ ] Macを再起動しても自動で立ち上がる
- [ ] `ls backups/` にバックアップができている（設定の翌日以降）

### 6-2. 各PCで確認すること

- [ ] TailscaleのURLでログイン画面が開く
- [ ] アドレスバーが `https://` で、鍵マークが出ている（警告が出ない）
- [ ] ログインできる
- [ ] ログアウトすると、戻るボタンで画面に戻れない

### 6-3. 機能の確認

実際に1件ずつ登録して、意図通り動くか確かめます。

| # | 操作 | 期待する結果 |
|---|---|---|
| 1 | 受注画面で得意先を検索 | 入力しながら候補が絞り込まれる |
| 2 | 商品を選び本数を入れる | 売価と入金予定日が自動で入る |
| 3 | 受注を登録 | `O` で始まる受注番号が採番される |
| 4 | 「発送済にする」 | 在庫画面で商品在庫がその分減る |
| 5 | 瓶詰めを登録 | 仕掛品が増え、資材が自動で減る |
| 6 | 箱詰めで在庫以上の本数 | 「仕掛品在庫が不足しています」と断られる |
| 7 | 蒸留を開始 | `D` で始まる蒸留IDが採番される |
| 8 | 棚卸で実測値を入れる | 差の分だけ在庫が調整される |
| 9 | 在庫監査を実行 | 問題があれば一覧に出る |
| 10 | CSVを出力 | Excelで開いて文字化けしない |

**2台以上での同時確認も行ってください。**
1台で受注を登録し、もう1台で画面を再読み込みして反映されていれば、
データが正しく共有されています。

---

## 7. アップデート手順

```bash
cd ~/noto-inventory-system

# 1. 念のためバックアップ
sqlite3 db/database.sqlite ".backup backups/before-update-$(date +%Y%m%d).sqlite"

# 2. 停止
launchctl unload ~/Library/LaunchAgents/jp.noto-naorai.inventory.plist

# 3. 更新
git pull
npm install

# 4. 動作確認
npm test

# 5. 再開（起動時にデータベースの更新が自動で適用されます）
launchctl load ~/Library/LaunchAgents/jp.noto-naorai.inventory.plist
```

---

## 8. 困ったときは

### 他のPCから繋がらない

1. サーバー機のMacがスリープしていないか（4-3の設定）
2. サーバー機で `launchctl list | grep noto` に表示されるか
3. 両方の端末でTailscaleが動いているか（メニューバーのアイコンを確認）
4. サーバー機で `tailscale serve status` の表示を確認

### ログインできない

```bash
node scripts/create-user.js --list    # IDが登録されているか確認
```

パスワードを忘れた場合は、同じIDは作れないので新しいIDを作るか、
管理者に依頼して作り直してください。

### エラーが出る・動きが変

```bash
tail -100 ~/noto-inventory-system/logs/error.log
```

### 在庫の数字が合わない

在庫監査（`/audit.html`）を実行してください。
どの記録に食い違いがあるかが一覧で出ます。データは書き換わりません。

---

## 9. セキュリティについて知っておいてほしいこと

- **パスワードは使い回さないでください。** 保存時は復元できない形（scrypt）に変換しているので、
  管理者でも中身は見られませんが、他所と同じパスワードだと他所の漏洩の影響を受けます
- **共有アカウントは作らないでください。** 誰が操作したか追えなくなります。1人1つ作れます
- **Tailscaleからログアウトした端末は繋がらなくなります。** 退職・PC入れ替えの際は、
  Tailscaleの管理画面からその端末を削除してください
- ログインは14日間保持されます。共用PCで使う場合は、終わったらログアウトしてください
