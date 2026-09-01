const { spawn } = require('node:child_process');
const config = require('./config');
const { createLimiter, runCommand } = require('./proc');
const { isSoundCloudUrl, isSpotifyPlaylistUrl, isYouTubeUrl, safeSoundCloudArtwork, safeYouTubeThumbnail, validateSongQuery } = require('./validation');
// yt-dlp and ffmpeg are the only places where request data reaches an external
// program. Bound how many can run at once so that a burst of authenticated
// searches cannot exhaust the host's processes or memory.
const limitMedia = createLimiter(config.mediaMaxConcurrency);
// Never read an operator's or a stray user's yt-dlp config file: it can add
// arbitrary options, including --exec.
const YTDLP_SAFETY_ARGS = ['--ignore-config', '--no-exec', '--socket-timeout', '15', '--retries', '2'];
// FFmpeg accepts remote protocols inside containers and playlists. Restrict the
// protocols per input so that a crafted file or a hostile stream URL cannot be
// turned into an SSRF or a local file read.
const FFMPEG_LOCAL_PROTOCOLS = ['-protocol_whitelist', 'file'];
const FFMPEG_PIPE_PROTOCOLS = ['-protocol_whitelist', 'pipe'];
const FFMPEG_REMOTE_PROTOCOLS = ['-protocol_whitelist', 'https,tls,tcp,crypto'];
// Normalize different sources to a consistent perceived loudness before Discord
// receives the raw PCM. The dashboard volume is applied afterward as the final
// user-controlled gain.
const LOUDNORM_FILTER = 'loudnorm=I=-16:TP=-1.5:LRA=11:dual_mono=true';
// Karaoke on a budget: most mixes put the lead vocal dead center, so subtracting
// the channels from each other cancels much of it. This is a matrix multiply,
// not source separation - it costs nothing measurable, but it also removes
// anything else centered (kick, snare, bass) and leaves the vocal's reverb tail.
// Both output channels carry the same signal so a mono downmix cannot cancel it.
const INSTRUMENTAL_FILTER = 'pan=stereo|c0=0.5*c0-0.5*c1|c1=0.5*c0-0.5*c1';
const audioFilter = ({ instrumental } = {}) => (instrumental ? `${INSTRUMENTAL_FILTER},${LOUDNORM_FILTER}` : LOUDNORM_FILTER);
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
const YOUTUBE_COOKIES_CONFIGURED = Boolean(process.env.YTDLP_COOKIES_FILE?.trim());
if (YOUTUBE_COOKIES_CONFIGURED) {
  YTDLP_AUTH_ARGS.push('--cookies', process.env.YTDLP_COOKIES_FILE.trim());
}
if (process.env.YTDLP_USER_AGENT?.trim()) {
  YTDLP_AUTH_ARGS.push('--user-agent', process.env.YTDLP_USER_AGENT.trim());
}

let spotifyToken = null;
let spotifyTokenPromise = null;

function ytDlpError(stderr, code) {
  const detail = String(stderr || '').split(/\r?\n/).map((line) => line.trim()).find((line) => /^ERROR:/i.test(line));
  if (/\b(?:not available|unavailable|private|removed|blocked)\b/i.test(detail || '')) {
    return new Error('That YouTube video is unavailable, private, or blocked. Please choose another track.');
  }
  if (/\b(?:age|sign in|login|confirm your age)\b/i.test(detail || '')) {
    return new Error('That track requires a signed-in account and cannot be played.');
  }
  // The remaining yt-dlp errors can name container paths, the cookie file, and
  // internal endpoints. Log them, but do not relay them to a dashboard user.
  console.warn('[yt-dlp]', detail || `exit code ${code}`);
  return new Error('That track could not be loaded from the media provider.');
}

// `target` is the only argument derived from user input. It is passed after
// `--` so that a value beginning with a dash can never become an option.
async function runYtDlp(args, target) {
  const argv = [...YTDLP_RUNTIME_ARGS, ...YTDLP_SAFETY_ARGS, ...YTDLP_EXTRACTOR_ARGS, ...YTDLP_AUTH_ARGS, ...args, ...(target ? ['--', target] : [])];
  try {
    const { stdout } = await limitMedia(() => runCommand('yt-dlp', argv, { timeoutMs: config.mediaTimeoutMs }));
    return stdout;
  } catch (error) {
    if (error.stderr !== undefined) throw ytDlpError(error.stderr, error.code);
    throw new Error('The media provider could not be reached.');
  }
}

