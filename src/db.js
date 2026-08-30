const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    guild_name TEXT NOT NULL DEFAULT '',
    allowed_voice_channels TEXT NOT NULL DEFAULT '[]',
    allowed_text_channels TEXT NOT NULL DEFAULT '[]',
    allowed_roles TEXT NOT NULL DEFAULT '[]',
    default_volume REAL NOT NULL DEFAULT 0.8,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS users (
    discord_id TEXT PRIMARY KEY,
    username TEXT NOT NULL DEFAULT '',
    avatar TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS library_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256 TEXT NOT NULL UNIQUE,
    storage_name TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    duration_seconds REAL NOT NULL,
    size_bytes INTEGER NOT NULL,
    uploaded_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS guild_library (
    guild_id TEXT NOT NULL,
    file_id INTEGER NOT NULL REFERENCES library_files(id) ON DELETE CASCADE,
    added_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (guild_id, file_id)
  );
  CREATE INDEX IF NOT EXISTS idx_guild_library_guild ON guild_library(guild_id);
`);

// CREATE TABLE IF NOT EXISTS leaves existing installations untouched, so new
// columns are added separately and only when they are missing.
function addColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('guild_settings', 'instrumental', 'INTEGER NOT NULL DEFAULT 0');

function parseJson(value, fallback = []) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function ensureGuild(guildId, guildName = '') {
  db.prepare(`INSERT INTO guild_settings (guild_id, guild_name) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET guild_name=excluded.guild_name`).run(guildId, guildName);
  return getGuild(guildId);
}

function getGuild(guildId) {
  const row = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId);
  if (!row) return null;
  return {
    ...row,
    allowedVoiceChannels: parseJson(row.allowed_voice_channels),
    allowedTextChannels: parseJson(row.allowed_text_channels),
    allowedRoles: parseJson(row.allowed_roles),
    instrumental: row.instrumental === 1
  };
}

function updateGuild(guildId, patch) {
  const current = ensureGuild(guildId, patch.guildName || '');
  db.prepare(`UPDATE guild_settings SET
      guild_name = ?, allowed_voice_channels = ?, allowed_text_channels = ?,
      allowed_roles = ?, default_volume = ?, instrumental = ?, updated_at = CURRENT_TIMESTAMP
    WHERE guild_id = ?`).run(
      patch.guildName ?? current.guild_name,
      JSON.stringify(patch.allowedVoiceChannels ?? current.allowedVoiceChannels),
      JSON.stringify(patch.allowedTextChannels ?? current.allowedTextChannels),
      JSON.stringify(patch.allowedRoles ?? current.allowedRoles),
      Math.min(1, Math.max(0, Number(patch.defaultVolume ?? current.default_volume))),
      (patch.instrumental ?? current.instrumental) ? 1 : 0,
      guildId
    );
  return getGuild(guildId);
}

function saveUser(user) {
  db.prepare(`INSERT INTO users (discord_id, username, avatar) VALUES (?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET username=excluded.username, avatar=excluded.avatar, updated_at=CURRENT_TIMESTAMP`)
    .run(user.id, user.username || '', user.avatar || null);
}

module.exports = { db, ensureGuild, getGuild, updateGuild, saveUser };
