# Unit 23 - Phase 2 polling / retry hardening
- 参照: docs/design/detailed/17-ui-rollout.md §1.2, §2, docs/design/detailed/15-ui-application-shell.md §8.3, §10
- 目的: reconnect / stale / history failure 時の UX を強化し、将来の ETag / 304 対応に備える。
- 実装対象: snapshot error / incompatible 表示の磨き込み、history failure 再試行 UX（初回 fetch error は一覧全体を `履歴の取得に失敗しました` + 再試行で置き換え、append error は既存 items を隠さず末尾に inline の `続きの取得に失敗しました` + `再試行` を表示）、polling retry/backoff 中の表示整合、history 未ingest / relay 有無に依存しない degraded messaging、304 導入の feature gate 追加。
- 完了条件: 取得失敗時も直前描画を維持したまま再試行でき、append 失敗は既存 items を隠さず末尾の inline error だけで示し、`/api/history` が未ingestで empty・relay 無効でも current-state UI の文言が矛盾せず、304 は追加詳細設計完了まで無効のまま管理できる。
- 依存: Unit 13, Unit 17, Unit 21, Unit 29, Unit 30。optional relay の再接続表示は Unit 32 の比較対象とする。
- 検証: error recovery test、retry interaction test、初回 fetch error と append error を UI 上で別扱いする test（既存 items 継続表示の確認）、relay disabled degraded-state review、304 feature gate test。
- 非対象: 304 本実装の有効化。現行詳細設計では body 再利用 / last_success_at 更新 / stale 再評価の完全仕様が未確定なため、実装着手前に追加設計が必要。
