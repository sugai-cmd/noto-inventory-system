# NOTO Naorai 受注・製造管理システム

酒類製造・卸売業の受注・製造管理システム。
Googleスプレッドシート（21シート）＋GASで運用していたものを、
Node.js + SQLite のローカルサーバー型アプリとして作り直したものです。

## セットアップ

Node.js **22以上**が必要です。

```bash
npm install
npm run create-user   # 最初の管理者を作る（初回のみ）
npm start             # http://localhost:3000 で起動
```

**Git も Node.js も入っていないMacに一から入れる場合は
[docs/SETUP-MAC.md](docs/SETUP-MAC.md) から始めてください。**

**会社と自宅の複数PCで使う場合の手順は [docs/SETUP.md](docs/SETUP.md) を参照してください。**
サーバー機の準備、Tailscaleを使ったHTTPS接続、常時起動、バックアップ、
動作確認チェックリストまでまとめてあります。

`.env.example`をコピーして`.env`を作れば、ポートとDBファイルの場所を変更できます。

```bash
npm test                            # テスト実行
npm run migrate                     # マイグレーションのみ適用
npm run create-user                 # ユーザー追加
node scripts/create-user.js --list  # ユーザー一覧
```

## 画面

| URL | 内容 |
|---|---|
| `/` | ダッシュボード（未着手受注・蒸留中・要発注資材・24時間超過アラート） |
| `/orders.html` | 受注登録・一覧・発送済処理・CSV出力 |
| `/bottling.html` | 瓶詰め・箱詰め |
| `/distillation.html` | 原酒入荷・蒸留開始・完了報告 |
| `/tanks.html` | 容器移動・未納税移出・タンク入出庫履歴 |
| `/stock.html` | 商品／資材／タンク／原酒タンクの在庫モニター |
| `/stocktaking.html` | 棚卸 |
| `/shipments.html` | 返品・サンプル送付・委託販売実績報告 |
| `/materials.html` | 資材入荷・資材マスタ・入出庫履歴 |
| `/audit.html` | 在庫監査レポート |
| `/sales-targets.html` | 売上目標と進捗 |
| `/settings.html` | 2要素認証・パスワード変更・利用者管理・操作ログ |

## ログイン

利用にはログインが必要です。ユーザーは `npm run create-user` で追加します。
パスワードはscryptでハッシュ化して保存され、復元できません。

- 同じIDで5回続けてログインに失敗すると、15分間受け付けなくなります
- 2要素認証（認証アプリ）を `/settings.html` から有効にできます
- 誰がいつ何を登録したかは操作ログに残り、管理者が `/settings.html` で確認できます

社外（自宅など）から使う場合は、インターネットに直接公開せず
Tailscale等のVPN経由でアクセスしてください（[docs/SETUP.md](docs/SETUP.md) 3章）。

## 伝票番号

月ごとに連番がリセットされます。現行シートでは受注番号と蒸留IDがどちらも `D` で
区別できなかったため、受注を `O`（Order）に整理しました。

| 伝票 | 例 |
|---|---|
| 受注番号 | `O2608-0001` |
| 蒸留ID | `D2608-0001` |
| 商品履歴ID | `L2608-0001` |
| 資材履歴ID | `M2608-0001` |
| サンプルID | `S2608-0001` |
| 原酒受払ID | `R2608-0001`（払出）／`R2608-1000`（受入） |

移行した過去データはシート上のコードをそのまま保持するため、
過去の受注番号が `D...` のままでも問題ありません。

## 現行スプレッドシートからの移行

```bash
# 1. 各シートをCSVでエクスポートし、scripts/data/csv/ に配置する
#    （customers.csv, products.csv, orders.csv ... テーブル名に対応するファイル名）

# 2. まず投入せずにレポートだけ出す
node scripts/migrate-from-sheets.js --dry-run

# 3. scripts/migration-report/unmatched-names.csv を確認し、
#    表記ゆれがあれば scripts/data/aliases.json で補正する
#    （scripts/data/aliases.example.json がひな形）

# 4. 本番投入
node scripts/migrate-from-sheets.js
```

- ファイルがないシートはスキップされるので、用意できたものから段階的に流し込めます
- `--allow-partial` で名寄せ不一致の行だけスキップして続行できます
- `--reset` はマスタを残したまま台帳・トランザクションだけ入れ直します
- 酒蔵マスタ・原酒マスタは移行対象外です。移行後に画面／APIから順次登録してください

移行後は `/audit.html`（在庫監査レポート）を実行して、
取り込んだデータに不整合がないか確認することをおすすめします。

## ドキュメント

| ファイル | 内容 |
|---|---|
| `docs/SETUP-MAC.md` | まっさらなMacの下準備（ターミナル・Git・GitHub・Node.js） |
| `docs/SETUP.md` | 導入手順・複数PC設定・常時起動・バックアップ・動作確認チェックリスト |
| `DB_SCHEMA_DESIGN.md` | テーブル設計・プロジェクト構造・移行手順・実装済み機能の詳細 |
| `DATA_STRUCTURE.md` | 現行スプレッドシート（21シート）の仕様。移行元の記録として保持 |
| `ER_DIAGRAM_TEXT.md` | 現行システムの関係性図 |

## 構成

```
db/                 スキーマとマイグレーション（database.sqlite は .gitignore）
src/
  db/               接続・マイグレーションランナー
  models/           テーブル単位のクエリ
  services/         業務ロジック（旧GASの関数群に相当）
  routes/           Expressルーティング
  utils/            採番・日付計算・uid生成など
public/             画面（ビルド不要の素のHTML+JS）
scripts/            スプレッドシートからの移行スクリプト
tests/              テスト（node --test）
```
