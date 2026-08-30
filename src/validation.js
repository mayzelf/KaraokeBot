const config = require('./config');

const DISCORD_ID = /^\d{15,25}$/;
const NON_HTTP_SCHEME = /^(?:file|data|javascript|vbscript|blob|jar|ftp|sftp|gopher|ws|wss|about|chrome|resource|php|expect|dict|tcp|rtmp|concat|subfile|crypto|pipe):/i;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']);
const SOUNDCLOUD_HOSTS = new Set(['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com']);

function isDiscordId(value) {
  return typeof value === 'string' && DISCORD_ID.test(value);
}

function validateDiscordId(value, label = 'Discord ID') {
  if (!isDiscordId(value)) throw new Error(`${label} must be a valid Discord ID.`);
  return value;
}

function validateDiscordIdList(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of Discord IDs.`);
  if (value.length > 100) throw new Error(`${label} cannot contain more than 100 IDs.`);
  const ids = value.map((id) => validateDiscordId(id, label));
  return [...new Set(ids)];
}

function validateOptionalDiscordId(value, label = 'Channel ID') {
  if (value === undefined || value === null || value === '') return null;
  return validateDiscordId(value, label);
}

function validateSongQuery(value) {
  if (typeof value !== 'string') throw new Error('Enter a song title, artist, or a supported audio URL.');
  const query = value.trim();
  if (!query || query.length > 300 || /[\u0000-\u001f\u007f]/.test(query)) throw new Error('Song searches must be between 1 and 300 characters.');
  // A non-http URI must be rejected rather than falling through as a plain
  // search phrase, since a search phrase is handed to yt-dlp as a bare target.
  // Titles such as "Song: the remix" are still ordinary searches, so only a
  // real scheme (`scheme://`) or a known dangerous opaque one is refused.
  if (NON_HTTP_SCHEME.test(query) || (/^[a-z][a-z0-9+.-]*:\/\//i.test(query) && !/^https?:\/\//i.test(query))) throw new Error('Only YouTube and SoundCloud URLs are supported.');
  if (/^https?:\/\//i.test(query)) {
    let url;
    try { url = new URL(query); } catch { throw new Error('Enter a valid YouTube or SoundCloud URL.'); }
    if (![...YOUTUBE_HOSTS, ...SOUNDCLOUD_HOSTS].includes(url.hostname.toLowerCase()) || !['http:', 'https:'].includes(url.protocol)) throw new Error('Only YouTube and SoundCloud URLs are supported.');
  }
  return query;
}

function isYouTubeUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && YOUTUBE_HOSTS.has(url.hostname.toLowerCase()); } catch { return false; }
}

function isSoundCloudUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && SOUNDCLOUD_HOSTS.has(url.hostname.toLowerCase()); } catch { return false; }
}

function validateVolume(value) {
  const volume = Number(value);
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('Volume must be a number between 0 and 1.');
  return volume;
}

function validateQueueIndex(value) {
  if (!Number.isInteger(value) || value < 0 || value >= config.queueMaxTracks) throw new Error('Queue position is invalid.');
  return value;
}

function safeYouTubeThumbnail(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const allowedHost = host === 'yt3.ggpht.com' || host.endsWith('.ytimg.com');
    return url.protocol === 'https:' && allowedHost ? url.toString() : null;
  } catch { return null; }
}

function safeSoundCloudArtwork(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'sndcdn.com' || host.endsWith('.sndcdn.com')) ? url.toString() : null;
  } catch { return null; }
}

module.exports = { isDiscordId, isSoundCloudUrl, isYouTubeUrl, safeSoundCloudArtwork, safeYouTubeThumbnail, validateDiscordIdList, validateOptionalDiscordId, validateQueueIndex, validateSongQuery, validateVolume };
