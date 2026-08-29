const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const Busboy = require('busboy');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const config = require('./config');
const { client, karaoke, inviteUrl } = require('./bot');
const { searchTracks } = require('./media');
const { listForGuild, removeFromGuild, saveUpload, trackForGuild } = require('./library');
const { ensureGuild, getGuild, updateGuild, saveUser } = require('./db');
const { SQLiteStore } = require('./session-store');
const { createOAuthState, validOAuthState } = require('./oauth');
const { isDiscordId, validateDiscordIdList, validateOptionalDiscordId, validateQueueIndex, validateSongQuery, validateVolume } = require('./validation');

const app = express();
if (config.publicUrl.startsWith('https://')) app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], baseUri: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], scriptSrc: ["'self'"], styleSrc: ["'self'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com', 'https://*.ytimg.com', 'https://yt3.ggpht.com', 'https://*.sndcdn.com'], connectSrc: ["'self'"], formAction: ["'self'", 'https://discord.com'] } } }));
app.use(express.json({ limit: '100kb' }));
app.use(session({ secret: config.sessionSecret, store: new SQLiteStore(), proxy: config.publicUrl.startsWith('https://'), resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: config.publicUrl.startsWith('https://'), maxAge: 7 * 24 * 60 * 60 * 1000 } }));
app.use(express.static(path.resolve(__dirname, '..', 'public')));
app.get('/healthz', (req, res) => res.json({ ok: true, discord: client.isReady() }));

function rateLimit(windowMs, max) {
  const requests = new Map();
  const cleanup = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, timestamps] of requests) {
      const recent = timestamps.filter((timestamp) => timestamp > cutoff);
      if (recent.length) requests.set(key, recent);
      else requests.delete(key);
    }
  }, windowMs).unref();
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const cutoff = Date.now() - windowMs;
    const timestamps = (requests.get(key) || []).filter((timestamp) => timestamp > cutoff);
    if (timestamps.length >= max) return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    timestamps.push(Date.now());
    requests.set(key, timestamps);
    next();
  };
}
const authLimiter = rateLimit(10 * 60 * 1000, 20);
const apiLimiter = rateLimit(60 * 1000, 120);
app.use('/api', apiLimiter);

const redirect = (res, path) => res.redirect(`${path}${path.includes('?') ? '&' : '?'}v=${Date.now()}`);
function requireLogin(req, res, next) { if (!req.session.user) return res.status(401).json({ error: 'Login required.' }); next(); }
function discordGuilds(req) { return req.session.guilds || []; }
function guildAccess(guild) {
  if (!guild) return { allowed: false, label: '' };
  const isOwner = guild.owner === true;
  if (isOwner) return { allowed: true, label: 'Server owner' };
  let permissions;
  try { permissions = BigInt(guild.permissions_new ?? guild.permissions ?? 0); } catch { return { allowed: false, label: '' }; }
  const hasManageServer = (permissions & 0x20n) !== 0n || (permissions & 0x8n) !== 0n;
  return { allowed: hasManageServer, label: 'Manage Server' };
}
function canManage(req, guildId) {
  const guild = discordGuilds(req).find((item) => item.id === guildId);
  return guildAccess(guild).allowed;
}
function requireGuild(req, res, next) { if (!isDiscordId(req.params.guildId) || !canManage(req, req.params.guildId)) return res.status(403).json({ error: 'You need to own this server or have Manage Server permission.' }); next(); }
function defaultTextChannel(guild) {
  return guild.systemChannel || guild.channels.cache.find((channel) => channel.isTextBased?.() && channel.permissionsFor(guild.members.me)?.has('SendMessages')) || null;
}

app.get('/auth/login', authLimiter, (req, res) => {
  if (!config.clientId || !config.clientSecret) return res.status(503).send('Discord OAuth is not configured. Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET.');
  const state = createOAuthState();
  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({ client_id: config.clientId, response_type: 'code', redirect_uri: config.redirectUri, scope: 'identify guilds', state });
  req.session.oauthState = state;
  req.session.save((error) => error ? res.status(500).send('Unable to start Discord login. Please try again.') : res.redirect(url.toString()));
});

