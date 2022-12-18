CREATE TABLE IF NOT EXISTS latest_event_times (
  relay_url TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
