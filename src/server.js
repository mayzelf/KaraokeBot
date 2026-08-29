const path = require('node:path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const config = require('./config');
const { client, karaoke, inviteUrl } = require('./bot');
const { ensureGuild, getGuild, updateGuild, saveUser } = require('./db');
const { createOAuthState, validOAuthState } = require('./oauth');

const app = express();
if (config.publicUrl.startsWith('https://')) app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(session({ secret: config.sessionSecret, proxy: config.publicUrl.startsWith('https://'), resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: config.publicUrl.startsWith('https://'), maxAge: 7 * 24 * 60 * 60 * 1000 } }));
app.use(express.static(path.resolve(__dirname, '..', 'public')));
app.get('/healthz', (req, res) => res.json({ ok: true, discord: client.isReady() }));

const redirect = (res, path) => res.redirect(`${path}${path.includes('?') ? '&' : '?'}v=${Date.now()}`);
function requireLogin(req, res, next) { if (!req.session.user) return res.status(401).json({ error: 'Login required.' }); next(); }
function discordGuilds(req) { return req.session.guilds || []; }
function canManage(req, guildId) {
  if (config.ownerIds.has(req.session.user?.id)) return true;
  const guild = discordGuilds(req).find((item) => item.id === guildId);
  if (!guild) return false;
  let permissions;
  try { permissions = BigInt(guild.permissions_new ?? guild.permissions ?? 0); } catch { return false; }
  const canInviteBot = (permissions & 0x20n) !== 0n || (permissions & 0x8n) !== 0n;
  return guild.owner === true || canInviteBot;
}
function requireGuild(req, res, next) { if (!canManage(req, req.params.guildId)) return res.status(403).json({ error: 'You need Manage Server permission for this server.' }); next(); }
function defaultTextChannel(guild) {
  return guild.systemChannel || guild.channels.cache.find((channel) => channel.isTextBased?.() && channel.permissionsFor(guild.members.me)?.has('SendMessages')) || null;
}

app.get('/auth/login', (req, res) => {
  if (!config.clientId || !config.clientSecret) return res.status(503).send('Discord OAuth is not configured. Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET.');
  const state = createOAuthState();
  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({ client_id: config.clientId, response_type: 'code', redirect_uri: config.redirectUri, scope: 'identify guilds', state });
  res.redirect(url.toString());
});

app.get('/auth/callback', async (req, res) => {
  try {
    if (!req.query.code || !validOAuthState(req.query.state)) return res.status(400).send('Invalid or expired OAuth state. Please start the Discord login again.');
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'authorization_code', code: req.query.code, redirect_uri: config.redirectUri }) });
    const token = await tokenResponse.json();
    if (!token.access_token) throw new Error('Discord did not return an access token.');
    const headers = { Authorization: `Bearer ${token.access_token}` };
    const [user, guilds] = await Promise.all([fetch('https://discord.com/api/users/@me', { headers }).then((r) => r.json()), fetch('https://discord.com/api/users/@me/guilds', { headers }).then((r) => r.json())]);
    req.session.user = user;
    req.session.guilds = Array.isArray(guilds) ? guilds : [];
    saveUser(user);
    await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
    redirect(res, '/');
  } catch (error) { console.error('[oauth]', error); res.status(500).send(`Login failed: ${error.message}`); }
});
app.get('/auth/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

app.get('/api/me', (req, res) => res.json({ user: req.session.user || null }));
app.get('/api/guilds', requireLogin, (req, res) => res.json(discordGuilds(req).filter((guild) => canManage(req, guild.id)).map((guild) => ({ ...guild, botPresent: Boolean(client.guilds.cache.get(guild.id)), settings: getGuild(guild.id) || ensureGuild(guild.id, guild.name) }))));
app.get('/api/guilds/:guildId/status', requireLogin, requireGuild, (req, res) => res.json({ status: karaoke.status(req.params.guildId), inviteUrl: inviteUrl(req.params.guildId), botPresent: Boolean(client.guilds.cache.get(req.params.guildId)) }));
app.get('/api/guilds/:guildId/channels', requireLogin, requireGuild, (req, res) => {
  const guild = client.guilds.cache.get(req.params.guildId);
  if (!guild) return res.status(409).json({ error: 'Invite the bot to this server first.' });
  res.json([...guild.channels.cache.values()].filter((channel) => channel.isVoiceBased?.() || channel.isTextBased?.()).map((channel) => ({ id: channel.id, name: channel.name, type: channel.isVoiceBased?.() ? 'voice' : 'text' })));
});
app.get('/api/guilds/:guildId/settings', requireLogin, requireGuild, (req, res) => res.json(getGuild(req.params.guildId) || ensureGuild(req.params.guildId)));
app.put('/api/guilds/:guildId/settings', requireLogin, requireGuild, (req, res) => {
  const body = req.body || {};
  const cleanIds = (value) => Array.isArray(value) ? value.map(String).map((value) => value.trim()).filter((value) => /^\d{15,25}$/.test(value)).slice(0, 100) : [];
  res.json(updateGuild(req.params.guildId, { guildName: discordGuilds(req).find((g) => g.id === req.params.guildId)?.name || '', allowedVoiceChannels: cleanIds(body.allowedVoiceChannels), allowedTextChannels: cleanIds(body.allowedTextChannels), allowedRoles: cleanIds(body.allowedRoles), defaultVolume: body.defaultVolume }));
});

async function requesterVoiceMember(guild, userId) {
  const member = await guild.members.fetch(userId).catch(() => null);
  return member?.voice?.channel || null;
}
function control(method) { return async (req, res) => { try { const id = req.params.guildId; if (!client.guilds.cache.get(id)) return res.status(409).json({ error: 'Invite the bot to this server first.' }); const guild = client.guilds.cache.get(id); if (method === 'play') { const voice = await requesterVoiceMember(guild, req.session.user.id) || guild.members.me?.voice?.channel; const track = await karaoke.add(guild, String(req.body.song || ''), voice, voice || defaultTextChannel(guild)); return res.json(track); } if (method === 'join') { const voice = guild.channels.cache.get(req.body.channelId) || await requesterVoiceMember(guild, req.session.user.id); await karaoke.join(guild, voice, voice || defaultTextChannel(guild)); return res.json({ ok: true }); } if (method === 'skip') await karaoke.skip(id); if (method === 'pause') karaoke.pause(id); if (method === 'resume') karaoke.resume(id); if (method === 'stop' || method === 'leave') karaoke[method](id); res.json({ ok: true }); } catch (error) { res.status(400).json({ error: error.message }); } }; }
for (const [method, path] of [['play', '/api/guilds/:guildId/play'], ['join', '/api/guilds/:guildId/join'], ['skip', '/api/guilds/:guildId/skip'], ['pause', '/api/guilds/:guildId/pause'], ['resume', '/api/guilds/:guildId/resume'], ['stop', '/api/guilds/:guildId/stop'], ['leave', '/api/guilds/:guildId/leave']]) app.post(path, requireLogin, requireGuild, control(method));

app.get(/.*/, (req, res) => res.sendFile(path.resolve(__dirname, '..', 'public', 'index.html')));
module.exports = { app };
