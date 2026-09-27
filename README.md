# pi-task-label

複数の Pi セッションを並行で走らせているとき、**どのセッションが何をしているか**を端末タイトルとフッターのステータス行に1行で表示する Pi 拡張です。UI のある有効なセッションで空でないユーザー入力を受け取るたびに、会話末尾と今回の入力からタスクラベルを生成します（生成しない条件は[動作](#動作)を参照）。

```
タブ1: π - middleware修正 - projectA
タブ2: π - README更新 - projectB
```

会話の全体ではなく「直近の assistant が次にやろうとしていること」をラベルにするため、ユーザーが `OK` とだけ返したターンでも作業内容が分かります。

## インストール

```bash
pi install git:github.com/kurowashi/pi-task-label
```

ref を固定する場合は `pi install git:github.com/kurowashi/pi-task-label@<tag|commit>`。

ローカルの作業コピーを使う場合:

```bash
pi install /path/to/pi-task-label
```

または直接読み込み:

```bash
pi --extension /path/to/pi-task-label/src/index.ts
```

## 設定

設定ファイル（後のものが優先）:

| ファイル | 対象 |
|---|---|
| `~/.pi/agent/task-label.json`（`PI_CODING_AGENT_DIR` で変更可） | ユーザー全体 |
| `<cwd>/.pi/task-label.json` | プロジェクト（信頼されたプロジェクトのみ） |

```json
{
  "enabled": true,
  "model": "",
  "assistantLookback": 1,
  "display": "both"
}
```

コピーして使う場合は [examples/task-label.example.json](examples/task-label.example.json)。

| キー | 既定 | 意味 |
|---|---|---|
| `enabled` | `true` | `false` にするとモデルを呼ばず、管理している表示先からラベルを消す |
| `model` | `""` | ラベル生成に使うモデル（`"<provider>/<id>"`）。空ならそのセッションのモデル |
| `assistantLookback` | `1` | 遡る assistant メッセージ数（1以上）。ツール実行のみのメッセージは数えない |
| `display` | `"both"` | 表示先。`"both"` / `"title"` / `"status"` |
| `prompt` | 同梱 | ラベル生成の指示文。会話末尾は自動で追記される |

条件:

- `model` と `prompt` は空文字または `null` で未設定として扱い、既定に戻します。
- `model` の指定先が見つからない、または認証がない場合はセッションモデルに戻し、警告をセッションで1回だけ出します。
- `assistantLookback` は 1 以上の数値の小数点以下を切り捨てます。1 未満や数値以外は警告して既定値（1）に戻します。
- `prompt` を上書きした場合、出力の形式と長さも自分で指示する責任が生じます。出力の仕上げはプラグインが行います: 最初の空でない1行だけを使い、連続する空白を1個にまとめ、外側の対応する引用符（`"..."`、`'...'`、`` `...` ``、`「...」`、`『...』`）を外し、40文字を超える場合は末尾に `…` を付けて切り詰めます。
- 既定はセッションモデルです。コストを抑えたい場合は `model` に安価なモデルを指定してください。
- 設定はセッション開始時に読み込みます。変更は新しいセッションから反映されます。
- 端末タイトルを別の拡張と同時に使うと競合します。`display` を `"status"` にするとタイトルを触りません。
- 壊れた設定は警告を出して既定値で動きます。セッションは止まりません。

## 動作

トリガは**ユーザー入力の受信**（`input` イベント）です。タスクはターン中に変わらないため、入力1件につき1回だけ生成します。

次の場合は生成しません:

| 条件 | 動作 |
|---|---|
| `enabled` が `false` | モデルを呼ばず、ラベルを消す |
| UI がない（JSON / print モード） | モデルを呼ばない |
| 入力が空白だけ | 無視する |
| セッションモデルも設定モデルも選べない | 警告を1回出して生成しない |

入力はそのセッションの会話末尾です:

- 直近の assistant メッセージ（本文を含むもの）を `assistantLookback` 件
- それより後のユーザーメッセージすべてと、今回の入力

ツール結果・カスタムメッセージ（他の拡張の注入を含む）・メタデータは読み飛ばします。保持する本文は1メッセージ 2,000 文字、全体で 6,000 文字が上限で、新しいメッセージを優先して残します。上限には切り詰めの `…` を含みます。

モデルへは1つのユーザーメッセージだけを送ります（システムプロンプトなし）:

```
<prompt>

<context>
Assistant: 次は middleware を直す
User: OK
User (今回): OK
</context>
```

- reasoning は対応モデルでは `minimal` に固定します。セッションの thinking 設定は引き継ぎません。
- リクエストは `cacheRetention: "none"` と使い捨ての session id で送ります。セッションのプロンプトキャッシュを壊しません。
- ラベルはセッションに保存されず、モデルのコンテキストにも入りません。
- 生成に失敗したら前回のラベルを表示したままにし、警告はセッションで1回だけ出します。
- 生成中に次の入力が来たら、古い結果は破棄します。

### 送信先とデータ

会話末尾の小さな抜粋が `model`（既定はそのセッションのモデル）へ送られます。外部に送りたくない場合は `enabled` を `false` にしてください。

## 表示

| `display` | 端末タイトル | ステータス行 |
|---|---|---|
| `"both"`（既定） | `π - <ラベル> - <プロジェクト名>` | `<ラベル>` |
| `"title"` | `π - <ラベル> - <プロジェクト名>` | 変更しない |
| `"status"` | 変更しない | `<ラベル>` |

- ラベルがない間、`title` は `π - <プロジェクト名>` を表示します。
- セッションを tree で移動したときや `enabled: false` のときは、その設定が管理している表示先からラベルを消します。
- JSON モードと print モードは UI がないためモデルを呼びません。

## コマンド

ありません。設定はファイルのみです。

## 開発

```bash
npm install          # 依存(すべて devDependency。実行時依存はゼロ)
npm run verify       # 完了条件: biome + tsc + 全テスト + カバレッジ閾値
npm test             # 全テスト
```

`npm run verify` の内訳は `package.json` にある。
契約テストは `test/contract/`(登録ツールなし・コマンドなし・依存 allowlist・import 境界)と `test/ci/`(npm pack の内容)にあり、`src` を Pi のローダー経由で読み込んで検証する。
カバレッジ閾値は `test/unit/` と `test/integration/` の実行で計測する。

ローカルの git フックは [lefthook](lefthook.yml) が管理する。フックは利便性のためのもので、
完了条件は常に `npm run verify` が通ること(CI も同じコマンドを Node 22.19 / 24 で実行する)。
フックの有効化は `npx lefthook install` を手動で実行する(`package.json` の lifecycle script には置かない:
`pi install git:...` は `npm install --omit=dev` を実行するため、
devDependency の lefthook が無い状態で script が走るとインストールごと失敗する)。
