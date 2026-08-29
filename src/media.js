const { spawn } = require('node:child_process');
const config = require('./config');
const { isSoundCloudUrl, isYouTubeUrl, safeSoundCloudArtwork, safeYouTubeThumbnail, validateSongQuery } = require('./validation');
// The base image includes Node 22. yt-dlp requires a JS runtime for YouTube's
// challenge solving; enable Node explicitly instead of relying on detection.
const YTDLP_RUNTIME_ARGS = ['--js-runtimes', 'node'];
const YTDLP_EXTRACTOR_ARGS = [];
if (process.env.YTDLP_PLAYER_CLIENT?.trim()) {
  YTDLP_EXTRACTOR_ARGS.push('--extractor-args', `youtube:player_client=${process.env.YTDLP_PLAYER_CLIENT.trim()}`);
}
if (process.env.YTDLP_POT_PROVIDER_URL?.trim()) {
  YTDLP_EXTRACTOR_ARGS.push(
    '--extractor-args',
    `youtubepot-bgutilhttp:base_url=${process.env.YTDLP_POT_PROVIDER_URL.trim()}`
  );
}
// A hosted instance cannot use --cookies-from-browser because its browser
// profile is not available inside the container. Mount a Netscape-format
// cookie file and point YTDLP_COOKIES_FILE at it instead.
const YTDLP_AUTH_ARGS = [];
if (process.env.YTDLP_COOKIES_FILE?.trim()) {
  YTDLP_AUTH_ARGS.push('--cookies', process.env.YTDLP_COOKIES_FILE.trim());
}
if (process.env.YTDLP_USER_AGENT?.trim()) {
  YTDLP_AUTH_ARGS.push('--user-agent', process.env.YTDLP_USER_AGENT.trim());
}

function ytDlpError(stderr, code) {
  const detail = String(stderr || '').split(/\r?\n/).map((line) => line.trim()).find((line) => /^ERROR:/i.test(line));
  if (/\b(?:not available|unavailable|private|removed|blocked)\b/i.test(detail || '')) {
    return new Error('That YouTube video is unavailable, private, or blocked. Please choose another track.');
  }
  return new Error(detail?.replace(/^ERROR:\s*/i, '') || `yt-dlp could not process the request (exit code ${code}).`);
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', [...YTDLP_RUNTIME_ARGS, ...YTDLP_EXTRACTOR_ARGS, ...YTDLP_AUTH_ARGS, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(ytDlpError(stderr, code)));
  });
}

function cleanMetadata(value, fallback = '', limit = 200) {
  return String(value || fallback).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit);
}

function parseJson(output, message) {
  try { return JSON.parse(output); } catch { throw new Error(message); }
}

function youtubeId(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value), 'https://www.youtube.com');
    const id = url.hostname === 'youtu.be' || url.hostname === 'www.youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v');
    return id && /^[\w-]{5,20}$/.test(id) ? id : null;
  } catch { return /^[\w-]{5,20}$/.test(String(value)) ? String(value) : null; }
}

