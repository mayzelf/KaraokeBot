const $ = (selector) => document.querySelector(selector);
const state = { guilds: [], selected: null, selectedTrack: null, searchProvider: 'youtube', timer: null, searchTimer: null, searchRequest: 0, viewRequest: 0, refreshRequest: 0 };
const themeKey = 'karaoke-theme';

function readTheme() {
  try { return localStorage.getItem(themeKey) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}
function applyTheme(theme) {
  const isDark = theme === 'dark';
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  const toggle = $('#theme-toggle');
  if (toggle) {
    toggle.setAttribute('aria-label', `Switch to ${isDark ? 'light' : 'dark'} mode`);
    toggle.title = `Switch to ${isDark ? 'light' : 'dark'} mode`;
    toggle.querySelector('.theme-icon').textContent = isDark ? '☀' : '☾';
    toggle.querySelector('.theme-label').textContent = isDark ? 'Light mode' : 'Dark mode';
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = isDark ? '#16131d' : '#17131f';
  try { localStorage.setItem(themeKey, isDark ? 'dark' : 'light'); } catch {}
}
applyTheme(readTheme());

const api = async (url, options) => {
  const method = (options?.method || 'GET').toUpperCase();
  const attempts = method === 'GET' ? 3 : 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const request = { ...options };
      request.headers = { ...(options?.body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...(options?.headers || {}) };
      const response = await fetch(url, request);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Request failed');
      return data;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts && error.name === 'TypeError') await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      else throw error;
    }
  }
  throw lastError;
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
}

function safeInviteUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'discord.com' && url.pathname === '/oauth2/authorize' ? url.toString() : null;
  } catch { return null; }
}

async function init() {
  $('#theme-toggle').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  const me = await api('/api/me');
  if (!me.user) return;
  $('#logged-out').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#account').innerHTML = `<span class="account">${escapeHtml(me.user.global_name || me.user.username)} <a href="/auth/logout">Log out</a></span>`;
  state.guilds = await api('/api/guilds');
  renderGuilds();
}

function renderGuilds() {
  const container = $('#guilds');
  container.innerHTML = '';
  if (!state.guilds.length) {
    container.innerHTML = '<div class="panel empty-state"><strong>No stages yet</strong><p>No servers are available with Manage Server permission.</p></div>';
    return;
  }
  for (const guild of state.guilds) {
    const node = $('#guild-template').content.cloneNode(true);
    node.querySelector('.guild-name').textContent = guild.name;
    const icon = node.querySelector('.guild-icon');
    const image = node.querySelector('.guild-image');
    if (guild.iconUrl) {
      icon.classList.add('has-image');
      image.onerror = () => {
        icon.classList.remove('has-image');
        image.removeAttribute('src');
        image.alt = '';
      };
      image.src = guild.iconUrl;
      image.alt = `${guild.name} icon`;
    }
    node.querySelector('.guild-status').textContent = `${guild.accessLabel} · ${guild.botPresent ? 'Bot online' : 'Bot not installed'}`;
    node.querySelector('.guild-card').onclick = () => selectGuild(guild);
    container.appendChild(node);
  }
}

