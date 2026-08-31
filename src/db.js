const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const config = require('./config');

// Opening a read-only database and reading from it both succeed, so a
// permissions problem surfaces only at the first write - as a bare
// SQLITE_READONLY several frames deep. Turn it into something an operator can
// act on, wherever it happens to surface.
function unwritableDatabase(error) {
  if (error.code !== 'SQLITE_READONLY' && error.code !== 'SQLITE_CANTOPEN') return error;
  const identity = typeof process.getuid === 'function' ? `uid ${process.getuid()}:${process.getgid()}` : 'the current user';
  return new Error([
    `The database at ${config.databasePath} is not writable by ${identity}.`,
    '',
    'In Docker this usually means the data volume is still owned by root from a release',
    'that ran the container as root. Fix the ownership once:',
    '',
    '  docker compose down',
    '  docker volume ls | grep karaoke',
    '  docker run --rm -v <project>_karaoke-data:/data node:22-bookworm-slim chown -R node:node /data',
    '  docker compose up -d',
    ''
  ].join('\n'));
}

function openDatabase() {
  try { return new Database(config.databasePath); }
  catch (error) { throw unwritableDatabase(error); }
}

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
const db = openDatabase();
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
  CREATE TABLE IF NOT EXISTS usage_guilds (
    guild_id TEXT PRIMARY KEY,
    total_requests INTEGER NOT NULL DEFAULT 0,
    api_requests INTEGER NOT NULL DEFAULT 0,
    discord_commands INTEGER NOT NULL DEFAULT 0,
    unique_users INTEGER NOT NULL DEFAULT 0,
    last_request_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS usage_users (
    guild_id TEXT NOT NULL,
    discord_id TEXT NOT NULL,
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (guild_id, discord_id)
  );
`);

// CREATE TABLE IF NOT EXISTS leaves existing installations untouched, so new
// columns are added separately and only when they are missing.
function addColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

try {
  addColumn('guild_settings', 'instrumental', 'INTEGER NOT NULL DEFAULT 0');
} catch (error) {
  throw unwritableDatabase(error);
}

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

function recordUsage({ guildId, userId, source }) {
  if (!/^\d{15,25}$/.test(String(guildId || ''))) return;
  if (!/^\d{15,25}$/.test(String(userId || ''))) return;
  const usageSource = source === 'discord' ? 'discord' : 'api';
  const now = new Date().toISOString();
  const write = db.transaction(() => {
    db.prepare(`INSERT INTO usage_guilds (guild_id, total_requests, api_requests, discord_commands, last_request_at)
      VALUES (?, 1, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        total_requests = total_requests + 1,
        api_requests = api_requests + excluded.api_requests,
        discord_commands = discord_commands + excluded.discord_commands,
        last_request_at = excluded.last_request_at,
        updated_at = CURRENT_TIMESTAMP`).run(guildId, usageSource === 'api' ? 1 : 0, usageSource === 'discord' ? 1 : 0, now);
    const newUser = db.prepare(`INSERT OR IGNORE INTO usage_users (guild_id, discord_id, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?)`).run(guildId, userId, now, now);
    if (newUser.changes) db.prepare('UPDATE usage_guilds SET unique_users = unique_users + 1 WHERE guild_id = ?').run(guildId);
    else db.prepare('UPDATE usage_users SET last_seen_at = ? WHERE guild_id = ? AND discord_id = ?').run(now, guildId, userId);
  });
  try { write(); } catch (error) { console.warn('[usage] unable to record usage:', error.message); }
}

function usageForGuilds(guildIds) {
  const ids = [...new Set((guildIds || []).filter((id) => /^\d{15,25}$/.test(String(id))))];
  if (!ids.length) return { byGuild: new Map(), totals: { totalRequests: 0, apiRequests: 0, discordCommands: 0, uniqueUsers: 0 } };
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT guild_id, total_requests, api_requests, discord_commands, unique_users, last_request_at
    FROM usage_guilds WHERE guild_id IN (${placeholders})`).all(...ids);
  const totals = db.prepare(`SELECT
    COALESCE(SUM(total_requests), 0) AS totalRequests,
    COALESCE(SUM(api_requests), 0) AS apiRequests,
    COALESCE(SUM(discord_commands), 0) AS discordCommands
    FROM usage_guilds WHERE guild_id IN (${placeholders})`).get(...ids);
  const uniqueUsers = db.prepare(`SELECT COUNT(DISTINCT discord_id) AS uniqueUsers
    FROM usage_users WHERE guild_id IN (${placeholders})`).get(...ids);
  return {
    byGuild: new Map(rows.map((row) => [row.guild_id, {
      totalRequests: row.total_requests,
      apiRequests: row.api_requests,
      discordCommands: row.discord_commands,
      uniqueUsers: row.unique_users,
      lastRequestAt: row.last_request_at
    }])),
    totals: {
      totalRequests: Number(totals.totalRequests),
      apiRequests: Number(totals.apiRequests),
      discordCommands: Number(totals.discordCommands),
      uniqueUsers: Number(uniqueUsers.uniqueUsers)
    }
  };
}

module.exports = { db, ensureGuild, getGuild, updateGuild, saveUser, recordUsage, usageForGuilds };
