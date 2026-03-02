-- Phase 5: Ensemble calibration + monitoring tables

CREATE TABLE IF NOT EXISTS model_ensemble_state (
  id TEXT PRIMARY KEY DEFAULT 'default',
  state_json TEXT NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS monitoring_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_monitoring_snapshots_created
  ON monitoring_snapshots(created_at DESC);