async function selectGuild(guild) {
  state.selected = guild;
  const viewRequest = ++state.viewRequest;
  $('#guilds').classList.add('hidden');
  const workspace = $('#workspace');
  workspace.classList.remove('hidden');
  workspace.innerHTML = `<div class="workspace-top"><div class="workspace-nav"><button class="back" id="back">← All stages</button><span class="workspace-divider">/</span><strong class="workspace-server" id="workspace-server-name"></strong></div><span class="status-pill" id="status">Loading…</span></div>
    <div class="workspace-grid">
      <div class="panel"><div class="panel-head"><div><div class="panel-kicker">QUEUE TRACKS</div><h3>Play a song or playlist</h3></div><span class="panel-symbol">⌁</span></div>
        <div class="provider-tabs" role="tablist" aria-label="Search provider"><button class="provider-tab active" id="provider-youtube" type="button" role="tab" aria-selected="true">YouTube</button><button class="provider-tab" id="provider-soundcloud" type="button" role="tab" aria-selected="false">SoundCloud</button></div><div class="search-row"><input class="input" id="song" maxlength="300" autocomplete="off" placeholder="Search YouTube or paste a video or playlist URL"><button class="control control-accent" id="play">Play track <span>↗</span></button></div><div id="search-results" class="search-results hidden"></div>
        <p class="help">The bot joins your current voice channel and posts live lyrics in its built-in chat.</p><div id="notice" class="notice"></div>
        <div class="queue-heading"><div><span>UP NEXT</span><span id="queue-count">0 tracks</span></div><button class="queue-clear" id="clear-queue" type="button">Clear queue</button></div><div id="song-queue" class="song-queue"></div>
      </div>
      <div class="panel"><div class="panel-head"><div><div class="panel-kicker">ROOM CONTROLS</div><h3>Playback</h3></div><span class="panel-symbol">♪</span></div>
        <div class="voice-select"><label for="voice-channel">Voice channel</label><select class="input" id="voice-channel"><option value="">Use my current channel</option></select></div>
        <div class="playback-actions"><button class="control alt" id="join">Join</button><button class="control alt" id="resume">Resume</button><button class="control alt" id="pause">Pause</button><button class="control alt" id="skip">Skip</button><button class="control alt" id="stop">Stop</button></div>
        <div id="now" class="queue"></div>
      </div>
    </div>
    <div class="panel library-panel"><div class="panel-head"><div><div class="panel-kicker">YOUR STAGE LIBRARY</div><h3>Upload a song</h3></div><span class="panel-symbol">♫</span></div>
      <p class="settings-intro library-intro">Add audio you are allowed to use when YouTube is unavailable. Uploads are converted to compact audio and shared with this server.</p>
      <form id="library-upload" class="library-upload"><div class="library-upload-fields"><div><label for="library-file">Audio file</label><input class="input" id="library-file" type="file" accept="audio/*,.mp3,.m4a,.ogg,.opus,.wav,.flac,.aac,.webm" required></div><div><label for="library-title">Title <span class="optional">optional</span></label><input class="input" id="library-title" maxlength="200" placeholder="Use the file metadata or name"></div><div><label for="library-artist">Artist <span class="optional">optional</span></label><input class="input" id="library-artist" maxlength="120" placeholder="Artist or performer"></div></div><div class="library-upload-actions"><button class="control control-accent" id="library-upload-button" type="submit">Upload audio <span>↗</span></button><span id="library-notice" class="notice"></span></div><p class="field-note">Audio only · maximum 5 minutes · maximum 50 MB before conversion. Please upload only material you have permission to use.</p></form>
      <div class="queue-heading library-heading"><div><span>AVAILABLE SONGS</span><span id="library-count">0 tracks</span></div></div><div id="library-list" class="library-list"></div>
    </div>
    <div class="panel settings-panel"><div class="panel-head"><div><div class="panel-kicker">SERVER PREFERENCES</div><h3>Make it yours</h3></div><span class="panel-symbol">✦</span></div>
      <p class="settings-intro">Limit who can use karaoke and where commands can be sent. Leave a field blank to keep it open.</p>
      <div class="settings-grid"><div><label for="voice-entry">Allowed voice channel IDs</label><div class="tag-input" id="voice-tags"><div class="tag-list" id="voice-tag-list"></div><input class="tag-entry" id="voice-entry" placeholder="Type an ID, then press comma or Enter"></div><p class="field-note">Press comma or Enter after each ID. Copy IDs with Discord Developer Mode.</p></div><div><label for="text-entry">Allowed command text channel IDs</label><div class="tag-input" id="text-tags"><div class="tag-list" id="text-tag-list"></div><input class="tag-entry" id="text-entry" placeholder="Type an ID, then press comma or Enter"></div></div><div><label for="roles-entry">Allowed role IDs</label><div class="tag-input" id="roles-tags"><div class="tag-list" id="roles-tag-list"></div><input class="tag-entry" id="roles-entry" placeholder="Type an ID, then press comma or Enter"></div></div><div><label for="volume">Default volume</label><div class="range-row"><input class="input" id="volume" type="range" min="0" max="1" step="0.05"><span class="range-value" id="volume-value">80%</span></div></div></div>
      <div class="save-row"><button class="control control-accent save" id="save">Save settings</button><div id="settings-notice" class="notice"></div></div>
    </div>`;
  $('#workspace-server-name').textContent = guild.name;
  const libraryUploadEnabled = guild.libraryUploadsEnabled === true;
  const libraryUploadForm = $('#library-upload');
  libraryUploadForm.querySelectorAll('input, button').forEach((control) => { control.disabled = !libraryUploadEnabled; });
  if (!libraryUploadEnabled) $('#library-notice').textContent = 'Song uploads are disabled. Set LIBRARY_UPLOADS_ENABLED=true to enable them.';
  $('#back').onclick = () => { state.viewRequest += 1; workspace.classList.add('hidden'); $('#guilds').classList.remove('hidden'); clearInterval(state.timer); clearTimeout(state.searchTimer); state.selectedTrack = null; };
  const settings = await api(`/api/guilds/${encodeURIComponent(guild.id)}/settings`);
  fillSettings(settings);
  await loadChannels(guild);
  bindControls(guild);
  await loadLibrary(guild);
  refresh(guild, viewRequest);
  state.timer = setInterval(() => refresh(guild, viewRequest), 3000);
}