function previewYouTube(data, provider = 'YouTube') {
  const id = youtubeId(data?.id || data?.videoId || data?.url);
  if (!id) return null;
  const url = validateSongQuery(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`);
  return {
    id,
    url,
    source: 'youtube',
    provider,
    title: cleanMetadata(data.title, 'Untitled track'),
    artist: cleanMetadata(data.artist || data.channel || data.uploader || data.uploaderName, '', 120),
    duration: Number(data.duration || 0),
    thumbnail: safeYouTubeThumbnail(data.thumbnail)
  };
}

function previewSoundCloud(data) {
  const url = data?.webpage_url || data?.original_url || data?.url;
  if (!isSoundCloudUrl(url)) return null;
  return {
    id: `soundcloud:${data.id || url}`,
    url: validateSongQuery(url),
    source: 'soundcloud',
    provider: 'SoundCloud',
    title: cleanMetadata(data.title, 'Untitled track'),
    artist: cleanMetadata(data.artist || data.uploader || data.creator, '', 120),
    duration: Number(data.duration || 0),
    thumbnail: safeSoundCloudArtwork(data.thumbnail || data.thumbnail_url)
  };
}

async function searchYouTube(cleanQuery) {
  const output = await runYtDlp(['--flat-playlist', '--playlist-end', '5', '--dump-single-json', '--no-warnings', `ytsearch5:${cleanQuery}`]);
  const data = parseJson(output, 'YouTube returned an invalid search response.');
  return (Array.isArray(data.entries) ? data.entries : []).map((item) => previewYouTube(item)).filter(Boolean);
}

async function searchSoundCloud(cleanQuery) {
  const output = await runYtDlp(['--flat-playlist', '--playlist-end', '5', '--dump-single-json', '--no-warnings', `scsearch5:${cleanQuery}`]);
  const data = parseJson(output, 'SoundCloud returned an invalid search response.');
  return (Array.isArray(data.entries) ? data.entries : []).map(previewSoundCloud).filter(Boolean);
}

async function pipedRequest(endpoint, params = {}, isUsable = () => true) {
  if (!config.pipedApiUrls.length) throw new Error('Piped is not configured.');
  let lastError;
  for (const apiUrl of config.pipedApiUrls) {
    try {
      const url = new URL(`${apiUrl}${endpoint}`);
      Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
      const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!isUsable(data)) throw new Error('response did not contain usable data');
      return data;
    } catch (error) {
      lastError = error;
      console.warn(`[piped] ${apiUrl} failed: ${error.message}`);
    }
  }
  throw new Error(`All configured Piped instances failed. Last error: ${lastError?.message || 'unknown error'}`);
}

async function searchPiped(cleanQuery) {
  const data = await pipedRequest('/search', { q: cleanQuery, filter: 'videos' }, (value) => {
    const items = Array.isArray(value) ? value : value?.items;
    return Array.isArray(items) && items.some((item) => (item.type === undefined || item.type === 'stream') && youtubeId(item.url || item.id || item.videoId));
  });
  return (Array.isArray(data) ? data : data.items || []).filter((item) => item.type === undefined || item.type === 'stream').map((item) => previewYouTube({
    id: item.url || item.id || item.videoId,
    title: item.title,
    uploaderName: item.uploaderName || item.uploader,
    duration: item.duration,
    thumbnail: item.thumbnail
  }, 'YouTube via Piped')).filter(Boolean);
}

function uniqueTracks(tracks) {
  const seen = new Set();
  return tracks.filter((track) => {
    const key = track.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function searchTracks(query, provider = 'youtube') {
  const cleanQuery = validateSongQuery(query);
  if (/^https?:\/\//i.test(cleanQuery)) return [];
  if (!['youtube', 'soundcloud'].includes(provider)) throw new Error('That search provider is not supported.');
  if (provider === 'soundcloud') return uniqueTracks(await searchSoundCloud(cleanQuery));
  let youtubeError;
  try {
    const youtube = uniqueTracks(await searchYouTube(cleanQuery));
    if (youtube.length) return youtube;
  } catch (error) { youtubeError = error; }
  if (config.pipedApiUrls.length) {
    const piped = uniqueTracks(await searchPiped(cleanQuery).catch(() => []));
    if (piped.length) return piped;
  }
  throw youtubeError || new Error('No YouTube results were found.');
}

function addPrivateStreamUrl(track, streamUrl) {
  Object.defineProperty(track, 'streamUrl', { value: streamUrl, enumerable: false });
  return track;
}

async function resolvePipedTrack(url, fallbackTitle = 'YouTube track') {
  const id = youtubeId(url);
  if (!id) throw new Error('Piped could not identify that YouTube video.');
  const data = await pipedRequest(`/streams/${encodeURIComponent(id)}`, {}, (value) => (value.audioStreams || []).some((stream) => stream.url && !stream.videoOnly));
  const audio = (data.audioStreams || []).filter((stream) => stream.url && !stream.videoOnly).sort((left, right) => Number(right.bitrate || 0) - Number(left.bitrate || 0))[0];
  if (!audio) throw new Error('Piped did not return a playable audio stream.');
  const track = {
    id,
    url: validateSongQuery(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`),
    source: 'piped',
    provider: 'YouTube via Piped',
    title: cleanMetadata(data.title, fallbackTitle),
    artist: cleanMetadata(data.uploader || data.uploaderName, '', 120),
    duration: Number(data.duration || 0),
    thumbnail: safeYouTubeThumbnail(data.thumbnail)
  };
  return addPrivateStreamUrl(track, audio.url);
}

async function resolveWithYtDlp(target, fallback, source) {
  const output = await runYtDlp(['--dump-single-json', '--no-playlist', '--skip-download', target]);
  const data = parseJson(output, 'The media provider returned an invalid response.');
  if (!data.webpage_url || !data.id) throw new Error('No playable YouTube result was found.');
  const playableUrl = validateSongQuery(data.webpage_url);
  const resolvedSource = source || (isSoundCloudUrl(playableUrl) ? 'soundcloud' : 'youtube');
  return {
    id: data.id,
    url: playableUrl,
    source: resolvedSource,
    provider: resolvedSource === 'soundcloud' ? 'SoundCloud' : 'YouTube',
    title: cleanMetadata(data.title, fallback),
    artist: cleanMetadata(data.artist || data.uploader, '', 120),
    duration: Number(data.duration || 0),
    thumbnail: resolvedSource === 'soundcloud' ? safeSoundCloudArtwork(data.thumbnail || data.thumbnail_url) : safeYouTubeThumbnail(data.thumbnail)
  };
}

