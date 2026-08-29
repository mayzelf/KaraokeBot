const path = require('node:path');
require('dotenv').config();

const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'SESSION_SECRET'];
for (const key of required) {
  if (!process.env[key]) console.warn(`[config] ${key} is not set. The related feature will not work until it is configured.`);
}
if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) throw new Error('SESSION_SECRET must be set to at least 32 characters in production.');

const publicUrl = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
const pipedApiUrls = (process.env.PIPED_API_URLS || process.env.PIPED_API_URL || '')
  .split(',')
  .map((value) => value.trim().replace(/\/$/, ''))
  .filter(Boolean);
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

module.exports = {
  token: process.env.DISCORD_TOKEN || '',
  clientId: process.env.DISCORD_CLIENT_ID || '',
  clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
  publicUrl,
  redirectUri: `${publicUrl}/auth/callback`,
  port: Number(process.env.PORT || 3000),
  sessionSecret: process.env.SESSION_SECRET || 'development-only-change-me',
  databasePath: process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'karaoke.sqlite'),
  libraryPath: process.env.LIBRARY_PATH || path.join(process.cwd(), 'data', 'library'),
  libraryUploadsEnabled: boolean(process.env.LIBRARY_UPLOADS_ENABLED, false),
  libraryMaxBytes: gigabytes(process.env.LIBRARY_MAX_GB, 20),
  libraryMaxDurationSeconds: minutes(process.env.LIBRARY_MAX_MINUTES, 5 * 60),
  libraryMaxUploadBytes: megabytes(process.env.LIBRARY_MAX_UPLOAD_MB, 50),
  libraryMaxUserBytes: gigabytes(process.env.LIBRARY_MAX_USER_GB, 1),
  libraryMaxGuildBytes: gigabytes(process.env.LIBRARY_MAX_GUILD_GB, 5),
  pipedApiUrls
};
