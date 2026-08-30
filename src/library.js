const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const config = require('./config');
const { createLimiter, runCommand } = require('./proc');
const { db } = require('./db');

// Uploaded audio is attacker-controlled. FFmpeg happily follows remote
// references inside containers and playlists, so every local invocation is
// pinned to the file protocol to keep a crafted upload from reading the host
// filesystem or reaching internal services.
const FFMPEG_LOCAL_PROTOCOLS = ['-protocol_whitelist', 'file'];
const limitTranscode = createLimiter(config.mediaMaxConcurrency);

let operationQueue = Promise.resolve();

function serialize(operation) {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.catch(() => {});
  return result;
}

function cleanText(value, fallback = '', limit = 200) {
  return String(value || fallback).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit);
}

function publicTrack(row, includePath = false) {
  if (!row) return null;
  const track = {
    id: String(row.id),
    source: 'library',
    title: row.title,
    artist: row.artist || '',
    duration: Number(row.duration_seconds),
    sizeBytes: Number(row.size_bytes),
    thumbnail: null,
  };
  if (includePath) Object.defineProperty(track, 'path', { value: path.join(config.libraryPath, row.storage_name), enumerable: false });
  return track;
}

function ensureLibraryPath() {
  fs.mkdirSync(config.libraryPath, { recursive: true });
}

function runTool(command, args, timeoutMs) {
  return limitTranscode(() => runCommand(command, args, { timeoutMs, maxOutputBytes: 4 * 1024 * 1024 }));
}

