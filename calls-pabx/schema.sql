-- Wozapi Calls / PABX schema proposal.
-- Keep this separate from the current production schema until the module is validated.

CREATE TABLE IF NOT EXISTS call_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  instance_id INTEGER,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'wacalls',
  provider_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  phone_connected TEXT,
  jid TEXT,
  max_concurrent_calls INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS call_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  user_id INTEGER,
  name TEXT NOT NULL,
  email TEXT,
  extension TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  can_make_calls INTEGER NOT NULL DEFAULT 1,
  can_receive_calls INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS call_queues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'round_robin',
  timeout_seconds INTEGER NOT NULL DEFAULT 30,
  enabled INTEGER NOT NULL DEFAULT 1,
  business_hours_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS call_queue_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  queue_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  priority INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(queue_id, agent_id)
);

CREATE TABLE IF NOT EXISTS call_routing_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  line_id INTEGER,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  match_json TEXT NOT NULL DEFAULT '{}',
  action TEXT NOT NULL DEFAULT 'queue',
  target_id INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS call_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  line_id INTEGER NOT NULL,
  agent_id INTEGER,
  queue_id INTEGER,
  provider_call_id TEXT,
  direction TEXT NOT NULL,
  from_number TEXT,
  to_number TEXT,
  remote_jid TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  started_at DATETIME,
  answered_at DATETIME,
  ended_at DATETIME,
  duration_seconds INTEGER DEFAULT 0,
  end_reason TEXT,
  recording_url TEXT,
  lead_id INTEGER,
  conversation_id INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS call_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  call_session_id INTEGER,
  line_id INTEGER,
  agent_id INTEGER,
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS call_recordings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  call_session_id INTEGER NOT NULL,
  storage_provider TEXT NOT NULL DEFAULT 'local',
  storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'audio/wav',
  size_bytes INTEGER DEFAULT 0,
  duration_seconds INTEGER DEFAULT 0,
  consent_recorded INTEGER NOT NULL DEFAULT 0,
  retention_expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_call_lines_account ON call_lines(account_id);
CREATE INDEX IF NOT EXISTS idx_call_agents_account ON call_agents(account_id);
CREATE INDEX IF NOT EXISTS idx_call_sessions_account ON call_sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_call_sessions_line ON call_sessions(line_id);
CREATE INDEX IF NOT EXISTS idx_call_sessions_status ON call_sessions(status);
CREATE INDEX IF NOT EXISTS idx_call_events_call ON call_events(call_session_id);
