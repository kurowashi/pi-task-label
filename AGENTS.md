# AGENTS.md — pi-task-label で作業するエージェント向けの指示

読者は pi-task-label を変更する AI エージェントと開発者です。利用者向けの仕様は README に、
設計の判断基準は DESIGN.md と PHILOSOPHY.md(このプラグイン群共通)に書きます。

ここには、壊してはいけない制約と、制約に触れる変更の手順だけを書きます。制約の正はテストで、
下の表はその索引です。実装と表が食い違った場合はテストが正です。検証手段を併記できないものは制約として書かず、
自動テストできない範囲は末尾に分けます。

## 完了条件

`npm run verify`(= `npm run check` + `npm run knip` + `npm test` + `npm run test:coverage`)が通ること。
フックが通っても CI が通らなければ未完了。CI は同じ `verify` を Node 22.19 / 24 で実行します。
カバレッジは `test/unit` と `test/integration` で計測します。下の表の「検証」列は個別の検証箇所であり、
自動検証はすべて `verify` に含まれます。

## 制約

### ツール・コマンド面

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| モデル向けのツールを登録しない(表示専用) | `test/contract/surface.test.ts` | `src/index.ts` |
| コマンドは `task-label` の1つで、解決済み設定とラベルの表示に限る | `test/contract/surface.test.ts` | `test/contract/surface.test.ts` の `EXPECTED_COMMANDS`、`src/index.ts` |
| イベントは `input` / `session_start` / `session_tree` の3種で、各1ハンドラ | `test/contract/surface.test.ts` | `test/contract/surface.test.ts` の `EXPECTED_EVENTS`、`src/index.ts` |

### スキャンと生成

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 入力は直近の assistant(text あり)から `assistantLookback` 件、それ以降の user すべて、および今回の入力 | `test/unit/context.test.ts` + `test/integration/extension.test.ts` | `src/index.ts` の `collectContext` と `requestText` |
| toolResult・custom_message・メタデータは読み飛ばし、assistant の件数に数えない | `test/unit/context.test.ts` | `src/index.ts` の `contextEntry` |
| 予算は本文 1メッセージ 2,000 文字・全体 6,000 文字(切り詰めの `…` を含む)で、新しいメッセージを優先する | `test/unit/context.test.ts` | `src/index.ts` の `MAX_MESSAGE_CHARS` / `MAX_TOTAL_CHARS` |
| モデルへ送るのは1ユーザーメッセージ(指示文 + `<context>`)で、システムプロンプトを送らない | `test/unit/context.test.ts` + `test/integration/extension.test.ts` | `src/index.ts` の `buildRequest` |
| 生成のトリガは `input` のとき1回だけ | `test/integration/extension.test.ts` | `src/index.ts` の input ハンドラ |
| `model` 未指定ならセッションモデル。指定時は認証込みで解決し、不可ならセッションモデルへ戻して警告1回 | `test/integration/extension.test.ts` | `src/index.ts` の `chooseModel` |
| 設定モデルもセッションモデルも選べない場合は生成せず、警告1回 | `test/integration/extension.test.ts` | `src/index.ts` の `generate` |
| reasoning は対応モデルで `minimal`、リクエストは `cacheRetention: "none"` と使い捨て session id | `test/integration/extension.test.ts` | `src/index.ts` の `requestLabel` |
| 生成失敗は前回ラベルを維持し、警告はセッションで1回 | `test/integration/extension.test.ts` | `src/index.ts` の `applyLabel` / `warnRequestError` |
| 新しい入力は古い生成結果を破棄する(生成できない入力でも) | `test/integration/extension.test.ts` | `src/index.ts` の `generation` |
| 空のラベルは表示を変えない | `test/integration/extension.test.ts` | `src/index.ts` の `applyLabel` |
| ラベルは1行・40文字以内。最初の空でない行のみを使い、連続空白を1個にまとめ、外側の引用符を除去する | `test/unit/context.test.ts` + `test/integration/extension.test.ts` | `src/index.ts` の `sanitizeLabel` / `MAX_LABEL_CHARS` |
| ラベルはセッションに書き戻さない(コンテキストにも入らない) | `test/integration/extension.test.ts` | `src/index.ts`(`appendEntry` / `sendMessage` を呼ばない) |
| `enabled: false` と UI なしモード(JSON / print)ではモデルを呼ばない | `test/integration/extension.test.ts` | `src/index.ts` の `generate` |

### 表示

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| `display` の3値(`both` / `title` / `status`)でタイトルとステータス行を出し分ける | `test/integration/extension.test.ts` | `src/index.ts` の `show` |
| タイトルは `π - <ラベル> - <プロジェクト名>`、ラベルなしは `π - <プロジェクト名>` | `test/unit/context.test.ts` | `src/index.ts` の `titleFor` / `baseTitle` |
| `session_tree` でラベルを消してプロジェクト名に戻す(管理する表示先だけ) | `test/integration/extension.test.ts` | `src/index.ts` の `resetDisplay` |
| `enabled: false` でもラベルを消す(管理する表示先だけ) | `test/integration/extension.test.ts` | `src/index.ts` の `resetDisplay` |
| 設定の警告は拡張インスタンスで1回だけ通知する | `test/integration/extension.test.ts` | `src/index.ts` の `announced` |
| 生成の警告(モデル解決・リクエスト失敗)はセッションで1回だけ通知する | `test/integration/extension.test.ts` | `src/index.ts` の `warnOnce` / `warnRequestError` |

