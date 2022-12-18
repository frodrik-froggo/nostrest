CREATE TABLE IF NOT EXISTS latest_event_times (
  relay_url TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id CHARACTER(64) PRIMARY KEY,
  event_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  processed_at INTEGER default 0,
  tries SMALLINT default 0,
  status SMALLINT default 1
);

CREATE INDEX events_processes_at_index ON events (processed_at);
CREATE INDEX events_created_at_index ON events (created_at);
CREATE INDEX events_status_index ON events (status);