async function resolveTrack(query) {
  const cleanQuery = validateSongQuery(query);
  if (isSoundCloudUrl(cleanQuery)) return resolveWithYtDlp(cleanQuery, cleanQuery, 'soundcloud');
  if (isYouTubeUrl(cleanQuery)) {
    try { return await resolveWithYtDlp(cleanQuery, cleanQuery, 'youtube'); }
    catch (error) { if (config.pipedApiUrls.length) return resolvePipedTrack(cleanQuery, cleanQuery).catch(() => { throw error; }); throw error; }
  }
  let youtubeError;
  try { return await resolveWithYtDlp(`ytsearch1:${cleanQuery}`, cleanQuery, 'youtube'); }
  catch (error) { youtubeError = error; }
  try { return await resolveWithYtDlp(`scsearch1:${cleanQuery}`, cleanQuery, 'soundcloud'); }
  catch (soundCloudError) {
    if (config.pipedApiUrls.length) {
      try {
        const results = await searchPiped(cleanQuery);
        if (results[0]) return resolvePipedTrack(results[0].url, results[0].title);
      } catch {}
    }
    throw new Error(`No playable result was found. YouTube: ${youtubeError.message} SoundCloud: ${soundCloudError.message}`);
  }
}

function createAudioStream(track) {
  if (track.source === 'library' && track.path) return createLibraryAudioStream(track.path);
  if (track.source === 'piped' && track.streamUrl) return createRemoteAudioStream(track.streamUrl);
  const ytdlp = spawn('yt-dlp', [...YTDLP_RUNTIME_ARGS, ...YTDLP_EXTRACTOR_ARGS, ...YTDLP_AUTH_ARGS, '--no-playlist', '-f', 'bestaudio/best', '-o', '-', track.url], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    // Normalize different source videos to a consistent perceived loudness
    // before Discord receives the raw PCM stream. The dashboard volume is
    // applied afterward as the final user-controlled gain.
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:dual_mono=true',
    '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stream = ffmpeg.stdout;
  const handlePipeError = (error) => {
    // FFmpeg can close before yt-dlp when a track is skipped/stopped. Without
    // a listener, Node treats the resulting broken pipe as a process crash.
    if (error.code !== 'EPIPE') stream.destroy(error);
  };
  ytdlp.stdout.on('error', handlePipeError);
  ffmpeg.stdin.on('error', handlePipeError);
  ytdlp.stdout.pipe(ffmpeg.stdin);
  ytdlp.stderr.on('data', (chunk) => console.warn('[yt-dlp]', chunk.toString().trim()));
  ffmpeg.stderr.on('data', (chunk) => console.warn('[ffmpeg]', chunk.toString().trim()));
  stream.ytdlp = ytdlp;
  stream.ffmpeg = ffmpeg;
  stream.destroyChildren = () => {
    if (!ytdlp.killed) ytdlp.kill('SIGKILL');
    if (!ffmpeg.killed) ffmpeg.kill('SIGKILL');
  };
  ytdlp.on('error', (error) => stream.destroy(error));
  ffmpeg.on('error', (error) => stream.destroy(error));
  return stream;
}

function createRemoteAudioStream(streamUrl) {
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', streamUrl,
    '-vn', '-map', '0:a:0',
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:dual_mono=true',
    '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stream = ffmpeg.stdout;
  ffmpeg.stderr.on('data', (chunk) => console.warn('[ffmpeg]', chunk.toString().trim()));
  stream.ffmpeg = ffmpeg;
  stream.destroyChildren = () => { if (!ffmpeg.killed) ffmpeg.kill('SIGKILL'); };
  ffmpeg.on('error', (error) => stream.destroy(error));
  return stream;
}

function createLibraryAudioStream(filePath) {
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', filePath,
    '-vn', '-map', '0:a:0',
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:dual_mono=true',
    '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stream = ffmpeg.stdout;
  ffmpeg.stderr.on('data', (chunk) => console.warn('[ffmpeg]', chunk.toString().trim()));
  stream.ffmpeg = ffmpeg;
  stream.destroyChildren = () => { if (!ffmpeg.killed) ffmpeg.kill('SIGKILL'); };
  ffmpeg.on('error', (error) => stream.destroy(error));
  return stream;
}

module.exports = { createAudioStream, resolveTrack, searchTracks };
