# Unit 32 - Optional relay `/ws` accelerator の再配置
- 参照: docs/design/detailed/13-ui-relay-backend.md §6, §9.1, docs/design/detailed/17-ui-rollout.md §4, docs/plan/27-relay-ws-reconnect-lifecycle.md, docs/plan/28-relay-alert-wiring-readiness.md
- 目的: 既存の relay `/ws` 仕事を primary path から外し、history 補助・publish nudge・追加 observability を担う optional accelerator として位置づけ直す。primary `ui.*` metrics は Unit 29 側に残し、本 Unit は relay 専用 hardening の境界を明文化する。
- 実装対象: Unit 27/28 の成果物を「有効なら便利だが無くても launch できる」前提で読み替えること、relay on/off の責務差分整理、relay 切断時の影響が history gap と Unit 09 の補助指標に閉じること、future additive option としての再接続 / alerting / event ingest の扱い。
- 完了条件: relay `/ws` を無効化しても Unit 29〜31 の readiness・freshness・UI acceptance が崩れず、relay を有効化した場合だけ Unit 27/28 の追加 hardening を上積みする構図が明文化される。
- 依存: Unit 27, Unit 28, Unit 29, Unit 30, Unit 31。
- 検証: relay disabled smoke checklist、relay enabled comparison review、impact matrix review、design/doc review。
- 非対象: relay を mandatory path へ戻すこと、UI 直接 WebSocket fan-out。
