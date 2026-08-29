const $ = (selector) => document.querySelector(selector);
const state = { guilds: [], selected: null, selectedTrack: null, timer: null, searchTimer: null, searchRequest: 0 };
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
      const response = await fetch(url, { headers: { 'content-type': 'application/json' }, ...options });
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
    if (guild.iconUrl) {
      icon.classList.add('has-image');
      const image = node.querySelector('.guild-image');
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
  $('#guilds').classList.add('hidden');
  const workspace = $('#workspace');
  workspace.classList.remove('hidden');
  workspace.innerHTML = `<div class="workspace-top"><div class="workspace-nav"><button class="back" id="back">← All stages</button><span class="workspace-divider">/</span><strong class="workspace-server" id="workspace-server-name"></strong></div><span class="status-pill" id="status">Loading…</span></div>
    <div class="workspace-grid">
      <div class="panel"><div class="panel-head"><div><div class="panel-kicker">QUEUE A TRACK</div><h3>Play a song</h3></div><span class="panel-symbol">⌁</span></div>
        <div class="search-row"><input class="input" id="song" maxlength="300" autocomplete="off" placeholder="Search a song or paste a YouTube URL"><button class="control control-accent" id="play">Play track <span>↗</span></button></div><div id="search-results" class="search-results hidden"></div>
        <p class="help">The bot joins your current voice channel and posts live lyrics in its built-in chat.</p><div id="notice" class="notice"></div>
        <div class="queue-heading"><div><span>UP NEXT</span><span id="queue-count">0 tracks</span></div><button class="queue-clear" id="clear-queue" type="button">Clear queue</button></div><div id="song-queue" class="song-queue"></div>
      </div>
      <div class="panel"><div class="panel-head"><div><div class="panel-kicker">ROOM CONTROLS</div><h3>Playback</h3></div><span class="panel-symbol">♪</span></div>
        <div class="voice-select"><label for="voice-channel">Voice channel</label><select class="input" id="voice-channel"><option value="">Use my current channel</option></select></div>
        <div class="playback-actions"><button class="control alt" id="join">Join</button><button class="control alt" id="resume">Resume</button><button class="control alt" id="pause">Pause</button><button class="control alt" id="skip">Skip</button><button class="control alt" id="stop">Stop</button></div>
        <div id="now" class="queue"></div>
      </div>
    </div>
    <div class="panel settings-panel"><div class="panel-head"><div><div class="panel-kicker">SERVER PREFERENCES</div><h3>Make it yours</h3></div><span class="panel-symbol">✦</span></div>
      <p class="settings-intro">Limit who can use karaoke and where commands can be sent. Leave a field blank to keep it open.</p>
      <div class="settings-grid"><div><label for="voice-entry">Allowed voice channel IDs</label><div class="tag-input" id="voice-tags"><div class="tag-list" id="voice-tag-list"></div><input class="tag-entry" id="voice-entry" placeholder="Type an ID, then press comma or Enter"></div><p class="field-note">Press comma or Enter after each ID. Copy IDs with Discord Developer Mode.</p></div><div><label for="text-entry">Allowed command text channel IDs</label><div class="tag-input" id="text-tags"><div class="tag-list" id="text-tag-list"></div><input class="tag-entry" id="text-entry" placeholder="Type an ID, then press comma or Enter"></div></div><div><label for="roles-entry">Allowed role IDs</label><div class="tag-input" id="roles-tags"><div class="tag-list" id="roles-tag-list"></div><input class="tag-entry" id="roles-entry" placeholder="Type an ID, then press comma or Enter"></div></div><div><label for="volume">Default volume</label><div class="range-row"><input class="input" id="volume" type="range" min="0" max="1" step="0.05"><span class="range-value" id="volume-value">80%</span></div></div></div>
      <div class="save-row"><button class="control control-accent save" id="save">Save settings</button><div id="settings-notice" class="notice"></div></div>
    </div>`;
  $('#workspace-server-name').textContent = guild.name;
  $('#back').onclick = () => { workspace.classList.add('hidden'); $('#guilds').classList.remove('hidden'); clearInterval(state.timer); clearTimeout(state.searchTimer); state.selectedTrack = null; };
  const settings = await api(`/api/guilds/${encodeURIComponent(guild.id)}/settings`);
  fillSettings(settings);
  await loadChannels(guild);
  bindControls(guild);
  refresh(guild);
  state.timer = setInterval(() => refresh(guild), 3000);
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
  if (!results.length) { container.classList.add('hidden'); return; }
  results.forEach((track) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'search-result';
    const copy = document.createElement('span');
    copy.className = 'search-result-copy';
    const title = document.createElement('strong');
    title.textContent = track.title || 'Untitled track';
    const meta = document.createElement('small');
    meta.textContent = [track.artist, formatDuration(track.duration)].filter(Boolean).join(' · ') || 'YouTube result';
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
function updatePlayButton() {
  const value = $('#song').value.trim();
  $('#play').disabled = !state.selectedTrack && !/^https?:\/\//i.test(value);
}
function bindSearch() {
  const input = $('#song');
  input.addEventListener('input', () => {
    state.selectedTrack = null;
    $('#notice').textContent = '';
    updatePlayButton();
    clearTimeout(state.searchTimer);
    const request = ++state.searchRequest;
    const query = input.value.trim();
    if (query.length < 2 || /^https?:\/\//i.test(query)) { $('#search-results').classList.add('hidden'); return; }
    state.searchTimer = setTimeout(async () => {
      try {
        const data = await api(`/api/search?q=${encodeURIComponent(query)}`);
        if (request === state.searchRequest && input.value.trim() === query) renderSearchResults(data.results || []);
      } catch (error) {
        if (request === state.searchRequest) { $('#search-results').classList.add('hidden'); $('#notice').textContent = error.message; }
      }
    }, 350);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && state.selectedTrack) { event.preventDefault(); $('#play').click(); }
  });
  updatePlayButton();
}

function bindControls(guild) {
  const guildPath = (name) => `/api/guilds/${encodeURIComponent(guild.id)}/${name}`;
  const action = async (name, body = {}) => { try { await api(guildPath(name), { method: 'POST', body: JSON.stringify(body) }); refresh(guild); } catch (error) { $('#notice').textContent = error.message; } };
  $('#play').onclick = () => { const query = state.selectedTrack?.url || $('#song').value.trim(); if (query) action('play', { song: query }); };
  $('#join').onclick = () => action('join', { channelId: $('#voice-channel').value || null });
  $('#resume').onclick = () => action('resume'); $('#pause').onclick = () => action('pause'); $('#skip').onclick = () => action('skip'); $('#stop').onclick = () => action('stop');
  $('#clear-queue').onclick = () => action('queue/clear');
  bindSearch();
  $('#volume').oninput = () => { $('#volume-value').textContent = `${Math.round(Number($('#volume').value) * 100)}%`; };
  bindTagInput('voice'); bindTagInput('text'); bindTagInput('roles');
  $('#save').onclick = async () => { try { ['voice', 'text', 'roles'].forEach((type) => { const input = $(`#${tagIds[type]}-entry`); if (input.value.trim()) { addTags(type, input.value); input.value = ''; } }); const settings = await api(`/api/guilds/${encodeURIComponent(guild.id)}/settings`, { method: 'PUT', body: JSON.stringify({ allowedVoiceChannels: tagState.voice, allowedTextChannels: tagState.text, allowedRoles: tagState.roles, defaultVolume: $('#volume').value }) }); fillSettings(settings); $('#settings-notice').textContent = 'Saved.'; } catch (error) { $('#settings-notice').textContent = error.message; } };
}

async function refresh(guild) {
  try {
    const data = await api(`/api/guilds/${encodeURIComponent(guild.id)}/status`);
    const status = $('#status');
    if (!status) return;
    status.textContent = data.botPresent ? (data.status.connected ? 'Live in voice' : 'Bot online') : 'Bot not installed';
    status.className = `status-pill${data.status.connected ? ' live' : ''}`;
    $('#resume').textContent = data.status.paused ? 'Resume' : 'Play';
    renderQueue(data.status.queue, guild);
    const now = $('#now');
    now.replaceChildren();
    if (data.status.current) {
      const label = document.createElement('strong');
      label.textContent = data.status.paused ? 'Paused' : 'Now playing';
      now.append(label, document.createElement('br'));
      now.append(document.createTextNode(data.status.current.title), document.createElement('br'));
      if (data.status.current.artist) now.append(document.createTextNode(data.status.current.artist), document.createElement('br'));
      now.append(document.createTextNode('Current room track'));
    } else if (data.botPresent) {
      now.textContent = 'Nothing is playing. Add a track above.';
    } else {
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
