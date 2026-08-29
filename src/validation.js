const DISCORD_ID = /^\d{15,25}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']);

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
  if (typeof value !== 'string') throw new Error('Enter a song title, artist, or YouTube URL.');
  const query = value.trim();
  if (!query || query.length > 300 || /[\u0000-\u001f\u007f]/.test(query)) throw new Error('Song searches must be between 1 and 300 characters.');
  if (/^https?:\/\//i.test(query)) {
    let url;
    try { url = new URL(query); } catch { throw new Error('Enter a valid YouTube URL.'); }
    if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase()) || !['http:', 'https:'].includes(url.protocol)) throw new Error('Only YouTube URLs are supported.');
  }
  return query;
}

function validateVolume(value) {
  const volume = Number(value);
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('Volume must be a number between 0 and 1.');
  return volume;
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

module.exports = { isDiscordId, safeYouTubeThumbnail, validateDiscordIdList, validateOptionalDiscordId, validateSongQuery, validateVolume };
