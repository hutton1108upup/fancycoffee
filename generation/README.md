# APIMart Seedance 2.0 adapter

This adapter prepares a local dry-run payload for APIMart's current `seedance-2.0` model:

- one required lead photo URL and one optional regular photo URL;
- fixed 15-second, `9:16` output;
- `standard` and `closer` map to prompt instructions because APIMart exposes no style field;
- `480p` and `720p` are accepted;
- a controlled Test submit and task-poll path was verified on 2026-11-06 for one authorized run; this does not open production or public generation.

The client is fail-closed. `prepare()` returns a local payload and an informational USD estimate. By default, `submit()` rejects before network access. A real submit path exists only when the caller supplies an API key, confirms the account, verifies configuration, explicitly authorizes this run, and supplies an unexpired live CNY quote at or below 8 CNY. This package does not obtain credentials or make a real call during local testing.

Submission is one-shot: a successful task enters `submitted`; timeout or 5xx enters `unknown` and blocks retries, preventing duplicate paid jobs. The caller may query the original task ID. Request timeouts are bounded and provider metadata/quotes are never sent in the provider JSON body.

The Worker path persists the normalized request, quote, provider task ID, and state in D1. The verified run used the durable generation ledger; production still requires separate key, budget, approval, and rollout checks.

The Worker-side durable contract is implemented separately in
`deploy/generation-store.mjs` with `migrations/0003_generation.sql`. It keeps
`generation_runs` in the current test or production billing database, reserves
credits atomically, and exposes `claimGenerationSubmission()` so only one
`reserved -> submitting` caller may contact a provider. `unknown` never returns
to `submitting`; a known provider task ID cannot be replaced, and completed or
failed terminal states cannot be moved backward. Use
`getLatestGenerationRun(env, userId, requestId?)` for owner- and environment-
scoped status reads. This is an accounting and state contract; it does not
prove that a paid provider request or production generation has been completed.

No upload or real-person review implementation is included. Inputs may be public `http(s)` URLs or already approved `asset://` references; local file paths are rejected. The prompt states that the first photo is the required first-timer and the optional second photo is person 2, but this local adapter does not verify identity, consent, approval, or image contents.

The controlled 2026-11-06 run used the standard `seedance-2.0` 480p 15-second image-to-video path, charged 20 website credits, and returned provider task `task_01M6QB0W51XYPRQARYMX3PPA49`. The provider cost was `$0.99` / 9.9 provider credits; the observed 6.6684 FX rate was about `¥6.60`. The Test key had a 10-credit total limit and one-day expiry. This was one controlled Test run, not public unlimited availability. The earlier informational price snapshot remains a planning estimate; tier discounts, final output/reference billing, account balance and FX can change actual charges.

The run produced one D1 record `b5ab6a20-4908-4cac-9db9-f4a5da0830ef`: paid 20 → reserved 20 → reserved 0, delivered 20, available 0. After refresh, the owner page recovered the video; the downloaded MP4 was 2,819,373 bytes with SHA-256 `71b5a7d1c537bcccd4cd7a43d564b188ed80a145f62a2dbb2d25d76c9c8b0cfc`, decoded as 361 frames / 15.104 seconds / 496×864 / 24fps H.264/AAC with audio. Evidence is local under `.data/evidence/seedance-fancy-cafe.mp4`, `.data/evidence/seedance-site-playback.jpg`, and `.data/evidence/seedance-output-check.json`.

Official references checked 2026-11-05:

- https://docs.apimart.ai/en/api-reference/videos/doubao-seedance-2-0/generation
- https://apimart.ai/model/doubao-seedance-2-0
