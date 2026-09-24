CREATE TABLE IF NOT EXISTS feature_flag_audit_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT,
  operation TEXT NOT NULL,
  flag_key TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  pg_config_version INTEGER,
  slock_echo_status TEXT NOT NULL DEFAULT 'not_attempted',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feature_flag_audit_events_flag_created
  ON feature_flag_audit_events(flag_key, created_at);
