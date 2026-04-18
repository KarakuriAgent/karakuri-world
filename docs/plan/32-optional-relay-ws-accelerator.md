# Unit 32 - relay `/ws` の完全削除
- 参照: docs/design/detailed/13-ui-relay-backend.md §6, §9.1, docs/design/detailed/17-ui-rollout.md §4, docs/plan/27-relay-ws-reconnect-lifecycle.md, docs/plan/28-relay-alert-wiring-readiness.md
- 目的: UI / relay backend から relay `/ws` を optional path としても残さず完全に除去し、current-state 配信・readiness・observability の責務を polling + R2/CDN 系へ一本化する。
- 実装対象: relay `/ws` 接続、再接続 lifecycle、publish nudge、relay alerting、relay ingest 前提の補助フローを削除し、Unit 27/28 の成果物は廃止または削除タスクとして読み替えること、relay on/off の分岐や feature flag をなくして polling only の設計・運用・ドキュメントへ整理すること、history gap や補助 observability も relay 非依存の説明へ統一すること。
- 完了条件: UI / backend / docs / readiness checklist のいずれにも relay `/ws` を有効化して使う経路が残らず、Unit 29〜31 の acceptance と launch 判断が polling + R2/CDN だけで閉じる。relay 関連の設定値・監視条件・運用手順は削除され、残る言及は「削除した」履歴または移行メモに限られる。
- 依存: Unit 27, Unit 28, Unit 29, Unit 30, Unit 31。
- 検証: relay reference removal review、polling-only smoke checklist、docs/readiness consistency review、obsolete config cleanup review。
- 非対象: relay `/ws` の代替となる新しい realtime transport、UI 直接 WebSocket fan-out。