function cleanMetadata(value, fallback = '', limit = 200) {
  return String(value || fallback).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit);
}

function parseJson(output, message) {
  try { return JSON.parse(output); } catch { throw new Error(message); }
}

function youtubeId(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^[\w-]{5,20}$/.test(raw)) return raw;
  try {
    const url = new URL(raw, 'https://www.youtube.com');
    const id = url.hostname === 'youtu.be' || url.hostname === 'www.youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v');
    return id && /^[\w-]{5,20}$/.test(id) ? id : null;
  } catch { return null; }
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
  const output = await runYtDlp(['--flat-playlist', '--playlist-end', '5', '--dump-single-json', '--no-warnings'], `ytsearch5:${cleanQuery}`);
  const data = parseJson(output, 'YouTube returned an invalid search response.');
  return (Array.isArray(data.entries) ? data.entries : []).map((item) => previewYouTube(item)).filter(Boolean);
}

async function searchSoundCloud(cleanQuery) {
  const output = await runYtDlp(['--flat-playlist', '--playlist-end', '5', '--dump-single-json', '--no-warnings'], `scsearch5:${cleanQuery}`);
  const data = parseJson(output, 'SoundCloud returned an invalid search response.');
  return (Array.isArray(data.entries) ? data.entries : []).map(previewSoundCloud).filter(Boolean);
}

