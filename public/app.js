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
    container.innerHTML = '<div class="panel"><p>No servers available. Log in with an account that has Manage Server permission.</p></div>';
    return;
  }
  for (const guild of state.guilds) {
    const node = $('#guild-template').content.cloneNode(true);
    node.querySelector('.guild-name').textContent = guild.name;
    node.querySelector('.guild-status').textContent = guild.botPresent ? 'Bot online · Open control room' : 'Bot not installed · Invite now';
    node.querySelector('.guild-card').onclick = () => selectGuild(guild);
    container.appendChild(node);
  }
}

async function selectGuild(guild) {
  state.selected = guild;
  $('#guilds').classList.add('hidden');
  const workspace = $('#workspace');
  workspace.classList.remove('hidden');
  workspace.innerHTML = `<div class="panel-head"><button class="back" id="back">← All servers</button><span class="status-pill" id="status">Loading…</span></div>
    <div class="workspace-grid">
      <div class="panel"><div class="panel-head"><h3>Play a song</h3><span>🎤</span></div>
        <div class="control-row"><input class="input" id="song" placeholder="Song title, artist, or YouTube URL"><button class="control" id="play">Play</button></div>
        <p class="help">Lyrics are posted automatically in the built-in chat of the voice channel you join.</p><div id="notice" class="notice"></div>
      </div>
      <div class="panel"><div class="panel-head"><h3>Playback</h3><span>♪</span></div>
        <label>Voice channel <select class="input" id="voice-channel"><option value="">Use my current channel</option></select></label>
        <div class="control-row"><button class="control alt" id="join">Join</button><button class="control alt" id="resume">Resume</button><button class="control alt" id="pause">Pause</button><button class="control alt" id="skip">Skip</button><button class="control alt" id="stop">Stop</button></div>
        <div id="now" class="queue"></div>
      </div>
    </div>
    <div class="panel"><div class="panel-head"><h3>Server settings</h3><span class="muted">Changes apply immediately</span></div>
      <label>Allowed voice channel IDs <input class="input" id="voice" placeholder="One Discord channel ID per line"></label><p class="help">Leave blank to allow any voice channel. Enable Developer Mode in Discord to copy IDs.</p>
      <label>Allowed command text channel IDs <input class="input" id="text" placeholder="One Discord channel ID per line"></label>
      <label>Allowed role IDs <input class="input" id="roles" placeholder="One Discord role ID per line"></label><p class="help">Leave blank to allow every channel or role. Server managers can always control the bot.</p>
      <label>Default volume <input class="input" id="volume" type="range" min="0" max="1" step="0.05"></label><button class="control save" id="save">Save settings</button><div id="settings-notice" class="notice"></div>
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

const settingLines = (value) => value.split(/\r?\n|,/).map((v) => v.trim()).filter(Boolean).join('\n');
function fillSettings(settings) { $('#voice').value = settings.allowedVoiceChannels.join('\n'); $('#text').value = settings.allowedTextChannels.join('\n'); $('#roles').value = settings.allowedRoles.join('\n'); $('#volume').value = settings.default_volume; }

function bindControls(guild) {
  const action = async (name, body = {}) => { try { await api(`/api/guilds/${guild.id}/${name}`, { method: 'POST', body: JSON.stringify(body) }); refresh(guild); } catch (error) { $('#notice').textContent = error.message; } };
  $('#play').onclick = () => { if ($('#song').value.trim()) action('play', { song: $('#song').value }); };
  $('#join').onclick = () => action('join', { channelId: $('#voice-channel').value || null });
  $('#resume').onclick = () => action('resume');
  $('#pause').onclick = () => action('pause');
  $('#skip').onclick = () => action('skip');
  $('#stop').onclick = () => action('stop');
  $('#save').onclick = async () => { try { const settings = await api(`/api/guilds/${guild.id}/settings`, { method: 'PUT', body: JSON.stringify({ allowedVoiceChannels: settingLines($('#voice').value).split('\n'), allowedTextChannels: settingLines($('#text').value).split('\n'), allowedRoles: settingLines($('#roles').value).split('\n'), defaultVolume: $('#volume').value }) }); fillSettings(settings); $('#settings-notice').textContent = 'Saved.'; } catch (error) { $('#settings-notice').textContent = error.message; } };
}

async function refresh(guild) {
  try {
    const data = await api(`/api/guilds/${guild.id}/status`);
    const status = $('#status');
    if (!status) return;
    status.textContent = data.botPresent ? (data.status.connected ? '● Live in voice' : 'Bot online') : 'Bot not installed';
    status.className = `status-pill${data.status.connected ? ' live' : ''}`;
    $('#resume').textContent = data.status.paused ? 'Resume' : 'Play';
    $('#now').innerHTML = data.status.current ? `<strong>${data.status.paused ? 'Paused' : 'Now playing'}</strong><br>${escapeHtml(data.status.current.title)}<br><br>${data.status.queue.length ? `${data.status.queue.length} song(s) waiting` : 'Queue is empty'}` : (data.botPresent ? 'Nothing is playing. Add a song above.' : `<a class="button primary" href="${data.inviteUrl}">Invite bot to this server →</a>`);
  } catch {}
}

init().catch((error) => console.error(error));
