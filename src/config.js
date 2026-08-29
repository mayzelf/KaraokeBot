const path = require('node:path');
require('dotenv').config();

const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'SESSION_SECRET'];
for (const key of required) {
  if (!process.env[key]) console.warn(`[config] ${key} is not set. The related feature will not work until it is configured.`);
}

const publicUrl = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');

module.exports = {
  token: process.env.DISCORD_TOKEN || '',
  clientId: process.env.DISCORD_CLIENT_ID || '',
  clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
  publicUrl,
  redirectUri: `${publicUrl}/auth/callback`,
  port: Number(process.env.PORT || 3000),
  sessionSecret: process.env.SESSION_SECRET || 'development-only-change-me',
  databasePath: process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'karaoke.sqlite')
};