async function probe(filePath) {
  let output;
  try {
    output = await runTool('ffprobe', ['-v', 'error', ...FFMPEG_LOCAL_PROTOCOLS, '-print_format', 'json', '-show_streams', '-show_format', filePath], 20_000);
  } catch {
    throw new Error('That file is not a readable audio file.');
  }
  let data;
  try { data = JSON.parse(output.stdout); } catch { throw new Error('That file could not be inspected as audio.'); }
  const streams = Array.isArray(data.streams) ? data.streams : [];
  if (!streams.length || streams.some((stream) => stream.codec_type === 'video') || streams.some((stream) => stream.codec_type !== 'audio')) {
    throw new Error('Upload an audio-only file. Video, images, and mixed media are not accepted.');
  }
  const audio = streams[0];
  const duration = Number(audio.duration || data.format?.duration || 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('The audio duration could not be determined.');
  if (duration > config.libraryMaxDurationSeconds + 0.05) throw new Error(`Audio must be ${Math.floor(config.libraryMaxDurationSeconds / 60)} minutes or shorter.`);
  return {
    duration,
    title: cleanText(audio.tags?.title || data.format?.tags?.title, '', 200),
    artist: cleanText(audio.tags?.artist || data.format?.tags?.artist, '', 120)
  };
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function transcode(sourcePath, destinationPath) {
  try {
    await runTool('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', ...FFMPEG_LOCAL_PROTOCOLS, '-i', sourcePath,
      '-vn', '-map', '0:a:0', '-map_metadata', '-1',
      '-c:a', 'libopus', '-b:a', '128k', '-vbr', 'on', '-application', 'audio',
      '-ar', '48000', '-ac', '2',
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:dual_mono=true',
      '-f', 'ogg', destinationPath
    ], config.mediaTimeoutMs * 4);
  } catch (error) {
    // FFmpeg's stderr names container paths and codec internals; log it instead
    // of returning it to the uploader.
    console.warn('[ffmpeg] transcode failed:', error.stderr?.trim() || error.message);
    throw new Error('That audio file could not be converted. Try a different file or format.');
  }
}

function usage(guildId, userId) {
  const guild = db.prepare('SELECT COALESCE(SUM(lf.size_bytes), 0) AS bytes FROM guild_library gl JOIN library_files lf ON lf.id = gl.file_id WHERE gl.guild_id = ?').get(guildId);
  const user = db.prepare('SELECT COALESCE(SUM(lf.size_bytes), 0) AS bytes FROM guild_library gl JOIN library_files lf ON lf.id = gl.file_id WHERE gl.guild_id = ? AND gl.added_by = ?').get(guildId, userId);
  const total = db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM library_files').get();
  return { guildBytes: Number(guild.bytes), userBytes: Number(user.bytes), totalBytes: Number(total.bytes) };
}

function addReference(guildId, fileId, addedBy) {
  const result = db.prepare('INSERT OR IGNORE INTO guild_library (guild_id, file_id, added_by) VALUES (?, ?, ?)').run(guildId, fileId, addedBy);
  return result.changes > 0;
}

async function saveUpload({ sourcePath, guildId, userId, title, artist, filename }) {
  return serialize(async () => {
    ensureLibraryPath();
    const metadata = await probe(sourcePath);
    const finalTitle = cleanText(title, metadata.title || path.basename(filename || sourcePath, path.extname(filename || sourcePath)), 200) || 'Untitled track';
    const finalArtist = cleanText(artist, metadata.artist, 120);
    const workingPath = path.join(config.libraryPath, `.upload-${crypto.randomUUID()}.ogg`);
    let moved = false;
    let storedPath = null;
    try {
      await transcode(sourcePath, workingPath);
      const stat = await fsp.stat(workingPath);
      if (!stat.size) throw new Error('FFmpeg produced an empty audio file.');
      const sha256 = await hashFile(workingPath);
      const existing = db.prepare('SELECT * FROM library_files WHERE sha256 = ?').get(sha256);
      if (existing) {
        const alreadyAdded = db.prepare('SELECT 1 FROM guild_library WHERE guild_id = ? AND file_id = ?').get(guildId, existing.id);
        if (alreadyAdded) throw new Error('That song is already in this server library.');
        const current = usage(guildId, userId);
        if (current.guildBytes + existing.size_bytes > config.libraryMaxGuildBytes) throw new Error('This server library has reached its storage limit.');
        if (current.userBytes + existing.size_bytes > config.libraryMaxUserBytes) throw new Error('You have reached your upload quota for this server.');
        addReference(guildId, existing.id, userId);
        return publicTrack(existing);
      }

      const current = usage(guildId, userId);
      if (current.totalBytes + stat.size > config.libraryMaxBytes) throw new Error('The shared audio library is full.');
      if (current.guildBytes + stat.size > config.libraryMaxGuildBytes) throw new Error('This server library has reached its storage limit.');
      if (current.userBytes + stat.size > config.libraryMaxUserBytes) throw new Error('You have reached your upload quota for this server.');

      const storageName = `${sha256}.ogg`;
      const destinationPath = path.join(config.libraryPath, storageName);
      storedPath = destinationPath;
      await fsp.rename(workingPath, destinationPath);
      moved = true;
      const row = db.transaction(() => {
        const result = db.prepare(`INSERT INTO library_files (sha256, storage_name, title, artist, duration_seconds, size_bytes, uploaded_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(sha256, storageName, finalTitle, finalArtist, metadata.duration, stat.size, userId);
        addReference(guildId, result.lastInsertRowid, userId);
        return db.prepare('SELECT * FROM library_files WHERE id = ?').get(result.lastInsertRowid);
      })();
      return publicTrack(row);
    } catch (error) {
      if (moved && storedPath) await fsp.unlink(storedPath).catch(() => {});
      throw error;
    } finally {
      await fsp.unlink(workingPath).catch(() => {});
    }
  });
}

function listForGuild(guildId) {
  return db.prepare(`SELECT lf.* FROM guild_library gl JOIN library_files lf ON lf.id = gl.file_id
    WHERE gl.guild_id = ? ORDER BY lower(lf.title), lower(lf.artist), lf.id`).all(guildId).map((row) => publicTrack(row));
}

function trackForGuild(guildId, fileId) {
  const id = Number(fileId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid library track.');
  const row = db.prepare(`SELECT lf.* FROM guild_library gl JOIN library_files lf ON lf.id = gl.file_id
    WHERE gl.guild_id = ? AND lf.id = ?`).get(guildId, id);
  if (!row) throw new Error('That library track no longer exists.');
  return publicTrack(row, true);
}

async function removeFromGuild(guildId, fileId) {
  return serialize(async () => {
    const id = Number(fileId);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid library track.');
    const row = db.prepare(`SELECT lf.* FROM guild_library gl JOIN library_files lf ON lf.id = gl.file_id
      WHERE gl.guild_id = ? AND lf.id = ?`).get(guildId, id);
    if (!row) throw new Error('That library track no longer exists.');
    const deleteFile = db.transaction(() => {
      db.prepare('DELETE FROM guild_library WHERE guild_id = ? AND file_id = ?').run(guildId, id);
      const references = db.prepare('SELECT COUNT(*) AS count FROM guild_library WHERE file_id = ?').get(id);
      if (Number(references.count) > 0) return false;
      db.prepare('DELETE FROM library_files WHERE id = ?').run(id);
      return true;
    })();
    if (deleteFile) await fsp.unlink(path.join(config.libraryPath, row.storage_name)).catch(() => {});
    return { ok: true };
  });
}

module.exports = { listForGuild, removeFromGuild, saveUpload, trackForGuild };