async function loadChannels(guild) {
  try {
    const channels = await api(`/api/guilds/${encodeURIComponent(guild.id)}/channels`);
    const select = $('#voice-channel');
    select.replaceChildren(new Option('Use my current channel', ''));
    channels.filter((channel) => channel.type === 'voice').forEach((channel) => select.add(new Option(channel.name, channel.id)));
  } catch {}
}

const tagState = { voice: [], text: [], roles: [] };
const tagIds = { voice: 'voice', text: 'text', roles: 'roles' };
const validDiscordId = (value) => /^\d{15,25}$/.test(value);
function renderTags(type) {
  const list = $(`#${tagIds[type]}-tag-list`);
  list.innerHTML = tagState[type].map((id) => `<span class="id-tag">${escapeHtml(id)}<button type="button" data-remove-tag="${escapeHtml(id)}" aria-label="Remove ${escapeHtml(id)}">×</button></span>`).join('');
  list.querySelectorAll('[data-remove-tag]').forEach((button) => { button.onclick = () => { tagState[type] = tagState[type].filter((id) => id !== button.dataset.removeTag); renderTags(type); }; });
}
function addTags(type, value) {
  const incoming = String(value || '').split(/[,\n]/).map((id) => id.trim()).filter(validDiscordId);
  tagState[type] = [...new Set([...tagState[type], ...incoming])];
  renderTags(type);
}
function bindTagInput(type) {
  const input = $(`#${tagIds[type]}-entry`);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addTags(type, input.value);
      input.value = '';
    } else if (event.key === 'Backspace' && !input.value && tagState[type].length) {
      tagState[type].pop();
      renderTags(type);
    }
  });
  input.addEventListener('blur', () => { if (input.value.trim()) { addTags(type, input.value); input.value = ''; } });
}
function fillSettings(settings) { tagState.voice = [...settings.allowedVoiceChannels]; tagState.text = [...settings.allowedTextChannels]; tagState.roles = [...settings.allowedRoles]; renderTags('voice'); renderTags('text'); renderTags('roles'); $('#volume').value = settings.default_volume; $('#volume-value').textContent = `${Math.round(Number(settings.default_volume) * 100)}%`; }

