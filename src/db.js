const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
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
`);

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
    allowedRoles: parseJson(row.allowed_roles)
  };
}

function updateGuild(guildId, patch) {
  const current = ensureGuild(guildId, patch.guildName || '');
  db.prepare(`UPDATE guild_settings SET
      guild_name = ?, allowed_voice_channels = ?, allowed_text_channels = ?,
      allowed_roles = ?, default_volume = ?, updated_at = CURRENT_TIMESTAMP
    WHERE guild_id = ?`).run(
      patch.guildName ?? current.guild_name,
      JSON.stringify(patch.allowedVoiceChannels ?? current.allowedVoiceChannels),
      JSON.stringify(patch.allowedTextChannels ?? current.allowedTextChannels),
      JSON.stringify(patch.allowedRoles ?? current.allowedRoles),
      Math.min(1, Math.max(0, Number(patch.defaultVolume ?? current.default_volume))),
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
