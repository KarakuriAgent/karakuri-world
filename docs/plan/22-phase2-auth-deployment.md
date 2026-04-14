# Unit 22 - Phase 2 認証モード配備検証
- 参照: docs/design/detailed/17-ui-rollout.md §1.2, docs/design/detailed/13-ui-relay-backend.md §5.4, §5.4.1, §8, docs/design/detailed/14-ui-history-api.md §7, docs/design/detailed/15-ui-application-shell.md §11
- 目的: AUTH_MODE=public / AUTH_MODE=access の成立条件を配備レベルで検証し、未成立構成を不採用にする。
- 実装対象: browser 向け `snapshot_url`（R2 カスタムドメイン）への direct snapshot fetch 前提の env 注入、R2 カスタムドメイン Cache Rules（`Cache Everything` + Edge TTL 5 秒）の配備手順 / 検証、Access cookie 共有 / pre-seeding 確認、R2 CORS、Worker 側 `/api/history` を含む public / access の切替テスト。
- 完了条件: 採用する認証モードで Pages / Worker / R2 の配備手順が再現可能になり、R2 カスタムドメインに required Cache Rules を再現性をもって適用でき、browser からの `snapshot_url` と Worker API `/api/history` の双方が想定どおり認証・到達でき、proxy fallback が不要であることを確認できる。
- 依存: Unit 08, Unit 11, Unit 12, Unit 13。
- 検証: 配備 smoke test、R2 カスタムドメイン Cache Rules（`Cache Everything` + Edge TTL 5 秒）適用確認、browser からの `snapshot_url`（R2 カスタムドメイン）/ Worker `/api/history` の cross-origin fetch test、Access セッション成立確認、`snapshot_url` の到達 + cache hit 確認、`/api/history` の auth failure / success 切替確認。
- 非対象: アプリ内ログイン UI、別認証方式追加。
