const { spawn } = require('node:child_process');

// Child processes are the most expensive thing an authenticated request can
// start, and both yt-dlp and ffmpeg can hang on an unresponsive remote host.
// Every helper run goes through here so that a run is always bounded in time,
// in output size, and in how many can be in flight at once.
function createLimiter(maxConcurrent) {
  let active = 0;
  const waiting = [];
  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) { active += 1; next(); }
  };
  return async function limit(task) {
    if (active >= maxConcurrent) await new Promise((resolve) => waiting.push(resolve));
    else active += 1;
    try { return await task(); }
    finally { release(); }
  };
}

function runCommand(command, args, { timeoutMs = 45_000, maxOutputBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill('SIGKILL');
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`${command} timed out.`)), timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > maxOutputBytes) finish(new Error(`${command} produced too much output.`));
    });
    child.stderr.on('data', (chunk) => {
      // Keep only the tail: stderr is unbounded and is never returned verbatim.
      stderr = (stderr + chunk).slice(-8192);
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => code === 0 ? finish(null, { stdout, stderr }) : finish(Object.assign(new Error(`${command} exited with code ${code}.`), { stderr, code })));
  });
}

module.exports = { createLimiter, runCommand };
