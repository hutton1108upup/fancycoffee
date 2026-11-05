# APIMart Seedance 2.0 adapter

This adapter prepares a local dry-run payload for APIMart's documented `doubao-seedance-2.0` model:

- one required lead photo URL and one optional regular photo URL;
- fixed 15-second, `9:16` output;
- `standard` and `closer` map to prompt instructions because APIMart exposes no style field;
- `480p` and `720p` are accepted;
- the real submit and task-poll paths are deliberately disabled; this package cannot create paid requests.

The client is fail-closed. `prepare()` returns a local payload and an informational USD estimate. By default, `submit()` rejects before network access. A real submit path exists only when the caller supplies an API key, confirms the account, verifies configuration, explicitly authorizes this run, and supplies an unexpired live CNY quote at or below 8 CNY. This package does not obtain credentials or make a real call during local testing.

Submission is one-shot: a successful task enters `submitted`; timeout or 5xx enters `unknown` and blocks retries, preventing duplicate paid jobs. The caller may query the original task ID. Request timeouts are bounded and provider metadata/quotes are never sent in the provider JSON body.

The submission state is held in process memory only. A restart cannot recover `submitting`, `submitted`, or `unknown`; a production integration must persist the normalized request hash, quote, provider task ID, and state in a server-side durable store before enabling paid work.

No upload or real-person review implementation is included. Inputs may be public `http(s)` URLs or already approved `asset://` references; local file paths are rejected. The prompt states that the first photo is the required first-timer and the optional second photo is person 2, but this local adapter does not verify identity, consent, approval, or image contents.

The informational price snapshot is `$0.066/second` at 480p and `$0.142/second` at 720p, so 15-second estimates are `$0.99` and `$2.13`. These are USD estimates from the APIMart model page; tier discounts, final output/reference billing, account balance and FX can change the actual CNY charge. The package makes no claim that either estimate is at or below `8 CNY`.

Official references checked 2026-11-05:

- https://docs.apimart.ai/en/api-reference/videos/doubao-seedance-2-0/generation
- https://apimart.ai/model/doubao-seedance-2-0
