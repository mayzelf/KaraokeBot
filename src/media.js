const { spawn } = require('node:child_process');
const { safeYouTubeThumbnail, validateSongQuery } = require('./validation');
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

function previewTrack(data) {
  if (!data?.id || !/^[\w-]{5,20}$/.test(String(data.id))) return null;
  const url = validateSongQuery(`https://www.youtube.com/watch?v=${encodeURIComponent(data.id)}`);
  return {
    id: String(data.id),
    url,
    title: cleanMetadata(data.title, 'Untitled track'),
    artist: cleanMetadata(data.artist || data.channel || data.uploader, '', 120),
    duration: Number(data.duration || 0),
    thumbnail: safeYouTubeThumbnail(data.thumbnail)
  };
}

async function searchTracks(query) {
  const cleanQuery = validateSongQuery(query);
  if (/^https?:\/\//i.test(cleanQuery)) return [];
  const output = await runYtDlp(['--flat-playlist', '--playlist-end', '5', '--dump-single-json', '--no-warnings', `ytsearch5:${cleanQuery}`]);
  const data = JSON.parse(output);
  return (Array.isArray(data.entries) ? data.entries : []).map(previewTrack).filter(Boolean);
}

async function resolveTrack(query) {
  const cleanQuery = validateSongQuery(query);
  const target = /^https?:\/\//i.test(cleanQuery) ? cleanQuery : `ytsearch1:${cleanQuery}`;
  const output = await runYtDlp(['--dump-single-json', '--no-playlist', '--skip-download', target]);
  const data = JSON.parse(output);
  if (!data.webpage_url || !data.id) throw new Error('No playable YouTube result was found.');
  const playableUrl = validateSongQuery(data.webpage_url);
  return {
    id: data.id,
    url: playableUrl,
    title: cleanMetadata(data.title, cleanQuery),
    artist: cleanMetadata(data.artist || data.uploader, '', 120),
    duration: Number(data.duration || 0),
    thumbnail: safeYouTubeThumbnail(data.thumbnail)
  };
}

function createAudioStream(track) {
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

module.exports = { createAudioStream, resolveTrack, searchTracks };
