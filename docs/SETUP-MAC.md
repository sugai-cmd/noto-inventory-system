# サーバー機Macの下準備（ゼロから）

Git も GitHub アカウントも Node.js も入っていない、**買ったままの Mac** を
サーバー機にするまでの手順です。ここが終わったら
[docs/SETUP.md](SETUP.md) の 2章に進んでください。

作業するのは**サーバー役の Mac 1台だけ**です。
他の4台にはブラウザ以外なにも入れません（Tailscale だけは入れます。SETUP.md 3-3）。

## 入れるものは2つだけ

| # | 入れるもの | 何のため | 所要時間 |
|---|---|---|---|
| 1 | Xcode Command Line Tools | `git` コマンドを使うため | 5〜20分 |
| 2 | Node.js（LTS版） | アプリを動かす本体 | 3分 |

**これ以外は要りません。** Homebrew も Xcode 本体（App Store の十数GB のやつ）も
Docker も不要です。バックアップに使う `sqlite3` は macOS に最初から入っています。

所要時間は全部で30分ほど。ダウンロード待ちがほとんどです。

---

## 0-1. 始める前の確認

画面左上の  アイコン → **「このMacについて」** を開いて、2つ見てください。

| 見るところ | 必要な条件 |
|---|---|
| macOS のバージョン | **13（Ventura）以降**なら確実に大丈夫 |
| チップ | `Apple M◯` か `Intel` か。0-4 でダウンロードを選ぶときに使います |

そのほかの前提です。

- **管理者権限のあるアカウント**でログインしていること
  （システム設定 → ユーザとグループ で自分のアカウントに「管理者」と出ていればOK）
- 空き容量が **2GB** 以上あること
- インターネットにつながっていること

> macOS が 12 以前の場合は、先に macOS をアップデートしてください。
> Node.js の新しい版が動かないことがあります。

---

## 0-2. ターミナルの使い方（最低限これだけ）

以降の手順は、ぜんぶ「ターミナル」という黒い画面に文字を打ち込んで進めます。
プログラミングの知識は要りません。**この文書のコマンドをコピーして貼り付けるだけ**です。

**開き方**

`Command + Space` を押して `ターミナル` と打ち、Enter。
（アプリケーション → ユーティリティ → ターミナル でも同じです）

Dock に入れておくと後が楽です（Dock のアイコンを右クリック → オプション → Dock に追加）。

**知っておいてほしいこと**

- コマンドは1行ずつコピーして貼り付け、**Enter で実行**します
- **パスワードを聞かれたとき、打っても画面には何も出ません。** 故障ではありません。
  そのまま Mac のログインパスワードを打って Enter を押してください
- `~` は自分のホームフォルダのことです（Finder の家のアイコン）
- 動きっぱなしになったものを止めるときは **`Control + C`**
- 打ち間違えて `command not found` と出ても壊れません。打ち直せばOKです

**うまくいったか確かめる**

まずは練習で、次を打って Enter してください。

```bash
sw_vers
```

macOS のバージョンが出れば、ターミナルは正常です。

---

## 0-3. Xcode Command Line Tools を入れる（＝ Git が入る）

Mac には最初から `git` コマンドが**入っているように見えて、実体がありません**。
使おうとすると「インストールしますか」と聞かれます。先に入れてしまいます。

```bash
xcode-select --install
```

ダイアログが出るので **「インストール」→「同意する」** を押します。
ダウンロードに5〜20分ほどかかります。終わるまで待ってください。

**入ったか確認します。**

```bash
git --version
```

`git version 2.39.5` のように出れば成功です。

> **すでに入っている場合**は
> `xcode-select: error: command line tools are already installed` と出ます。
> エラーに見えますが**正常**です。そのまま `git --version` を確認して次に進んでください。

> **Xcode 本体（App Store の巨大なアプリ）は不要です。**
> このアプリのインストールにコンパイルは発生しません
> （唯一の C++ 製部品である better-sqlite3 は、完成済みのバイナリが同梱されています）。
> Command Line Tools は `git` を使うためだけに入れています。

---

## 0-4. Git に名前とメールを設定する

Git は「誰が変更したか」を記録する仕組みなので、最初に名乗らせます。
`YOUR_NAME` と `you@example.com` を自分のものに書き換えて実行してください。

```bash
git config --global user.name "YOUR_NAME"
git config --global user.email "you@example.com"
```

確認します。

```bash
git config --global --list
```