function formatDuration(seconds) {
  const total = Number(seconds || 0);
  if (!Number.isFinite(total) || total <= 0) return '';
  return `${Math.floor(total / 60)}:${String(Math.floor(total % 60)).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function renderLibrary(tracks, guild) {
  const container = $('#library-list');
  const count = $('#library-count');
  const songs = Array.isArray(tracks) ? tracks : [];
  count.textContent = `${songs.length} ${songs.length === 1 ? 'track' : 'tracks'}`;
  container.replaceChildren();
  if (!songs.length) {
    const empty = document.createElement('div');
    empty.className = 'queue-empty';
    empty.textContent = 'No uploaded songs yet. Add audio here when a YouTube source is not reliable.';
    container.append(empty);
    return;
  }
  songs.forEach((track) => {
    const card = document.createElement('div');
    card.className = 'library-card';
    const copy = document.createElement('div');
    copy.className = 'queue-copy';
    const title = document.createElement('strong');
    title.textContent = track.title || 'Untitled track';
    const meta = document.createElement('small');
    meta.textContent = [track.artist, formatDuration(track.duration), formatBytes(track.sizeBytes)].filter(Boolean).join(' · ');
    copy.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'library-actions';
    const play = document.createElement('button');
    play.type = 'button'; play.className = 'control control-accent library-play'; play.textContent = 'Play';
    play.onclick = async () => {
      play.disabled = true;
      try { await api(`/api/guilds/${encodeURIComponent(guild.id)}/play`, { method: 'POST', body: JSON.stringify({ libraryId: track.id }) }); await refresh(guild); }
      catch (error) { $('#notice').textContent = error.message; }
      finally { play.disabled = false; }
    };
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'queue-remove'; remove.textContent = '×'; remove.title = 'Remove from library';
    remove.onclick = async () => {
      if (!window.confirm(`Remove “${track.title || 'this track'}” from the server library?`)) return;
      remove.disabled = true;
      try { await api(`/api/guilds/${encodeURIComponent(guild.id)}/library/${encodeURIComponent(track.id)}`, { method: 'DELETE' }); await loadLibrary(guild); }
      catch (error) { $('#library-notice').textContent = error.message; remove.disabled = false; }
    };
    actions.append(play, remove);
    card.append(copy, actions);
    container.append(card);
  });
}

async function loadLibrary(guild) {
  try { const data = await api(`/api/guilds/${encodeURIComponent(guild.id)}/library`); renderLibrary(data.tracks, guild); }
  catch (error) { const notice = $('#library-notice'); if (notice) notice.textContent = error.message; }
}

function bindLibrary(guild) {
  $('#library-upload').onsubmit = async (event) => {
    event.preventDefault();
    if (guild.libraryUploadsEnabled !== true) return;
    const file = $('#library-file').files[0];
    if (!file) return;
    const button = $('#library-upload-button');
    const notice = $('#library-notice');
    const form = new FormData();
    form.append('file', file);
    form.append('title', $('#library-title').value);
    form.append('artist', $('#library-artist').value);
    button.disabled = true;
    notice.textContent = 'Uploading and converting…';
    try { await api(`/api/guilds/${encodeURIComponent(guild.id)}/library`, { method: 'POST', body: form }); event.target.reset(); notice.textContent = 'Added to the library.'; await loadLibrary(guild); }
    catch (error) { notice.textContent = error.message; }
    finally { button.disabled = false; }
  };
}

function renderNowPlaying(current, paused, elapsed = 0) {
  const now = $('#now');
  now.replaceChildren();
  now.classList.remove('now-empty');
  if (!current) return;

  const title = current.title || 'Untitled track';
  const rawDuration = Number(current.duration || 0);
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
  const rawCurrentTime = Number(elapsed || 0);
  const currentTime = Number.isFinite(rawCurrentTime) && rawCurrentTime > 0 ? rawCurrentTime : 0;
  const progress = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  const card = document.createElement('article');
  card.className = `now-playing-card${paused ? ' is-paused' : ''}`;

  const artwork = document.createElement('div');
  artwork.className = 'now-playing-artwork';
  const fallback = document.createElement('span');
  fallback.className = 'now-playing-artwork-fallback';
  fallback.setAttribute('aria-hidden', 'true');
  fallback.textContent = '♪';
  artwork.append(fallback);
  if (current.thumbnail) {
    const image = document.createElement('img');
    image.src = current.thumbnail;
    image.alt = `Cover art for ${title}`;
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.onerror = () => image.remove();
    artwork.append(image);
  }

  const copy = document.createElement('div');
  copy.className = 'now-playing-copy';
  const eyebrow = document.createElement('div');
  eyebrow.className = 'now-playing-eyebrow';
  const label = document.createElement('span');
  label.textContent = paused ? 'Paused' : 'Now playing';
  const live = document.createElement('span');
  live.className = 'now-playing-state';
  live.textContent = paused ? 'ON HOLD' : 'LIVE';
  eyebrow.append(label, live);

  const heading = document.createElement('h4');
  heading.textContent = title;
  const artist = document.createElement('p');
  artist.className = 'now-playing-artist';
  artist.textContent = current.artist || 'Unknown artist';
  copy.append(eyebrow, heading, artist);

  const progressTrack = document.createElement('div');
  progressTrack.className = 'now-playing-progress';
  progressTrack.setAttribute('role', 'progressbar');
  progressTrack.setAttribute('aria-label', `Playback progress for ${title}`);
  progressTrack.setAttribute('aria-valuemin', '0');
  progressTrack.setAttribute('aria-valuemax', String(duration || 0));
  progressTrack.setAttribute('aria-valuenow', String(Math.max(0, currentTime)));
  const progressBar = document.createElement('span');
  progressBar.style.width = `${progress}%`;
  progressTrack.append(progressBar);

  const time = document.createElement('div');
  time.className = 'now-playing-time';
  const elapsedLabel = document.createElement('span');
  elapsedLabel.textContent = formatDuration(currentTime) || '0:00';
  const durationLabel = document.createElement('span');
  durationLabel.textContent = formatDuration(duration) || '--:--';
  time.append(elapsedLabel, durationLabel);

  const details = document.createElement('div');
  details.className = 'now-playing-details';
  details.append(progressTrack, time);
  copy.append(details);
  card.append(artwork, copy);
  now.append(card);
}

function renderPlaybackEnded(lastCompleted) {
  const now = $('#now');
  now.replaceChildren();
  now.classList.remove('now-empty');

  const card = document.createElement('article');
  card.className = 'now-playing-card is-ended';
  const artwork = document.createElement('div');
  artwork.className = 'now-playing-artwork';
  const fallback = document.createElement('span');
  fallback.className = 'now-playing-artwork-fallback';
  fallback.setAttribute('aria-hidden', 'true');
  fallback.textContent = '✓';
  artwork.append(fallback);
  if (lastCompleted?.thumbnail) {
    const image = document.createElement('img');
    image.src = lastCompleted.thumbnail;
    image.alt = `Cover art for ${lastCompleted.title || 'the finished song'}`;
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.onerror = () => image.remove();
    artwork.append(image);
  }

  const copy = document.createElement('div');
  copy.className = 'now-playing-copy';
  const eyebrow = document.createElement('div');
  eyebrow.className = 'now-playing-eyebrow';
  const label = document.createElement('span');
  label.textContent = 'Playback complete';
  const stateLabel = document.createElement('span');
  stateLabel.className = 'now-playing-state';
  stateLabel.textContent = 'ENDED';
  eyebrow.append(label, stateLabel);
  const heading = document.createElement('h4');
  heading.textContent = 'Song ended';
  const detail = document.createElement('p');
  detail.className = 'now-playing-artist';
  detail.textContent = lastCompleted?.title
    ? `Last played: ${lastCompleted.title}${lastCompleted.artist ? ` · ${lastCompleted.artist}` : ''}`
    : 'Ready for another performance';
  const next = document.createElement('p');
  next.className = 'now-ended-detail';
  next.textContent = 'Add another track above to keep the room going.';
  copy.append(eyebrow, heading, detail, next);
  card.append(artwork, copy);
  now.append(card);
}

function renderQueue(queue, guild) {
  const container = $('#song-queue');
  const count = $('#queue-count');
  const tracks = Array.isArray(queue) ? queue : [];
  count.textContent = `${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}`;
  $('#clear-queue').disabled = !tracks.length;
  container.replaceChildren();
  if (!tracks.length) {
    const empty = document.createElement('div');
    empty.className = 'queue-empty';
    empty.textContent = 'No songs waiting yet. Add one above to build the room.';
    container.append(empty);
    return;
  }
  tracks.forEach((track, index) => {
    const card = document.createElement('div');
    card.className = 'queue-card';
    const number = document.createElement('span');
    number.className = 'queue-number';
    number.textContent = String(index + 1).padStart(2, '0');
    const copy = document.createElement('div');
    copy.className = 'queue-copy';
    const title = document.createElement('strong');
    title.textContent = track.title || 'Untitled track';
    const meta = document.createElement('small');
    meta.textContent = [track.artist, formatDuration(track.duration)].filter(Boolean).join(' · ') || 'Queued';
    copy.append(title, meta);
    const remove = document.createElement('button');
    remove.className = 'queue-remove';
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${track.title || 'track'} from queue`);
    remove.textContent = '×';
    remove.onclick = async () => {
      remove.disabled = true;
      try {
        await api(`/api/guilds/${encodeURIComponent(guild.id)}/queue/remove`, { method: 'POST', body: JSON.stringify({ index }) });
        await refresh(guild);
      } catch (error) { $('#notice').textContent = error.message; remove.disabled = false; }
    };
    const order = document.createElement('div');
    order.className = 'queue-order';
    const move = async (to) => {
      order.querySelectorAll('button').forEach((button) => { button.disabled = true; });
      try {
        await api(`/api/guilds/${encodeURIComponent(guild.id)}/queue/move`, { method: 'POST', body: JSON.stringify({ from: index, to }) });
        await refresh(guild);
      } catch (error) { $('#notice').textContent = error.message; order.querySelectorAll('button').forEach((button) => { button.disabled = false; }); }
    };
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'queue-move';
    up.textContent = '↑';
    up.title = 'Move up';
    up.setAttribute('aria-label', `Move ${track.title || 'track'} up`);
    up.disabled = index === 0;
    up.onclick = () => move(index - 1);
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'queue-move';
    down.textContent = '↓';
    down.title = 'Move down';
    down.setAttribute('aria-label', `Move ${track.title || 'track'} down`);
    down.disabled = index === tracks.length - 1;
    down.onclick = () => move(index + 1);
    order.append(up, down);
    card.append(number, copy, order, remove);
    container.append(card);
  });
}

