const session = require('express-session');
const { db } = require('./db');

function expiresAt(value) {
  const expires = value?.cookie?.expires;
  if (expires) {
    const timestamp = new Date(expires).getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  }
  const maxAge = Number(value?.cookie?.maxAge);
  return Number.isFinite(maxAge) ? Date.now() + maxAge : null;
}

function restoreCookie(value) {
  if (value?.cookie?.expires && typeof value.cookie.expires !== 'object') value.cookie.expires = new Date(value.cookie.expires);
  return value;
}

class SQLiteStore extends session.Store {
  constructor() {
    super();
    this.removeExpired = db.prepare('DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at <= ?');
    this.read = db.prepare('SELECT sess, expires_at FROM sessions WHERE sid = ?');
    this.write = db.prepare(`INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at`);
    this.remove = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.count = db.prepare('SELECT COUNT(*) AS count FROM sessions');
  }

  get(sid, callback) {
    try {
      const row = this.read.get(sid);
      if (!row || (row.expires_at !== null && row.expires_at <= Date.now())) {
        if (row) this.remove.run(sid);
        return callback(null, null);
      }
      return callback(null, restoreCookie(JSON.parse(row.sess)));
    } catch (error) { return callback(error); }
  }

  set(sid, value, callback = () => {}) {
    try {
      this.removeExpired.run(Date.now());
      this.write.run(sid, JSON.stringify(value), expiresAt(value));
      callback(null);
    } catch (error) { callback(error); }
  }

  touch(sid, value, callback = () => {}) {
    try {
      db.prepare('UPDATE sessions SET expires_at = ?, sess = ? WHERE sid = ?').run(expiresAt(value), JSON.stringify(value), sid);
      callback(null);
    } catch (error) { callback(error); }
  }

  destroy(sid, callback = () => {}) {
    try { this.remove.run(sid); callback(null); } catch (error) { callback(error); }
  }

  clear(callback = () => {}) {
    try { db.prepare('DELETE FROM sessions').run(); callback(null); } catch (error) { callback(error); }
  }

  length(callback) {
    try { callback(null, this.count.get().count); } catch (error) { callback(error); }
  }
}

module.exports = { SQLiteStore };
