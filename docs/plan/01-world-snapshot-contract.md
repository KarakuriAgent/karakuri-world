# Unit 01 - WorldSnapshot 公開契約
- 参照: docs/design/detailed/12-spectator-snapshot.md §2.1, §3.1, §4.1, §6
- 目的: UI 中継が正本として扱う WorldSnapshot / SpectatorSnapshot の基礎型を確定し、calendar・map_render_theme・schema_version・published_at の契約と producer 側の算出責務を実装可能な形へ落とす。
- 作業リポジトリ: **本体リポジトリ (`karakuri-world`)** 側で `WorldCalendarSnapshot` / `MapRenderTheme` 追加と `getSnapshot()` 出力拡張、**UI 中継リポジトリ (`karakuri-world-ui`)** 側で `SpectatorSnapshot` / `SpectatorMapSnapshot` / `SpectatorRecentServerEvent` の型定義を持つ。両リポジトリ分の変更が揃って初めて本 Unit 完了とみなす。
- 実装対象: 本体側 `src/types/snapshot.ts` への `WorldCalendarSnapshot` / `MapRenderTheme` 追加と `WorldSnapshot` 拡張、本体側 `src/engine/world-engine.ts#getSnapshot()` が `calendar` / `map_render_theme` を欠落なく返すこと、UI 中継側の `SpectatorWorldSnapshot` / `SpectatorMapSnapshot` / `SpectatorRecentServerEvent` / `SpectatorSnapshot` 型定義、`GET /api/snapshot` / `/ws` 初回 `snapshot` に載せる `calendar` / `map_render_theme` の producer 側算出、serializer 入出力境界。
- 完了条件: schema_version = 1 前提の入出力が固定され、timezone 複製・generated_at / published_at の意味がコード上で一意になり、本体 `getSnapshot()` が `calendar` と `map_render_theme` を欠落なく供給し、本体変更がマージ・デプロイ済みであること。
- 依存: なし。
- 検証: 型テスト、season / display_label 算出テスト、本体 `getSnapshot()` の `calendar` / `map_render_theme` 算出テスト、schema_version 不一致を弾くデコードテスト。
- 非対象: エージェント派生値、サニタイズ allowlist、D1 永続化。
