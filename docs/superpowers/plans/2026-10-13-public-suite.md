# Public Codex WorkBuddy Suite implementation plan

> Execute in the isolated release workspace. Use requesting-code-review before publication.

Goal: publish a Windows/macOS one-command installer for both local plugins, gateway, quota panel and current-account onboarding; WorkBuddy-only operation must require no ChatGPT account.

Architecture: local provider uses a generated per-user bearer credential. WorkBuddy credentials remain in the official desktop client's current auth files. Official requests separately load an existing ChatGPT login and never forward the local key to OpenAI. User services start the common Node runtime; install scripts bootstrap a private Node toolchain and call one platform-independent installer.

Constraints: Linux explicitly unsupported; Node >=24; Codex CLI >=0.162; no copied personal state in source or archives; no changes to the existing private installation; official names unchanged; model capabilities come only from each account's catalog.

- [ ] Task 1: standalone gateway. Files src/catalog.mjs, src/gateway.mjs, src/paths.mjs, src/main.mjs. Verify an isolated fresh Codex home without auth.json completes a synthetic WorkBuddy tool roundtrip using env_key=WORKBUDDY_GATEWAY_TOKEN and requires_openai_auth=false. Verify a local token is never sent to the official upstream, and official routes without ChatGPT login return official_login_required.
- [ ] Task 2: platform/account discovery. Files src/platform.mjs, src/workbuddy.mjs, src/lifecycle.mjs. Discover Windows/macOS Codex and WorkBuddy executables using current-user locations and bundle metadata; validate product identity. Reject Linux. Test paths with spaces, CN/international isolation, macOS app bundles, and service/launcher command quoting.
- [ ] Task 3: installation lifecycle. Files src/install-state.mjs, scripts/setup.mjs, scripts/manage.mjs, scripts/verify-standalone.mjs. Detect Codex and login status; allow either region; prompt login only in official clients; back up managed config and environment, write portable source paths and absolute MCP Node commands; install services and launchers. Verify duplicate installation, interrupted setup, refresh and restore conflicts with isolated home fixtures.
- [ ] Task 4: release distribution. Files scripts/release.mjs, install.ps1, install.sh, .github/workflows/ci.yml, README.md, LICENSE. Whitelist archive files; include third-party notices; generate fixed-version SHA-256-checked bootstraps. README opens with project introduction and real install commands. Validate archive contents and run core tests on Windows/macOS.
- [ ] Task 5: final verification/review/publication. Run complete tests, installed-kernel standalone gate, fresh-home installer/restore checks, and public package audit. Commit reviewed source, publish ztg-pty/codex-workbuddy-suite and v0.2.0 assets, then download and verify published bootstrap and archive and report actual CI status. No directory/Portal submission.