app.get('/auth/callback', authLimiter, async (req, res) => {
  try {
    const expectedState = req.session.oauthState;
    delete req.session.oauthState;
    if (typeof req.query.code !== 'string' || req.query.code.length > 2048 || !validOAuthState(req.query.state, expectedState)) return res.status(400).send('Invalid or expired OAuth state. Please start the Discord login again.');
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
  } catch (error) { console.error('[oauth]', error); res.status(500).send('Login failed. Please try again.'); }
});
app.get('/auth/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

app.get('/api/me', (req, res) => res.json({ user: req.session.user || null }));
app.get('/api/search', requireLogin, async (req, res) => {
  try {
    const results = await searchTracks(req.query.q, typeof req.query.provider === 'string' ? req.query.provider : 'youtube');
    res.json({ results });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/guilds', requireLogin, (req, res) => res.json(discordGuilds(req).filter((guild) => canManage(req, guild.id)).map((guild) => ({ id: guild.id, name: guild.name, icon: guild.icon || null, iconUrl: guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.${guild.icon.startsWith('a_') ? 'gif' : 'png'}?size=128` : null, accessLabel: guildAccess(guild).label, botPresent: Boolean(client.guilds.cache.get(guild.id)), libraryUploadsEnabled: config.libraryUploadsEnabled, settings: getGuild(guild.id) || ensureGuild(guild.id, guild.name) }))));
app.get('/api/guilds/:guildId/status', requireLogin, requireGuild, (req, res, next) => {
  const state = createOAuthState();
  req.session.oauthState = state;
  req.session.save((error) => {
    if (error) return next(error);
    res.json({ status: karaoke.status(req.params.guildId), inviteUrl: inviteUrl(req.params.guildId, state), botPresent: Boolean(client.guilds.cache.get(req.params.guildId)) });
  });
});
app.get('/api/guilds/:guildId/channels', requireLogin, requireGuild, (req, res) => {
  const guild = client.guilds.cache.get(req.params.guildId);
  if (!guild) return res.status(409).json({ error: 'Invite the bot to this server first.' });
  res.json([...guild.channels.cache.values()].filter((channel) => channel.isVoiceBased?.() || channel.isTextBased?.()).map((channel) => ({ id: channel.id, name: channel.name, type: channel.isVoiceBased?.() ? 'voice' : 'text' })));
});
app.get('/api/guilds/:guildId/settings', requireLogin, requireGuild, (req, res) => res.json(getGuild(req.params.guildId) || ensureGuild(req.params.guildId)));
app.put('/api/guilds/:guildId/settings', requireLogin, requireGuild, (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const volume = body.defaultVolume === undefined ? undefined : validateVolume(body.defaultVolume);
    res.json(updateGuild(req.params.guildId, { guildName: discordGuilds(req).find((g) => g.id === req.params.guildId)?.name || '', allowedVoiceChannels: validateDiscordIdList(body.allowedVoiceChannels ?? [], 'Allowed voice channel IDs'), allowedTextChannels: validateDiscordIdList(body.allowedTextChannels ?? [], 'Allowed text channel IDs'), allowedRoles: validateDiscordIdList(body.allowedRoles ?? [], 'Allowed role IDs'), defaultVolume: volume }));
  } catch (error) { res.status(400).json({ error: error.message }); }
});

async function parseAudioUpload(req) {
  const contentType = String(req.headers['content-type'] || '');
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new Error('Upload the audio as a multipart form.');
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'karaoke-upload-'));
  return new Promise((resolve, reject) => {
    const tempPath = path.join(tempDir, 'upload.bin');
    let fileSeen = false;
    let filename = '';
    let fileTooLarge = false;
    let fields = {};
    let filePromise = Promise.resolve();
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) fsp.rm(tempDir, { recursive: true, force: true }).finally(() => reject(error));
      else resolve(value);
    };
    let parser;
    try {
      parser = Busboy({ headers: req.headers, limits: { files: 1, fileSize: config.libraryMaxUploadBytes, fields: 4, fieldSize: 2048 } });
    } catch (error) {
      finish(error);
      return;
    }
    parser.on('field', (name, value) => { if (name === 'title' || name === 'artist') fields[name] = value; });
    parser.on('file', (name, file, info) => {
      if (name !== 'file' || fileSeen) {
        file.resume();
        return finish(new Error('Send exactly one audio file in the `file` field.'));
      }
      fileSeen = true;
      filename = String(info?.filename || '').slice(0, 255);
      const output = fs.createWriteStream(tempPath, { flags: 'wx' });
      filePromise = new Promise((resolveFile, rejectFile) => {
        file.on('limit', () => { fileTooLarge = true; output.destroy(new Error(`Upload is limited to ${Math.floor(config.libraryMaxUploadBytes / 1024 / 1024)} MB.`)); });
        file.on('error', rejectFile);
        output.on('error', rejectFile);
        output.on('finish', resolveFile);
      });
      file.pipe(output);
    });
    parser.on('filesLimit', () => finish(new Error('Send exactly one audio file.')));
    parser.on('error', (error) => finish(error));
    parser.on('finish', async () => {
      try {
        await filePromise;
        if (fileTooLarge) throw new Error(`Upload is limited to ${Math.floor(config.libraryMaxUploadBytes / 1024 / 1024)} MB.`);
        if (!fileSeen) throw new Error('Choose an audio file to upload.');
        finish(null, { tempDir, tempPath, fields, filename });
      } catch (error) { finish(error); }
    });
    req.on('aborted', () => finish(new Error('The upload was interrupted.')));
    req.pipe(parser);
  });
}

