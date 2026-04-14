# Unit 21 - Phase 1 結合検証と受け入れ
- 参照: docs/design/detailed/17-ui-rollout.md §1.1, §2, §3
- 目的: 観戦 MVP の完了条件を end-to-end で検証し、Phase 2/3 着手前の gate を明文化する。
- 実装対象: 100エージェント規模反映時間計測、desktop / mobile 初期レイアウト検証、agent detail + 履歴20件 + 会話展開検証、quiet period stale 検証、R2 カスタムドメインの 5 秒 edge cache 挙動確認（最小構成）、`/ws` 切断中の heartbeat 継続と再接続後 state rebuild の受け入れ確認。
- Phase 境界の整理: R2 カスタムドメインの Cache Rules 本配備手順と認証モード対応は Unit 22 (Phase 2) の責務。Phase 1 は `AUTH_MODE=public` 前提での最小構成（`Cache Everything` + Edge TTL 5 秒を staging ないし同等環境で適用できる形）での cache hit / TTL 観測までをゲートとし、Phase 2 で本番配備手順と Access 対応を仕上げる。
- 完了条件: 15秒以内反映、レイアウト成立、history 展開成立、heartbeat refresh による stale 非常時以外の抑止が確認でき、Phase 1 用最小構成の R2 カスタムドメイン経由 snapshot 配信で freshness budget が崩れず、`/ws` 切断後も自動再接続と freshness 維持が成立する。Unit 27 が Phase 1 必須依存であることを受入時に確認する。
- 依存: Unit 06〜20, Unit 27 (**Phase 1 必須依存**。番号は識別子であり Phase 3 ではない)。
- 検証: e2e test、負荷計測、`/ws` 切断復旧シナリオ、Phase 1 用最小構成 R2 カスタムドメインの cache hit / 5 秒 TTL 観測を含む手動確認チェックリスト。本番配備用 Cache Rules と Access 対応の再現性検証は Unit 22 に委譲する。
- 非対象: 304、Access 配備手順の最終確定、本番配備用 Cache Rules 再現性検証（Unit 22 で扱う）、演出追加。
