# AGENTS.md — pi-task-label

読者: pi-task-label を変更するエージェントと開発者。利用者向けの仕様は README、設計判断は DESIGN.md。
共通の検証と規則はルートの `AGENTS.md` にある。

## 壊してはいけない制約

- モデル向けのツールを登録しない（表示専用）。コマンドは `task-label` の1つで、解決済み設定とラベルの表示に限る。イベントは `input` / `session_start` / `session_tree` の3種で各1ハンドラ（`test/contract/surface.test.ts`）。
- 生成のトリガは `input` のとき1回だけ。`enabled: false` と UI なしモード（JSON / print）ではモデルを呼ばない（`test/integration/extension.test.ts`）。
- 新しい入力は古い生成結果を破棄する。生成できない入力でも同様（`test/integration/extension.test.ts`）。
- 入力は直近の assistant（text あり）から `assistantLookback` 件、それ以降の user すべて、今回の入力。toolResult・custom_message・メタデータは読み飛ばし、assistant の件数に数えない（`test/unit/context.test.ts`）。
- 予算は本文1メッセージ 2,000 文字、全体 6,000 文字（切り詰めの `…` を含む）。新しいメッセージを優先する（`test/unit/context.test.ts`）。
- モデルへ送るのは1ユーザーメッセージ（指示文 + `<context>`）で、システムプロンプトは送らない。reasoning は対応モデルで `minimal`、リクエストは `cacheRetention: "none"` と使い捨て session id（`test/unit/context.test.ts`）。
- ラベルは1行・40文字以内。最初の空でない行だけを使い、連続空白を1個にまとめ、外側の引用符を除去する。空のラベルは表示を変えない（`test/unit/context.test.ts`）。
- ラベルはセッションに書き戻さず、コンテキストにも入れない。
- タイトルは `π - <ラベル> - <プロジェクト名>`、ラベルなしは `π - <プロジェクト名>`。`display` の3値（`both` / `title` / `status`）で出し分ける。`session_tree` と `enabled: false` では、管理している表示先だけラベルを消す（`test/integration/extension.test.ts`）。
- 生成の警告（モデル解決・リクエスト失敗）はセッションで1回だけ通知する。設定の警告は拡張インスタンスで1回だけ（`test/integration/extension.test.ts`）。
- 設定はグローバル → プロジェクトの順にマージし、project が優先する。未信頼プロジェクトの設定は無視する。設定を読むのは `session_start` のときだけ（`test/unit/config.test.ts`）。
- 実行時依存を持たない（`dependencies` は空）。配布は `files` の範囲内（`test/contract/dependencies.test.ts`、`test/ci/package-contents.test.ts`）。

## 変更手順

- イベントやコマンドを増減するときは、`test/contract/surface.test.ts` の `EXPECTED_EVENTS` / `EXPECTED_COMMANDS` を先に更新する。1つ落とすと機能が静かに消える。
- スキャン・予算・ラベルの意味を変えるときは、`test/unit/context.test.ts` を先に更新してセマンティクスを固定する。
- 数値（`assistantLookback`・文字数上限）は原則（コンテキスト消費の最小化）に戻るための警報線である。変更したら、計測値をテストのコメントに、理由をコミットメッセージに残す。
- ツール・コマンド・設定・公開の振る舞いを変える前に、`docs/adr/` を読む（0001〜0004）。
- 手動で確認する項目は [docs/manual-checks.md](docs/manual-checks.md) に書く。
