CREATE TABLE IF NOT EXISTS generation_runs (
  run_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'prod')),
  credits_required INTEGER NOT NULL CHECK (credits_required > 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'submitting', 'submitted', 'unknown', 'failed', 'completed')),
  provider_task_id TEXT,
  result_url TEXT,
  result_meta_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(environment, user_id, request_id)
);

CREATE INDEX IF NOT EXISTS generation_runs_user_idx ON generation_runs(environment, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS generation_submission_guard (
  run_id TEXT PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'prod')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS generation_guard_environment_idx ON generation_submission_guard(environment);