> サーバー機は基本的に**受け取るだけ**（`git pull`）なので、この設定が無くても
> アプリは動きます。ただし後から何か直したくなったときに毎回聞かれるので、
> いま入れておくのが楽です。メールアドレスは GitHub に公開されるため、
> 気になる場合は個人のものではなく会社のアドレスにしてください。

---

## 0-5. GitHub アカウントは要る？ → **今は要りません**

ここが一番誤解されやすいところなので、はっきり書きます。

`sugai-cmd/noto-inventory-system` は**公開（public）リポジトリ**です。
公開リポジトリの取得にはログインも認証も要らないので、

```bash
git clone https://github.com/sugai-cmd/noto-inventory-system.git
```

は、**GitHub アカウントを1つも持っていない Mac でもそのまま通ります。**
SSH鍵の作成も、アクセストークンの発行も、GitHub Desktop のインストールも不要です。

アカウントが必要になるのは、次のことをしたくなったときだけです。

| やりたいこと | アカウント |
|---|---|
| アプリを入れる・更新する（`git clone` / `git pull`） | **不要** |
| 自分で直したものを GitHub に上げる（`git push`） | 必要 |
| リポジトリを非公開にする | 必要（オーナー権限） |
| 不具合を Issue に書き留める | 必要 |

### 作るなら（任意）

1. <https://github.com/signup> でメールアドレス・パスワード・ユーザー名を登録
2. 届いたメールのコードで認証
3. **2要素認証の設定を求められます**（GitHub では必須化されています）。
   スマホの認証アプリを登録し、**リカバリコードは必ず紙などに控えて**ください

### 非公開（private）にする場合の注意

いまのリポジトリには**データベースファイルは含まれていません**
（`db/database.sqlite` は `.gitignore` で除外済み）。
したがって得意先名・受注金額・在庫といった**実データは GitHub に出ていません**。

ただし `DATA_STRUCTURE.md` や `DB_SCHEMA_DESIGN.md` には、
**業務の進め方・テーブル設計・在庫計算のルール**が書かれており、これは誰でも読めます。
社外に見せたくない情報だと判断されるなら、非公開に切り替えてください。

**手順**：GitHub でリポジトリを開く → Settings → 一番下の Danger Zone →
Change repository visibility → Private

**非公開にすると `git clone` / `git pull` に認証が必要になります。**
サーバー機の Mac では、次のどちらかで設定してください。

- **GitHub Desktop**（<https://desktop.github.com>）を入れて、
  アプリ内でログインする。ターミナルの `git` にも認証が引き継がれるので、
  非開発者にはこれが一番簡単です
- または、GitHub の Settings → Developer settings → Personal access tokens で
  トークン（`repo` 権限）を発行し、`git clone` でパスワードを聞かれたときに
  そのトークンを貼り付ける。以降は Mac のキーチェーンが覚えます

---

## 0-6. Node.js を入れる

アプリ本体を動かすための実行環境です。**バージョン 22 以上が必須**です
（データベース部品の better-sqlite3 が Node 22 以上を要求します）。

### 手順

1. <https://nodejs.org/ja> を開く
2. **LTS**（推奨版）と書かれた方をダウンロード
   - サイトが自動でチップを判別しますが、選択肢が出た場合は
     0-1 で見たチップに合わせてください（`Apple M◯` → **ARM64**、`Intel` → **x64**）
3. ダウンロードした `.pkg` をダブルクリックし、案内どおりに進める
4. **ターミナルをいったん終了して開き直す**（`Command + Q` → もう一度開く）

> 開き直さないと、入れたばかりの `node` が見つからず
> `command not found` になります。ここでつまずく人が一番多いところです。

### 確認

```bash
node -v
npm -v
```

`v22.x.x` 以上（`v24` などでも構いません）と、`10.x.x` のような番号が出れば成功です。
`v20` 以下だった場合は、上の手順でもう一度 LTS 版を入れ直してください。

> **Homebrew は使いません。** 公式インストーラなら Apple Silicon でも Intel でも
> `/usr/local/bin/node` に入るため、SETUP.md 4章の常時起動設定でパスを
> 書き換えずに済みます（Homebrew で入れると Apple Silicon では
> `/opt/homebrew/bin/node` になり、書き換えが必要になります）。

---

## 0-7. 最初から入っていて、入れなくていいもの

不安になって余計なものを入れないよう、確認だけしておきます。

```bash
sqlite3 --version   # バックアップで使う。最初から入っています
curl --version      # 動作確認で使う。最初から入っています
```

どちらもバージョンが表示されるはずです。表示されれば何もしなくて構いません。

