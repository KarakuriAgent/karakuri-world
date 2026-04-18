# Unit 21 - Phase 1 結合検証と受け入れ
- 参照: docs/design/detailed/17-ui-rollout.md §1.1, §2, §3
- 目的: 観戦 MVP の完了条件を end-to-end で検証し、Phase 2/3 着手前の gate を明文化する。
- 実装対象: 100エージェント規模反映時間計測、desktop / mobile 初期レイアウト検証、agent detail + 履歴 UI の empty/degraded state 検証、ingest/backfill が入った環境では履歴20件 + 会話展開の追加比較、quiet period stale 検証、R2 カスタムドメインの 5 秒 edge cache 挙動確認（最小構成）、relay 無効でも fixed-cadence publish が継続することの受け入れ確認。
- Phase 境界の整理: R2 カスタムドメインの Cache Rules 本配備手順と認証モード対応は Unit 22 (Phase 2) の責務。Phase 1 は `AUTH_MODE=public` 前提での最小構成（`Cache Everything` + Edge TTL 5 秒を staging ないし同等環境で適用できる形）での cache hit / TTL 観測までをゲートとし、Phase 2 で本番配備手順と Access 対応を仕上げる。`/api/history` の populated ingest/backfill は Phase 1 の必須 gate に含めず、empty/degraded でも current-state UI が矛盾しないことを優先する。optional relay の再接続 hardening は Unit 27/32 に委譲し、Phase 1 の必須 gate には含めない。
- 完了条件: 15秒以内反映、レイアウト成立、`/api/history` が empty でも detail overlay の empty/degraded state が矛盾なく成立し、fixed-cadence publish による stale 非常時以外の抑止が確認でき、Phase 1 用最小構成の R2 カスタムドメイン経由 snapshot 配信で freshness budget が崩れない。履歴20件/会話展開は ingest/backfill が入った環境での追加確認項目とし、relay `/ws` がある配備でも、それは追加比較項目であり必須受入条件ではない。
- 依存: Unit 10〜20, Unit 29。Unit 06〜09 と Unit 27 は optional relay / additive ingest 比較を行う配備でのみ追加依存とし、Phase 1 必須 gate の前提には含めない。
- 検証: e2e test、負荷計測、Phase 1 用最小構成 R2 カスタムドメインの cache hit / 5 秒 TTL 観測、relay disabled smoke を含む手動確認チェックリスト、history empty/degraded 確認。ingest/backfill あり環境での履歴20件 / 会話展開は追加比較として記録する。本番配備用 Cache Rules と Access 対応の再現性検証は Unit 22 に委譲し、relay 切断復旧シナリオは Unit 27/32 の比較検証へ移す。
- 非対象: 304、Access 配備手順の最終確定、本番配備用 Cache Rules 再現性検証（Unit 22 で扱う）、optional relay の必須化、演出追加。