function isPlaylistUrl(value) {
  try {
    const url = new URL(value);
    if (isYouTubeUrl(value)) return url.searchParams.has('list');
    if (isSpotifyPlaylistUrl(value)) return true;
    return isSoundCloudUrl(value) && /\/sets(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function spotifyPlaylistId(value) {
  if (!isSpotifyPlaylistUrl(value)) return null;
  const match = new URL(value).pathname.match(/\/(?:embed\/)?playlist\/([A-Za-z0-9]{22})/i);
  return match?.[1] || null;
}

async function getSpotifyToken() {
  if (!config.spotifyClientId || !config.spotifyClientSecret) {
    throw new Error('Spotify playlist importing is not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.');
  }
  if (spotifyToken && spotifyToken.expiresAt > Date.now()) return spotifyToken.value;
  if (spotifyTokenPromise) return spotifyTokenPromise;
  spotifyTokenPromise = (async () => {
    try {
      const credentials = Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString('base64');
      const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { authorization: `Basic ${credentials}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('Spotify did not return an access token.');
      spotifyToken = { value: data.access_token, expiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000 - 60_000 };
      return spotifyToken.value;
    } catch (error) {
      console.warn('[spotify] token request failed:', error.message);
      throw new Error('Spotify could not be reached or rejected the configured application credentials.');
    } finally {
      spotifyTokenPromise = null;
    }
  })();
  return spotifyTokenPromise;
}

async function spotifyRequest(path, retry = true) {
  const token = await getSpotifyToken();
  let response;
  try {
    response = await fetch(`https://api.spotify.com/v1${path}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000)
    });
  } catch (error) {
    console.warn('[spotify] playlist request failed:', error.message);
    throw new Error('Spotify could not be reached while loading that playlist.');
  }
  if (response.status === 401 && retry) {
    spotifyToken = null;
    return spotifyRequest(path, false);
  }
  if (!response.ok) {
    if (response.status === 403) throw new Error('Spotify did not allow access to that playlist. It may be private or unavailable to this application.');
    if (response.status === 404) throw new Error('That Spotify playlist could not be found.');
    console.warn(`[spotify] playlist request failed with HTTP ${response.status}`);
    throw new Error('Spotify could not load that playlist.');
  }
  return response.json();
}

function spotifyTrack(item) {
  const track = item?.item || item?.track;
  if (!track || track.type !== 'track' || track.is_local || !track.id || !track.name) return null;
  const artist = Array.isArray(track.artists) ? track.artists.map((value) => cleanMetadata(value?.name)).filter(Boolean).join(', ') : '';
  return {
    title: cleanMetadata(track.name, 'Untitled track'),
    artist,
    duration: Number(track.duration_ms || 0) / 1000,
    search: `${artist ? `${artist} - ` : ''}${cleanMetadata(track.name)}`.slice(0, 300)
  };
}

async function getSpotifyPlaylistTracks(query) {
  const playlistId = spotifyPlaylistId(query);
  if (!playlistId) throw new Error('Enter a valid Spotify playlist URL.');
  const tracks = [];
  let offset = 0;
  while (tracks.length < config.queueMaxTracks) {
    const limit = Math.min(50, config.queueMaxTracks - tracks.length);
    const fields = encodeURIComponent('items(item(type,id,name,artists(name),duration_ms,is_local)),next,total');
    const data = await spotifyRequest(`/playlists/${playlistId}/items?market=${encodeURIComponent(config.spotifyMarket)}&limit=${limit}&offset=${offset}&fields=${fields}`);
    const items = Array.isArray(data.items) ? data.items : [];
    tracks.push(...items.map(spotifyTrack).filter(Boolean));
    if (!data.next || !items.length) break;
    offset += items.length;
  }
  return tracks.slice(0, config.queueMaxTracks);
}

async function resolveSpotifyPlaylist(query) {
  const spotifyTracks = await getSpotifyPlaylistTracks(query);
  if (!spotifyTracks.length) throw new Error('That Spotify playlist is empty or contains no playable tracks.');
  const resolved = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < spotifyTracks.length) {
      const index = cursor++;
      const item = spotifyTracks[index];
      try {
        const track = await resolveTrack(item.search);
        // Keep Spotify's canonical metadata for the queue and lyrics lookup;
        // the matched provider URL remains the actual playback source.
        resolved[index] = {
          ...track,
          title: item.title,
          artist: item.artist || track.artist,
          duration: item.duration || track.duration
        };
      } catch (error) {
        console.warn(`[spotify] could not match "${item.search}": ${error.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.mediaMaxConcurrency, spotifyTracks.length) }, worker));
  const playable = resolved.filter(Boolean);
  if (!playable.length) throw new Error('Spotify tracks were found, but none could be matched to a playable source.');
  return playable;
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
  if (config.pipedApiUrls.length && !YOUTUBE_COOKIES_CONFIGURED) {
    const piped = uniqueTracks(await searchPiped(cleanQuery).catch(() => []));
    if (piped.length) return piped;
  }
  throw youtubeError || new Error('No YouTube results were found.');
}

// A Piped instance is a third party. Its stream URL is handed straight to
// FFmpeg, so anything other than a plain HTTPS URL - file://, an internal
// address, a shell-looking value - has to be rejected before it gets there.
function safeStreamUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  const isLoopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
  const isPrivate = /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  if (isLoopback || isPrivate) return null;
  return url.toString();
}

function addPrivateStreamUrl(track, streamUrl) {
  Object.defineProperty(track, 'streamUrl', { value: streamUrl, enumerable: false });
  return track;
}

async function resolvePipedTrack(url, fallbackTitle = 'YouTube track') {
  const id = youtubeId(url);
  if (!id) throw new Error('Piped could not identify that YouTube video.');
  const data = await pipedRequest(`/streams/${encodeURIComponent(id)}`, {}, (value) => (value.audioStreams || []).some((stream) => !stream.videoOnly && safeStreamUrl(stream.url)));
  const audio = (data.audioStreams || []).filter((stream) => !stream.videoOnly && safeStreamUrl(stream.url)).sort((left, right) => Number(right.bitrate || 0) - Number(left.bitrate || 0))[0];
  if (!audio) throw new Error('Piped did not return a playable audio stream.');
  const streamUrl = safeStreamUrl(audio.url);
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
  return addPrivateStreamUrl(track, streamUrl);
}

async function resolveWithYtDlp(target, fallback, source) {
  const output = await runYtDlp(['--dump-single-json', '--no-playlist', '--skip-download'], target);
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

async function resolvePlaylist(query) {
  // A public playlist can hold thousands of entries. Refuse to pull more than a
  // queue can hold so that one request cannot exhaust memory or the queue.
  const output = await runYtDlp(['--flat-playlist', '--playlist-end', String(config.queueMaxTracks), '--dump-single-json', '--no-warnings'], query);
  const data = parseJson(output, 'The playlist provider returned an invalid response.');
  const entries = (Array.isArray(data.entries) ? data.entries : []).slice(0, config.queueMaxTracks);
  const tracks = entries.map((entry) => isSoundCloudUrl(query) ? previewSoundCloud(entry) : previewYouTube(entry)).filter(Boolean);
  if (!tracks.length) throw new Error('That playlist is empty or contains no playable tracks.');
  return tracks;
}

async function resolveTrack(query) {
  const cleanQuery = validateSongQuery(query);
  if (isSoundCloudUrl(cleanQuery)) return resolveWithYtDlp(cleanQuery, cleanQuery, 'soundcloud');
  if (isYouTubeUrl(cleanQuery)) {
    try { return await resolveWithYtDlp(cleanQuery, cleanQuery, 'youtube'); }
    catch (error) {
      if (config.pipedApiUrls.length && !YOUTUBE_COOKIES_CONFIGURED) return resolvePipedTrack(cleanQuery, cleanQuery).catch(() => { throw error; });
      throw error;
    }
  }
  let youtubeError;
  try {
    // Resolve the first flat search result to its real source URL before it
    // enters the queue. Passing `ytsearch1:` directly to the single-item
    // resolver can make yt-dlp return the search expression as metadata rather
    // than the video that should actually be played.
    const results = await searchYouTube(cleanQuery);
    if (!results[0]) throw new Error('No YouTube results were found.');
    return await resolveWithYtDlp(results[0].url, results[0].title || cleanQuery, 'youtube');
  } catch (error) { youtubeError = error; }
  if (YOUTUBE_COOKIES_CONFIGURED) throw youtubeError;
  try {
    const results = await searchSoundCloud(cleanQuery);
    if (!results[0]) throw new Error('No SoundCloud results were found.');
    return await resolveWithYtDlp(results[0].url, results[0].title || cleanQuery, 'soundcloud');
  }
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

async function resolveTracks(query) {
  const cleanQuery = validateSongQuery(query);
  if (isSpotifyPlaylistUrl(cleanQuery)) return resolveSpotifyPlaylist(cleanQuery);
  if (isPlaylistUrl(cleanQuery)) return resolvePlaylist(cleanQuery);
  return [await resolveTrack(cleanQuery)];
}

function createAudioStream(track, options = {}) {
  if (track.source === 'library' && track.path) return createLibraryAudioStream(track.path, options);
  if (track.source === 'piped' && track.streamUrl) return createRemoteAudioStream(track.streamUrl, options);
  const ytdlp = spawn('yt-dlp', [...YTDLP_RUNTIME_ARGS, ...YTDLP_SAFETY_ARGS, ...YTDLP_EXTRACTOR_ARGS, ...YTDLP_AUTH_ARGS, '--no-playlist', '-f', 'bestaudio/best', '-o', '-', '--', track.url], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', ...FFMPEG_PIPE_PROTOCOLS, '-i', 'pipe:0',
    '-af', audioFilter(options),
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

function createRemoteAudioStream(streamUrl, options = {}) {
  const target = safeStreamUrl(streamUrl);
  if (!target) throw new Error('That stream URL is not allowed.');
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', ...FFMPEG_REMOTE_PROTOCOLS, '-i', target,
    '-vn', '-map', '0:a:0',
    '-af', audioFilter(options),
    '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stream = ffmpeg.stdout;
  ffmpeg.stderr.on('data', (chunk) => console.warn('[ffmpeg]', chunk.toString().trim()));
  stream.ffmpeg = ffmpeg;
  stream.destroyChildren = () => { if (!ffmpeg.killed) ffmpeg.kill('SIGKILL'); };
  ffmpeg.on('error', (error) => stream.destroy(error));
  return stream;
}

function createLibraryAudioStream(filePath, options = {}) {
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', ...FFMPEG_LOCAL_PROTOCOLS, '-i', filePath,
    '-vn', '-map', '0:a:0',
    '-af', audioFilter(options),
    '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stream = ffmpeg.stdout;
  ffmpeg.stderr.on('data', (chunk) => console.warn('[ffmpeg]', chunk.toString().trim()));
  stream.ffmpeg = ffmpeg;
  stream.destroyChildren = () => { if (!ffmpeg.killed) ffmpeg.kill('SIGKILL'); };
  ffmpeg.on('error', (error) => stream.destroy(error));
  return stream;
}

module.exports = { createAudioStream, isPlaylistUrl, resolveTrack, resolveTracks, searchTracks, spotifyPlaylistId };
