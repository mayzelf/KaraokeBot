const LRCLIB = 'https://lrclib.net/api/search';

function parseLrc(input) {
  if (!input) return [];
  const lines = [];
  for (const raw of input.split(/\r?\n/)) {
    const matches = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    const text = raw.replace(/\[[^\]]+\]/g, '').trim();
    if (!text) continue;
    for (const match of matches) {
      const fraction = (match[3] || '').padEnd(3, '0');
      lines.push({ time: Number(match[1]) * 60 + Number(match[2]) + Number(fraction) / 1000, text });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

async function findLyrics(title) {
  if (!title) return null;
  try {
    const response = await fetch(`${LRCLIB}?q=${encodeURIComponent(title)}`, { signal: AbortSignal.timeout(7000) });
    if (!response.ok) return null;
    const results = await response.json();
    const match = results.find((item) => item.syncedLyrics && parseLrc(item.syncedLyrics).length);
    if (match) {
      return {
        source: 'LRCLIB',
        mode: 'synced',
        track: [match.artistName, match.trackName].filter(Boolean).join(' — ') || title,
        lines: parseLrc(match.syncedLyrics),
        text: match.plainLyrics?.trim() || null
      };
    }
    const plainMatch = results.find((item) => item.plainLyrics?.trim());
    if (!plainMatch) return null;
    return {
      source: 'LRCLIB',
      mode: 'plain',
      track: [plainMatch.artistName, plainMatch.trackName].filter(Boolean).join(' — ') || title,
      lines: [],
      text: plainMatch.plainLyrics.trim()
    };
  } catch (error) {
    console.warn('[lyrics] lookup failed:', error.message);
    return null;
  }
}

function currentLine(lines, elapsed) {
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].time <= elapsed) index = i;
    else break;
  }
  return index;
}

module.exports = { findLyrics, parseLrc, currentLine };
