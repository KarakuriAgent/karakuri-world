# Unit 31 - Polling / R2 / CDN readiness gate
- 参照: docs/design/detailed/13-ui-relay-backend.md §5, §8, §9.1, docs/design/detailed/17-ui-rollout.md §1.2, karakuri-world-ui/README.md
- 目的: production readiness の主判定を relay `/ws` alert ではなく、**sub-minute-capable fixed-cadence snapshot publishing**・R2 custom domain・Cache Rules・auth mode・freshness 証跡へ移す。
- 実装対象: Unit 29 が emit する publisher cadence / `generated_age_ms` / `published_age_ms` / publish failure の primary 指標と、Unit 10 が emit する `ui.d1.retention_run_total{result}` / `ui.d1.retention_deleted_rows` の retention evidence を合わせて readiness gate として整理し、R2 custom-domain edge cache チェック、`AUTH_MODE=public|access` smoke checklist、Pages/Worker/R2 CORS と Access pre-seeding の成立条件、relay path を使わない配備でも完結する operator checklist を確立する。
- 完了条件: deployment を ready と判断するために必要な証跡が polling/R2/CDN 側だけで揃い、optional relay を無効化したままでも launch 判断ができる。relay alert gate は「使う配備だけ追加で満たす」条件へ後退する。
- 依存: Unit 10, Unit 22, Unit 29, Unit 30。
- 検証: staging readiness checklist review、R2 edge cache drill、auth-mode drill、publish age / failure observability review、retention evidence review。
- 非対象: relay alert ルーティングの細部、監視 SaaS の新規選定。
