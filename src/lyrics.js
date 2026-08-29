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

function cleanSearchText(value) {
  return String(value || '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b(?:karaoke|instrumental|no guide melody|guide melody|backing track|minus one|with lyrics|lyrics video|official video|audio)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchTokens(value) {
  return new Set(cleanSearchText(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/).filter((word) => word && !['a', 'an', 'and', 'audio', 'feat', 'featuring', 'ft', 'the', 'video'].includes(word)));
}

function tokenSimilarity(left, right) {
  const a = matchTokens(left);
  const b = matchTokens(right);
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter((token) => b.has(token)).length;
  return overlap / Math.min(a.size, b.size);
}

function lyricTarget(input) {
  if (typeof input === 'string') return { artist: '', title: cleanSearchText(input) };
  const cleanTitle = cleanSearchText(input.title);
  const titleParts = cleanTitle.split(/\s+[-–—]\s+/);
  return {
    artist: [cleanSearchText(input.artist), titleParts.length > 1 ? titleParts[0] : ''].filter(Boolean).join(' '),
    title: titleParts.pop().trim()
  };
}

function lyricQueries(input) {
  if (!input) return [];
  if (typeof input === 'string') {
    const cleaned = cleanSearchText(input);
    const core = cleaned.split(/\s+[-–—]\s+/).pop().trim();
    return [...new Set([input, cleaned, core].filter(Boolean))].slice(0, 4);
  }
  const artist = cleanSearchText(input.artist);
  const title = cleanSearchText(input.title);
  const coreTitle = title.split(/\s+[-–—]\s+/).pop().trim();
  return [...new Set([
    `${artist} ${coreTitle}`,
    `${artist} ${title}`,
    coreTitle,
    title
  ].map((query) => query.trim()).filter(Boolean))].slice(0, 4);
}

async function searchLyrics(query, target) {
  try {
    const response = await fetch(`${LRCLIB}?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(7000) });
    if (!response.ok) return null;
    const results = await response.json();
    const candidates = results.filter((item) => (item.syncedLyrics && parseLrc(item.syncedLyrics).length) || item.plainLyrics?.trim());
    const match = candidates.map((item) => ({ item, titleScore: tokenSimilarity(target.title, item.trackName), artistScore: tokenSimilarity(target.artist, item.artistName) }))
      .filter(({ titleScore, artistScore }) => titleScore >= 0.5 && (!matchTokens(target.artist).size || artistScore > 0))
      .sort((left, right) => (right.titleScore * 10 + right.artistScore * 8) - (left.titleScore * 10 + left.artistScore * 8))[0];
    if (!match) return null;
    const score = match.titleScore * 10 + match.artistScore * 8;
    if (match.item.syncedLyrics && parseLrc(match.item.syncedLyrics).length) {
      return {
        source: 'LRCLIB',
        mode: 'synced',
        track: [match.item.artistName, match.item.trackName].filter(Boolean).join(' — ') || query,
        lines: parseLrc(match.item.syncedLyrics),
        text: match.item.plainLyrics?.trim() || null,
        score
      };
    }
    return {
      source: 'LRCLIB',
      mode: 'plain',
      track: [match.item.artistName, match.item.trackName].filter(Boolean).join(' — ') || query,
      lines: [],
      text: match.item.plainLyrics.trim(),
      score
    };
  } catch (error) {
    console.warn('[lyrics] lookup failed:', error.message);
    return null;
  }
}

async function findLyrics(input) {
  const target = lyricTarget(input);
  const matches = [];
  for (const query of lyricQueries(input)) {
    const lyrics = await searchLyrics(query, target);
    if (lyrics) matches.push(lyrics);
  }
  if (!matches.length) return null;
  return matches.sort((left, right) => right.score - left.score)[0];
}

function currentLine(lines, elapsed) {
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].time <= elapsed) index = i;
    else break;
  }
  return index;
}

module.exports = { findLyrics, lyricQueries, parseLrc, currentLine };
