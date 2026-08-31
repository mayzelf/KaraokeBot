const crypto = require('node:crypto');
const path = require('node:path');
require('dotenv').config();

const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'SESSION_SECRET'];
for (const key of required) {
  if (!process.env[key]) console.warn(`[config] ${key} is not set. The related feature will not work until it is configured.`);
}

// The session secret also signs OAuth state values, so a weak or shared default
// would let anyone forge both. Refuse to boot with one in production, and use a
// random per-process secret (which invalidates existing logins on restart)
// rather than a publicly known constant anywhere else.
const sessionSecret = (() => {
  const configured = process.env.SESSION_SECRET || '';
  if (configured.length >= 32) return configured;
  if (process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET must be set to at least 32 characters in production.');
  console.warn('[config] SESSION_SECRET is missing or shorter than 32 characters. Using a random secret for this process; logins will not survive a restart.');
  return crypto.randomBytes(48).toString('hex');
})();

const publicUrl = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
const pipedApiUrls = (process.env.PIPED_API_URLS || process.env.PIPED_API_URL || '')
  .split(',')
  .map((value) => value.trim().replace(/\/$/, ''))
  .filter((value) => {
    if (!value) return false;
    try { return new URL(value).protocol === 'https:'; }
    catch { console.warn(`[config] Ignoring invalid Piped API URL: ${value}`); return false; }
  });
const gigabytes = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed * 1024 * 1024 * 1024) : Math.floor(fallback * 1024 * 1024 * 1024);
};
const minutes = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed * 60) : fallback;
};
const megabytes = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed * 1024 * 1024) : fallback * 1024 * 1024;
};
const boolean = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
};
const integer = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
};
const spotifyMarket = /^[A-Z]{2}$/.test(String(process.env.SPOTIFY_MARKET || 'US').trim().toUpperCase())
  ? String(process.env.SPOTIFY_MARKET || 'US').trim().toUpperCase()
  : 'US';
const botOwnerId = /^\d{15,25}$/.test(String(process.env.BOT_OWNER_ID || '').trim())
  ? String(process.env.BOT_OWNER_ID).trim()
  : '';
if (process.env.BOT_OWNER_ID && !botOwnerId) console.warn('[config] BOT_OWNER_ID is not a valid Discord user ID. The owner dashboard will stay disabled.');

module.exports = {
  token: process.env.DISCORD_TOKEN || '',
  clientId: process.env.DISCORD_CLIENT_ID || '',
  clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
  publicUrl,
  redirectUri: `${publicUrl}/auth/callback`,
  port: Number(process.env.PORT || 3000),
  sessionSecret,
  databasePath: process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'karaoke.sqlite'),
  libraryPath: process.env.LIBRARY_PATH || path.join(process.cwd(), 'data', 'library'),
  libraryUploadsEnabled: boolean(process.env.LIBRARY_UPLOADS_ENABLED, false),
  libraryMaxBytes: gigabytes(process.env.LIBRARY_MAX_GB, 20),
  libraryMaxDurationSeconds: minutes(process.env.LIBRARY_MAX_MINUTES, 5 * 60),
  libraryMaxUploadBytes: megabytes(process.env.LIBRARY_MAX_UPLOAD_MB, 50),
  libraryMaxUserBytes: gigabytes(process.env.LIBRARY_MAX_USER_GB, 1),
  libraryMaxGuildBytes: gigabytes(process.env.LIBRARY_MAX_GUILD_GB, 5),
  pipedApiUrls,
  // Guild permissions come from Discord at login. Re-read them periodically so
  // that revoking Manage Server takes effect without waiting for the session to
  // expire.
  guildCacheMs: integer(process.env.GUILD_CACHE_MINUTES, 5, 1, 60) * 60 * 1000,
  queueMaxTracks: integer(process.env.QUEUE_MAX_TRACKS, 100, 1, 500),
  mediaTimeoutMs: integer(process.env.MEDIA_TIMEOUT_SECONDS, 45, 5, 300) * 1000,
  mediaMaxConcurrency: integer(process.env.MEDIA_MAX_CONCURRENCY, 4, 1, 32),
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID || '',
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
  spotifyMarket,
  botOwnerId
};