---

## 0-8. 総点検（コピペ1回で全部確認）

下の**かたまり全体**をコピーしてターミナルに貼り付け、Enter を押してください。

```bash
echo "--- macOS ---"; sw_vers -productVersion
echo "--- チップ ---"; uname -m
echo "--- git ---";    git --version    || echo "❌ 0-3 をやり直してください"
echo "--- node ---";   node -v          || echo "❌ 0-6 をやり直してください"
echo "--- npm ---";    npm -v           || echo "❌ 0-6 をやり直してください"
echo "--- sqlite3 ---"; sqlite3 --version
echo "--- nodeの場所 ---"; which node
```

`git version ...` と `v22`（以上）が出ていれば、下準備は完了です。

最後の行に出た **`node の場所`（たいてい `/usr/local/bin/node`）は控えておいてください。**
SETUP.md 4-1 の常時起動の設定ファイルで使います。

---

## 0-9. つまずいたときは

### `command not found: node`

Node.js を入れた後に**ターミナルを開き直していない**のがほぼ原因です。
`Command + Q` でターミナルを完全に終了し、もう一度開いてから `node -v`。

### `xcode-select: error: command line tools are already installed`

**エラーではありません。** すでに入っている状態です。
`git --version` が出れば問題ないので 0-4 に進んでください。

### `npm install` で `EBADENGINE` と出て止まる

Node.js のバージョンが古いです。`node -v` を確認して 22 未満なら、
0-6 の手順で LTS 版を入れ直してください。
（このアプリは、古い Node で中途半端に動いて後から壊れるより、
その場で止まるように設定してあります）

### 「開発元が未確認のため開けません」と出てインストーラが起動しない

システム設定 → プライバシーとセキュリティ を開き、
下の方に出ている **「このまま開く」** を押してください。
nodejs.org と GitHub の公式サイトからダウンロードしたものであることを
確認してから許可してください。

### `npm install` が `Could not read package.json` で止まる

```
npm error enoent Could not read package.json:
  ... no such file or directory, open '/Users/xxx/noto-inventory-system/package.json'
```

フォルダはあるのに中身が無い、つまり **`git clone` が完了していない**状態です。
`npm` の問題ではないので、`npm` を入れ直しても直りません。

まず何があるか見てください。

```bash
cd ~/noto-inventory-system
ls -a
```

| `ls -a` の結果 | 状態 | 対処 |
|---|---|---|
| `.` と `..` だけ | 空。cloneが失敗して器だけ残った | 下の「やり直し」 |
| `noto-inventory-system` というフォルダがある | cloneの場所が一段深い | 下の「やり直し」で置き直す |
| `.git` と `src` などがある | 途中で切れた | 下の「やり直し」 |

**やり直し**（消さずに退避するので、間違えても失われません）

```bash
cd ~
mv noto-inventory-system noto-inventory-system.ng
git clone https://github.com/sugai-cmd/noto-inventory-system.git
cd noto-inventory-system
ls package.json          # ここで package.json と出ることを確認
npm install
```

うまくいったら `rm -rf ~/noto-inventory-system.ng` で退避分を消せます。

**それでも同じなら、`git clone` の出力を読んでください。** 原因はほぼここに出ています。

| 出たメッセージ | 意味・対処 |
|---|---|
| `git: command not found` / `no developer tools were found` | Gitがまだ入っていません。0-3 をやり直す |
| `already exists and is not an empty directory` | 既存フォルダが残っています。上の `mv` で退避 |
| `Could not resolve host: github.com` | ネットワークに届いていません。Wi-Fiや社内フィルタを確認 |
| `Repository not found` | URLの綴り違い（`sugai-cmd`）。公開リポジトリなので認証は不要です |
| 何も出ずにすぐ戻る | 成功しています。`ls package.json` で確認 |

### `git clone` で `Repository not found` / パスワードを聞かれる

リポジトリを非公開に切り替えた場合です。0-5 の「非公開にする場合の注意」を参照して、
GitHub Desktop かアクセストークンで認証してください。
公開のままなら、URL の打ち間違い（`sugai-cmd` の綴りなど）を確認してください。

### ダウンロードが極端に遅い・途中で止まる

社内ネットワークのフィルタに引っかかっている可能性があります。
テザリングなど別の回線で試すと切り分けられます。

---

## 次にやること

下準備はここまでです。
[docs/SETUP.md](SETUP.md) の **2-2「アプリを配置する」** から続けてください
（2-1 の Node.js インストールは、いま 0-6 で済ませています）。
