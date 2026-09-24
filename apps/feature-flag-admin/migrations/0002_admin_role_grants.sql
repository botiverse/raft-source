CREATE TABLE IF NOT EXISTS feature_flag_admin_role_grants (
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'announcement_publisher')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  granted_by_principal_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, role)
);

CREATE INDEX IF NOT EXISTS idx_feature_flag_admin_role_grants_enabled
  ON feature_flag_admin_role_grants(enabled, principal_id, role);

CREATE TABLE IF NOT EXISTS feature_flag_admin_role_audit_events (
  id TEXT PRIMARY KEY,
  actor_principal_id TEXT NOT NULL,
  target_principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'announcement_publisher')),
  action TEXT NOT NULL CHECK (action IN ('grant', 'revoke')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feature_flag_admin_role_audit_target_created
  ON feature_flag_admin_role_audit_events(target_principal_id, created_at);

-- Role grants are ordinary Worker-owned authorization data. This migration
-- intentionally bootstraps no individual principal. Existing source-reviewed
-- operators provide the bounded bootstrap authority for the first data grant.
