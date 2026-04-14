# Unit 03 - Snapshot / Event サニタイズ境界
- 参照: docs/design/detailed/12-spectator-snapshot.md §3.2, §5.1, §5.3, §5.4
- 目的: ブラウザ公開境界を allowlist ベースで固定し、内部情報を UI へ漏らさない変換層を切り出す。
- 実装対象: WorldSnapshot から SpectatorSnapshot への変換、WorldEvent から PersistedSpectatorEvent へのサニタイズ、未知イベント drop、未知フィールド warn + metric フック、各イベント種別ごとの `PersistedSpectator{EventType}Event` 型を本体 `WorldEvent` サブタイプからの `Pick` ベースで定義し、`PersistedSpectatorEvent` をそれら union として固定（sanitizer 関数シグネチャは `sanitize(event: WorldEvent): PersistedSpectatorEvent | null` とする）。
- 完了条件: discord_channel_id、所持金、所持品、アクション経済条件などが公開 JSON と payload_json に残らない。さらに `PersistedSpectatorEvent` union が本体 `WorldEvent` に新フィールドが追加されても自動伝搬しないことを型レベルで保証する（本体側の allowlist 外の追加フィールドはコンパイル上そもそも union に入らず、本体側のフィールド名変更は `Pick` でコンパイルエラーになる）。
- 依存: Unit 01, Unit 02。
- 検証: 公開 JSON のスナップショットテスト、未知 event.type drop テスト、未知フィールド除外テスト、`PersistedSpectatorEvent` が 12§5.3 の allowlist と一致することを検証する型テスト（`expectType` 系）。
- 非対象: DO 起動、D1 書き込み、UI コンポーネント。
