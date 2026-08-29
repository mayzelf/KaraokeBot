const { spawn } = require('node:child_process');

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `yt-dlp exited with ${code}`)));
  });
}

async function resolveTrack(query) {
  const target = /^https?:\/\//i.test(query) ? query : `ytsearch1:${query}`;
  const output = await runYtDlp(['--dump-single-json', '--no-playlist', '--skip-download', target]);
  const data = JSON.parse(output);
  if (!data.webpage_url && !data.url) throw new Error('No playable result was found.');
  return {
    id: data.id,
    url: data.webpage_url || data.original_url || query,
    title: data.title || query,
    artist: data.artist || data.uploader || '',
    duration: Number(data.duration || 0),
    thumbnail: data.thumbnail || null
  };
}

function createAudioStream(track) {
  const ytdlp = spawn('yt-dlp', ['--no-playlist', '-f', 'bestaudio/best', '-o', '-', track.url], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    // Normalize different source videos to a consistent perceived loudness
    // before Discord receives the raw PCM stream. The dashboard volume is
    // applied afterward as the final user-controlled gain.
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:dual_mono=true',
    '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  ytdlp.stdout.pipe(ffmpeg.stdin);
  ytdlp.stderr.on('data', (chunk) => console.warn('[yt-dlp]', chunk.toString().trim()));
  ffmpeg.stderr.on('data', (chunk) => console.warn('[ffmpeg]', chunk.toString().trim()));
  const stream = ffmpeg.stdout;
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

module.exports = { resolveTrack, createAudioStream };