### 設定

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 設定はグローバル→プロジェクトの順にマージし、project が優先される | `test/unit/config.test.ts` | `src/config.ts` の `loadConfig` |
| 未信頼プロジェクトの設定は無視する | `test/unit/config.test.ts` | `src/config.ts` の `loadConfig` |
| 壊れた設定・不正値は警告して既定値で動き、セッションを止めない | `test/unit/config.test.ts` | `src/config.ts` の `resolveConfig` |
| 空文字と `null` の `prompt` / `model` は既定に戻す(警告しない) | `test/unit/config.test.ts` | `src/config.ts` の `resolveConfig` |
| 設定を読み込むのは `session_start` のときだけ | `test/integration/extension.test.ts` | `src/index.ts` の session_start ハンドラ |

### 依存関係・import

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 実行時依存を持たない(`dependencies` は空) | `test/contract/dependencies.test.ts` | `package.json` |
| `src` の import は node builtin・相対 `.ts`・Pi 提供パッケージのみ | `test/contract/dependencies.test.ts` | `test/contract/dependencies.test.ts` の `ALLOWED_PEER_DEPENDENCIES` |
| 循環依存を作らない | `npx biome check .` | `biome.jsonc` の `noImportCycles` |
| 未宣言の依存を import しない(import 元パッケージの `package.json` へ先に宣言する) | `npx biome check .` | `biome.jsonc` の `noUndeclaredDependencies` |
| 未使用の export・依存・ファイルを検出しない | `npm run knip` | `knip.jsonc` |
| devDependency は allowlist 内のみ | `test/contract/dependencies.test.ts` | `test/contract/dependencies.test.ts` の `ALLOWED_DEV_DEPENDENCIES` |

### 配布・ビルド

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| 配布物は `files` の whitelist 内のみ | `test/ci/package-contents.test.ts` | `package.json` の `files` |
| `pi.extensions` のエントリが配布物に含まれる | `test/ci/package-contents.test.ts` | `package.json` の `pi.extensions` |
| ビルド工程を持たない(TS を直接配布) | `test/ci/package-contents.test.ts` | `package.json`(`build` script なし、`pi.extensions` が `./src/index.ts`) |

### コード品質

| 制約 | 検証 | 定義・実装箇所 |
|---|---|---|
| `enum` / `namespace` / parameter properties を使わない | `npx tsc --noEmit` | `tsconfig.json` の `erasableSyntaxOnly` |
| 型は `any` なし、非null断言なし、浮いた Promise なし | `npx biome check .` | `biome.jsonc` の `suspicious` / `nursery` |
| `console` を使わない | `npx biome check .` | `biome.jsonc` |
| 認知複雑度は 12 以下。ネストした関数内の条件には階層ペナルティが加算される | `npx biome check .` | `biome.jsonc` の `noExcessiveCognitiveComplexity` |
| 相対 import は `.ts` 拡張子付き、パスエイリアスなし | `npx tsc --noEmit` + Node 実行 | `tsconfig.json` |

### 数値制約

| 数値 | 既定 | 根拠 |
|---|---|---|
| `assistantLookback` | 1 | 1ターン前の「次の一手」で足りる。増やすと古い情報が混じる |
| 1メッセージの本文 | 2,000 | 会話末尾の要点を残しつつ、長文貼り付けでリクエストが膨らまない(切り詰めの `…` を含む) |
| 合計文字数 | 6,000 | 上と同じ。表示の価値に対して十分小さい |
| ラベル文字数 | 40 | タブ名とステータス行に収まる |

数値は原則(コンテキスト消費の最小化)に戻るための警報線です。変更したら、計測値はテストコメントに、理由はコミットメッセージに残します。

## 変更時の手順

- イベントやコマンドを増減する場合は `test/contract/surface.test.ts` の `EXPECTED_EVENTS` / `EXPECTED_COMMANDS` と期待値を先に更新する。
  1つ落とすと機能が静かに消えるため、契約が変更の入口になる。
- スキャン・予算・ラベルの意味を変える場合は `test/unit/context.test.ts` を先に更新し、
  セマンティクスを固定してから実装する。
- 依存を追加する場合は devDependency のみ可能。`ALLOWED_DEV_DEPENDENCIES` の更新とコミットメッセージの理由をセットで行う。
  実行時依存(`dependencies`)の追加は不可。
- 決定の記録は `docs/adr/` に置く(1決定 = 1ファイル、`NNNN-<topic>.md`)。追加するのは、
  却下した代替を再提案されうる決定、機能や振る舞いを削除・置き換える決定、DESIGN.md / PHILOSOPHY.md に触れる決定のときだけ。
  却下案は結果ではなく理由を書く。
- ツール・コマンド・設定・公開の振る舞いを変える前に `docs/adr/` を読み、却下済みの代替を再提案しない。
  決定が変わったら同じコミットで状態を更新する(採用 → 廃止)。
- カバレッジの数値は契約テストの影響を受けます。契約テストは jiti 経由で `src` をもう一度ロードするため、
  同じファイルが2実体として数えられます。
- ドキュメントの段落内の改行は、文末(。！？)・読点(、)・コロン(:)の直後に置く。

## 手動確認項目(自動検証の対象外)

前提: TUI と実モデルのセッションで確認します。

1. 端末のタブ名(タイトル)がタスクラベルに変わること。端末や tmux がタイトル変更を表示する設定であること。
2. 複数セッションを並行で走らせ、タブ一覧から各セッションの作業が読み分けられること。
3. `model` を安価なモデルにしたときの1ターンあたりのトークン量と金額。
4. ラベルが実際の作業と食い違わないこと(食い違う場合は `prompt` の調整で直す)。