app.get('/api/guilds/:guildId/library', requireLogin, requireGuild, (req, res) => {
  res.json({ tracks: listForGuild(req.params.guildId) });
});
app.post('/api/guilds/:guildId/library', requireLogin, requireGuild, async (req, res) => {
  if (!config.libraryUploadsEnabled) return res.status(403).json({ error: 'Song uploads are disabled. Set LIBRARY_UPLOADS_ENABLED=true to enable them.' });
  let upload;
  try {
    upload = await parseAudioUpload(req);
    const track = await saveUpload({ sourcePath: upload.tempPath, guildId: req.params.guildId, userId: req.session.user.id, title: upload.fields.title, artist: upload.fields.artist, filename: upload.filename });
    res.status(201).json(track);
  } catch (error) { res.status(400).json({ error: error.message }); }
  finally { if (upload?.tempDir) await fsp.rm(upload.tempDir, { recursive: true, force: true }).catch(() => {}); }
});
app.delete('/api/guilds/:guildId/library/:fileId', requireLogin, requireGuild, async (req, res) => {
  try { res.json(await removeFromGuild(req.params.guildId, req.params.fileId)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

async function requesterVoiceMember(guild, userId) {
  const member = await guild.members.fetch(userId).catch(() => null);
  return member?.voice?.channel || null;
}
function control(method) {
  return async (req, res) => {
    try {
      const id = req.params.guildId;
      if (!client.guilds.cache.get(id)) return res.status(409).json({ error: 'Invite the bot to this server first.' });
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const guild = client.guilds.cache.get(id);
      if (method === 'play') {
        const voice = await requesterVoiceMember(guild, req.session.user.id) || guild.members.me?.voice?.channel;
        const query = body.libraryId !== undefined ? trackForGuild(id, body.libraryId) : validateSongQuery(body.song);
        const track = await karaoke.add(guild, query, voice, voice || defaultTextChannel(guild), req.session.user.id);
        return res.json(track);
      }
      if (method === 'join') {
        const channelId = validateOptionalDiscordId(body.channelId);
        const voice = (channelId ? guild.channels.cache.get(channelId) : null) || await requesterVoiceMember(guild, req.session.user.id);
        await karaoke.join(guild, voice, voice || defaultTextChannel(guild), req.session.user.id);
        return res.json({ ok: true });
      }
      if (method === 'remove') {
        karaoke.removeQueued(id, validateQueueIndex(body.index));
        return res.json({ ok: true });
      }
      if (method === 'move') {
        karaoke.moveQueued(id, validateQueueIndex(body.from), validateQueueIndex(body.to));
        return res.json({ ok: true });
      }
      if (method === 'clear') {
        return res.json({ removed: karaoke.clearQueue(id) });
      }
      if (method === 'skip') await karaoke.skip(id, guild, req.session.user.id);
      if (method === 'pause') karaoke.pause(id);
      if (method === 'resume') karaoke.resume(id);
      if (method === 'stop' || method === 'leave') karaoke[method](id);
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ error: error.message }); }
  };
}
for (const [method, path] of [['play', '/api/guilds/:guildId/play'], ['join', '/api/guilds/:guildId/join'], ['remove', '/api/guilds/:guildId/queue/remove'], ['move', '/api/guilds/:guildId/queue/move'], ['clear', '/api/guilds/:guildId/queue/clear'], ['skip', '/api/guilds/:guildId/skip'], ['pause', '/api/guilds/:guildId/pause'], ['resume', '/api/guilds/:guildId/resume'], ['stop', '/api/guilds/:guildId/stop'], ['leave', '/api/guilds/:guildId/leave']]) app.post(path, requireLogin, requireGuild, control(method));

app.get(/.*/, (req, res) => res.sendFile(path.resolve(__dirname, '..', 'public', 'index.html')));
module.exports = { app };
