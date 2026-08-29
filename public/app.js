const $ = (selector) => document.querySelector(selector);
const state = { guilds: [], selected: null, timer: null };

const api = async (url, options) => {
  const response = await fetch(url, { headers: { 'content-type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
}

async function init() {
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
      icon.style.backgroundImage = `url("${guild.iconUrl}")`;
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
  workspace.innerHTML = `<div class="workspace-top"><button class="back" id="back">← All stages</button><span class="status-pill" id="status">Loading…</span></div>
    <div class="workspace-grid">
      <div class="panel"><div class="panel-head"><div><div class="panel-kicker">QUEUE A TRACK</div><h3>Play a song</h3></div><span class="panel-symbol">⌁</span></div>
        <div class="search-row"><input class="input" id="song" placeholder="Search a song or paste a YouTube URL"><button class="control control-accent" id="play">Play track <span>↗</span></button></div>
        <p class="help">The bot joins your current voice channel and posts live lyrics in its built-in chat.</p><div id="notice" class="notice"></div>
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
  $('#back').onclick = () => { workspace.classList.add('hidden'); $('#guilds').classList.remove('hidden'); clearInterval(state.timer); };
  const settings = await api(`/api/guilds/${guild.id}/settings`);
  fillSettings(settings);
  await loadChannels(guild);
  bindControls(guild);
  refresh(guild);
  state.timer = setInterval(() => refresh(guild), 3000);
}

async function loadChannels(guild) {
  try {
    const channels = await api(`/api/guilds/${guild.id}/channels`);
    $('#voice-channel').innerHTML = '<option value="">Use my current channel</option>' + channels.filter((c) => c.type === 'voice').map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
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

function bindControls(guild) {
  const action = async (name, body = {}) => { try { await api(`/api/guilds/${guild.id}/${name}`, { method: 'POST', body: JSON.stringify(body) }); refresh(guild); } catch (error) { $('#notice').textContent = error.message; } };
  $('#play').onclick = () => { if ($('#song').value.trim()) action('play', { song: $('#song').value }); };
  $('#join').onclick = () => action('join', { channelId: $('#voice-channel').value || null });
  $('#resume').onclick = () => action('resume'); $('#pause').onclick = () => action('pause'); $('#skip').onclick = () => action('skip'); $('#stop').onclick = () => action('stop');
  $('#volume').oninput = () => { $('#volume-value').textContent = `${Math.round(Number($('#volume').value) * 100)}%`; };
  bindTagInput('voice'); bindTagInput('text'); bindTagInput('roles');
  $('#save').onclick = async () => { try { ['voice', 'text', 'roles'].forEach((type) => { const input = $(`#${tagIds[type]}-entry`); if (input.value.trim()) { addTags(type, input.value); input.value = ''; } }); const settings = await api(`/api/guilds/${guild.id}/settings`, { method: 'PUT', body: JSON.stringify({ allowedVoiceChannels: tagState.voice, allowedTextChannels: tagState.text, allowedRoles: tagState.roles, defaultVolume: $('#volume').value }) }); fillSettings(settings); $('#settings-notice').textContent = 'Saved.'; } catch (error) { $('#settings-notice').textContent = error.message; } };
}

async function refresh(guild) {
  try {
    const data = await api(`/api/guilds/${guild.id}/status`);
    const status = $('#status');
    if (!status) return;
    status.textContent = data.botPresent ? (data.status.connected ? 'Live in voice' : 'Bot online') : 'Bot not installed';
    status.className = `status-pill${data.status.connected ? ' live' : ''}`;
    $('#resume').textContent = data.status.paused ? 'Resume' : 'Play';
    $('#now').innerHTML = data.status.current ? `<strong>${data.status.paused ? 'Paused' : 'Now playing'}</strong><br>${escapeHtml(data.status.current.title)}<br><br>${data.status.queue.length ? `${data.status.queue.length} song(s) waiting` : 'Queue is empty'}` : (data.botPresent ? 'Nothing is playing. Add a track above.' : `<div class="invite-card"><div><p>Ready to start singing?</p><small>Install the bot in this server</small></div><a class="control" href="${data.inviteUrl}">Invite bot ↗</a></div>`);
  } catch {}
}

init().catch((error) => console.error(error));