function renderSearchResults(results) {
  const container = $('#search-results');
  container.replaceChildren();
  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = `No ${state.searchProvider === 'soundcloud' ? 'SoundCloud' : 'YouTube'} results. Try the other tab.`;
    container.append(empty);
    container.classList.remove('hidden');
    return;
  }
  results.forEach((track) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'search-result';
    const copy = document.createElement('span');
    copy.className = 'search-result-copy';
    const title = document.createElement('strong');
    title.textContent = track.title || 'Untitled track';
    const meta = document.createElement('small');
    meta.textContent = [track.provider || 'YouTube', track.artist, formatDuration(track.duration)].filter(Boolean).join(' · ');
    copy.append(title, meta);
    const arrow = document.createElement('span');
    arrow.className = 'search-result-arrow';
    arrow.textContent = '↗';
    option.append(copy, arrow);
    option.onclick = () => {
      state.selectedTrack = track;
      $('#song').value = track.title;
      container.classList.add('hidden');
      updatePlayButton();
    };
    container.append(option);
  });
  container.classList.remove('hidden');
}
function updateSearchProvider() {
  const isSoundCloud = state.searchProvider === 'soundcloud';
  document.querySelectorAll('.provider-tab').forEach((button) => {
    const active = button.id === `provider-${state.searchProvider}`;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $('#song').placeholder = isSoundCloud ? 'Search SoundCloud or paste a track or playlist URL' : 'Search YouTube or paste a video or playlist URL';
}
function updatePlayButton() {
  const value = $('#song').value.trim();
  $('#play').disabled = !state.selectedTrack && !/^https?:\/\//i.test(value);
}
function bindSearch() {
  const input = $('#song');
  const scheduleSearch = () => {
    clearTimeout(state.searchTimer);
    const request = ++state.searchRequest;
    const query = input.value.trim();
    const provider = state.searchProvider;
    if (query.length < 2 || /^https?:\/\//i.test(query)) { $('#search-results').classList.add('hidden'); return; }
    state.searchTimer = setTimeout(async () => {
      try {
        const data = await api(`/api/search?q=${encodeURIComponent(query)}&provider=${encodeURIComponent(provider)}`);
        if (request === state.searchRequest && input.value.trim() === query && state.searchProvider === provider) renderSearchResults(data.results || []);
      } catch (error) {
        if (request === state.searchRequest) { $('#search-results').classList.add('hidden'); $('#notice').textContent = error.message; }
      }
    }, 350);
  };
  input.addEventListener('input', () => {
    state.selectedTrack = null;
    $('#notice').textContent = '';
    updatePlayButton();
    scheduleSearch();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && state.selectedTrack) { event.preventDefault(); $('#play').click(); }
  });
  $('#provider-youtube').onclick = () => { state.searchProvider = 'youtube'; state.selectedTrack = null; updateSearchProvider(); updatePlayButton(); scheduleSearch(); };
  $('#provider-soundcloud').onclick = () => { state.searchProvider = 'soundcloud'; state.selectedTrack = null; updateSearchProvider(); updatePlayButton(); scheduleSearch(); };
  updateSearchProvider();
  updatePlayButton();
}

function bindControls(guild) {
  const guildPath = (name) => `/api/guilds/${encodeURIComponent(guild.id)}/${name}`;
  const action = async (name, body = {}) => { try { await api(guildPath(name), { method: 'POST', body: JSON.stringify(body) }); refresh(guild, state.viewRequest); } catch (error) { $('#notice').textContent = error.message; } };
  $('#play').onclick = () => { const query = state.selectedTrack?.url || $('#song').value.trim(); if (query) action('play', { song: query }); };
  $('#join').onclick = () => action('join', { channelId: $('#voice-channel').value || null });
  $('#resume').onclick = () => action('resume'); $('#pause').onclick = () => action('pause'); $('#skip').onclick = () => action('skip'); $('#stop').onclick = () => action('stop');
  $('#clear-queue').onclick = () => action('queue/clear');
  bindSearch();
  bindLibrary(guild);
  $('#volume').oninput = () => { $('#volume-value').textContent = `${Math.round(Number($('#volume').value) * 100)}%`; };
  bindTagInput('voice'); bindTagInput('text'); bindTagInput('roles');
  $('#save').onclick = async () => { try { ['voice', 'text', 'roles'].forEach((type) => { const input = $(`#${tagIds[type]}-entry`); if (input.value.trim()) { addTags(type, input.value); input.value = ''; } }); const settings = await api(`/api/guilds/${encodeURIComponent(guild.id)}/settings`, { method: 'PUT', body: JSON.stringify({ allowedVoiceChannels: tagState.voice, allowedTextChannels: tagState.text, allowedRoles: tagState.roles, defaultVolume: $('#volume').value }) }); fillSettings(settings); $('#settings-notice').textContent = 'Saved.'; } catch (error) { $('#settings-notice').textContent = error.message; } };
}

async function refresh(guild, viewRequest = state.viewRequest) {
  const refreshRequest = ++state.refreshRequest;
  try {
    const data = await api(`/api/guilds/${encodeURIComponent(guild.id)}/status`);
    if (viewRequest !== state.viewRequest || refreshRequest !== state.refreshRequest || state.selected !== guild) return;
    const status = $('#status');
    if (!status) return;
    status.textContent = data.botPresent ? (data.status.connected ? 'Live in voice' : 'Bot online') : 'Bot not installed';
    status.className = `status-pill${data.status.connected ? ' live' : ''}`;
    $('#resume').textContent = data.status.paused ? 'Resume' : 'Play';
    renderQueue(data.status.queue, guild);
    if (data.status.current) {
      renderNowPlaying(data.status.current, data.status.paused, data.status.elapsed);
    } else if (data.status.lastCompleted && data.botPresent) {
      renderPlaybackEnded(data.status.lastCompleted);
    } else if (data.botPresent) {
      const now = $('#now');
      now.replaceChildren();
      now.classList.add('now-empty');
      now.textContent = 'Nothing is playing. Add a track above.';
    } else {
      const now = $('#now');
      now.replaceChildren();
      now.classList.remove('now-empty');
      const card = document.createElement('div');
      card.className = 'invite-card';
      const copy = document.createElement('div');
      const title = document.createElement('p');
      title.textContent = 'Ready to start singing?';
      const detail = document.createElement('small');
      detail.textContent = 'Install the bot in this server';
      copy.append(title, detail);
      const link = document.createElement('a');
      link.className = 'control';
      const inviteUrl = safeInviteUrl(data.inviteUrl);
      if (!inviteUrl) return;
      link.href = inviteUrl;
      link.textContent = 'Invite bot ↗';
      card.append(copy, link);
      now.append(card);
    }
  } catch {}
}

init().catch((error) => console.error(error));
