const sqlite3 = require("better-sqlite3");
module.exports = class DB {

  constructor( dbFile ) {
    this.db = sqlite3(dbFile, {fileMustExist: true});
    this.db.pragma('journal_mode = WAL');

    this.preparedStatements = {
      // debug
      markAllEventsAsUnprocessed: this.db.prepare('UPDATE events SET processed_at=0, tries=0, status=1'),
      // transactions
      begin: this.db.prepare('BEGIN'),
      commit: this.db.prepare('COMMIT'),
      rollback: this.db.prepare('ROLLBACK'),
      // production
      upsertLatestEventAt: this.db.prepare('INSERT INTO latest_event_times(relay_url,created_at) VALUES($relay_url,$created_at) ON CONFLICT(relay_url) DO UPDATE SET created_at=CAST(max(CAST(created_at AS INTEGER),CAST(excluded.created_at AS INTEGER)) AS TEXT)'),
      getLatestEventAt: this.db.prepare('SELECT created_at FROM latest_event_times WHERE relay_url=? LIMIT 1' ),
      insertEventIntoDB: this.db.prepare('INSERT OR IGNORE INTO events (id, event_json, created_at) VALUES ($id, $event_json, $created_at)'),
      getNextUnprocessedEvent: this.db.prepare('SELECT event_json, created_at FROM events WHERE status>0 AND status<=10 AND tries<? AND processed_at<? ORDER BY created_at LIMIT 1'),
      updateEvent: this.db.prepare('UPDATE events SET status=$status, processed_at=$processed_at, tries = tries + 1 WHERE id=$id')
    };
  }

  getLatestEventAt( relayUrl ) {
    return this.preparedStatements.getLatestEventAt.get(relayUrl) || 0;
  }

  increaseEventTries( eventId ) {
    const r = this.preparedStatements.increaseEventTries.run( eventId );
    return r.changes;
  }

  storeEvent(event, relayUrl) {
    // insert event into database, so we can process them later. Events received multiple times will only
    // be stored once
    let eventWasStored = false;
    this.preparedStatements.begin.run();
    try {
      const r = this.preparedStatements.insertEventIntoDB.run( { id: event.id, event_json: JSON.stringify(event), created_at: event.created_at} );
      eventWasStored = r.changes>0;
      this.preparedStatements.upsertLatestEventAt.run({
        relay_url: relayUrl,
        created_at: event.created_at
      });
      this.preparedStatements.commit.run();
    } finally {
      if (this.db.inTransaction) {
        this.preparedStatements.rollback.run();
      }
    }
    return eventWasStored;
  }

  getNextUnprocessedEvent( maxTries, processedAtBefore ) {
    // throws
    const eventWrapper = this.preparedStatements.getNextUnprocessedEvent.get( maxTries, processedAtBefore );
    if( !eventWrapper ) {
      return;
    }
    return JSON.parse( eventWrapper.event_json );
  }

  updateEvent( id, status, processed_at ) {
    const r = this.preparedStatements.updateEvent.run({id,status,processed_at});
    return r.changes;
  }

  dbg_markAllEventsAsUnprocessed() {
    this.preparedStatements.markAllEventsAsUnprocessed.run();
  }

}