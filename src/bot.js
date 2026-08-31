const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('./config');
const { ensureGuild, getGuild, updateGuild } = require('./db');
const { KaraokeManager } = require('./karaoke');
const { isPlaylistUrl } = require('./media');
const { createOAuthState } = require('./oauth');
const { validateVolume } = require('./validation');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const karaoke = new KaraokeManager(client);
const noMentions = { parse: [] };
const commands = [
  new SlashCommandBuilder().setName('play').setDescription('Play a song or playlist and show synchronized lyrics').addStringOption((o) => o.setName('song').setDescription('Song search, YouTube/SoundCloud URL, or Spotify playlist URL').setMaxLength(300).setRequired(true)),
  new SlashCommandBuilder().setName('join').setDescription('Join your current voice channel'),
  new SlashCommandBuilder().setName('leave').setDescription('Stop karaoke and leave the voice channel'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause the karaoke'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume the karaoke'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the karaoke queue'),
  new SlashCommandBuilder().setName('volume').setDescription('Set the playback volume for this room').addIntegerOption((o) => o.setName('level').setDescription('Volume percentage from 0 to 100').setMinValue(0).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName('instrumental').setDescription('Reduce the lead vocal so the room can sing it').addBooleanOption((o) => o.setName('on').setDescription('Leave empty to toggle'))
].map((command) => command.setDMPermission(false).toJSON());

const COMMAND_SYNC_ATTEMPTS = 3;
const COMMAND_SYNC_RETRY_MS = 5000;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function synchronizeCommands(route, scope, body = commands) {
  if (!config.clientId || !client.user) return;
  const rest = new REST({ version: '10' }).setToken(config.token);
  let lastError;
  for (let attempt = 1; attempt <= COMMAND_SYNC_ATTEMPTS; attempt += 1) {
    try {
      // Bulk-overwrite the command set so removed or changed commands are
      // also pushed when the container is updated and restarted.
      await rest.put(route, { body });
      console.log(`[discord] synchronized ${body.length} ${scope} commands.`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < COMMAND_SYNC_ATTEMPTS) {
        console.warn(`[discord] command synchronization attempt ${attempt} failed; retrying in ${COMMAND_SYNC_RETRY_MS / 1000}s:`, error.message);
        await wait(COMMAND_SYNC_RETRY_MS);
      }
    }
  }
  throw lastError;
}

async function registerGuildCommands(guildId) {
  await synchronizeCommands(Routes.applicationGuildCommands(config.clientId, guildId), `guild ${guildId}`);
}

async function registerCommands() {
  if (!config.clientId || !client.user) return;
  // Guild commands propagate immediately. This bot's commands are all
  // server-only, so use the guild scope as the authoritative command set.
  for (const guild of client.guilds.cache.values()) await registerGuildCommands(guild.id);
  // Remove the old global copy so Discord cannot serve a stale version of a
  // command while the guild copy is already current.
  await synchronizeCommands(Routes.applicationCommands(config.clientId), 'global', []);
}

function voiceChannel(interaction) { return interaction.member?.voice?.channel || null; }

client.once('clientReady', async () => {
  console.log(`[discord] logged in as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) ensureGuild(guild.id, guild.name);
  karaoke.updatePresence();
});
client.on('guildCreate', (guild) => {
  ensureGuild(guild.id, guild.name);
  registerGuildCommands(guild.id).catch((error) => console.error(`[discord] command synchronization failed for guild ${guild.id}:`, error.message));
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (!karaoke.isAllowed(interaction.guildId, interaction)) return interaction.reply({ content: 'You are not allowed to control karaoke here.', ephemeral: true });
    const command = interaction.commandName;
    if (command === 'play') {
      await interaction.deferReply();
      const voice = voiceChannel(interaction);
      const query = interaction.options.getString('song');
      const wasPlaying = Boolean(karaoke.status(interaction.guildId).current);
      const playlist = isPlaylistUrl(query);
      const tracks = await karaoke.add(interaction.guild, query, voice, voice, interaction.user.id);
      const firstTrack = tracks[0];
      const lyricsMessage = tracks.length === 1
        ? (firstTrack.lyrics?.mode === 'synced' ? 'Synchronized lyrics found.' : firstTrack.lyrics?.mode === 'plain' ? 'Complete lyrics found; they will not be synchronized.' : 'No lyrics were found for this track.')
        : 'The playlist tracks were added in order.';
      const summary = playlist
        ? `Added playlist with **${tracks.length} tracks** to the queue.`
        : tracks.length === 1
          ? `${wasPlaying ? 'Added' : 'Playing'} **${firstTrack.title}** ${wasPlaying ? 'to the queue.' : 'now.'}`
          : `Added **${tracks.length} tracks** to the queue.`;
      return interaction.editReply({ content: `${summary} ${lyricsMessage}`, allowedMentions: noMentions });
    }
    if (command === 'join') {
      const voice = voiceChannel(interaction);
      await karaoke.join(interaction.guild, voice, voice, interaction.user.id);
      return interaction.reply('Joined your voice channel. Use `/play` to start singing.');
    }
    if (command === 'leave') { karaoke.leave(interaction.guildId); return interaction.reply('Stopped karaoke and left the voice channel.'); }
    if (command === 'skip') { await interaction.deferReply(); await karaoke.skip(interaction.guildId, interaction.guild, interaction.user.id); return interaction.editReply('Skipped.'); }
    if (command === 'pause') { karaoke.pause(interaction.guildId); return interaction.reply('Paused.'); }
    if (command === 'resume') { karaoke.resume(interaction.guildId); return interaction.reply('Resumed.'); }
    if (command === 'stop') { karaoke.stop(interaction.guildId); return interaction.reply('Stopped and cleared the queue.'); }
    if (command === 'volume') {
      const level = interaction.options.getInteger('level');
      karaoke.setVolume(interaction.guildId, validateVolume(level / 100));
      return interaction.reply(`Volume set to ${level}%.`);
    }
    if (command === 'instrumental') {
      const settings = getGuild(interaction.guildId) || ensureGuild(interaction.guildId, interaction.guild?.name || '');
      const requested = interaction.options.getBoolean('on');
      const enabled = requested === null ? !settings.instrumental : requested;
      updateGuild(interaction.guildId, { instrumental: enabled });
      await interaction.deferReply();
      // A filter change means a new FFmpeg process, so the current song starts over.
      const restarted = await karaoke.restartCurrent(interaction.guildId);
      const note = restarted ? ' Restarting the current song.' : '';
      return interaction.editReply(enabled
        ? `Instrumental mode is **on**. The lead vocal is reduced by cancelling the centre channel, so centred drums and bass fade too.${note}`
        : `Instrumental mode is **off**.${note}`);
    }
    if (command === 'queue') {
      const status = karaoke.status(interaction.guildId);
      const songs = [status.current, ...status.queue].filter(Boolean).map((track, i) => `${i + 1}. **${track.title}**`).join('\n') || 'The queue is empty.';
      return interaction.reply({ content: songs, allowedMentions: noMentions });
    }
  } catch (error) {
    console.error('[discord] command failed:', error);
    const message = error.message || 'Something went wrong.';
    if (interaction.deferred) interaction.editReply({ content: `❌ ${message}`, allowedMentions: noMentions }).catch(() => {});
    else if (!interaction.replied) interaction.reply({ content: `❌ ${message}`, ephemeral: true, allowedMentions: noMentions }).catch(() => {});
  }
});

async function startBot() {
  if (!config.token) return console.warn('[discord] DISCORD_TOKEN is missing; dashboard will still start.');
  await client.login(config.token);
  // Keep Discord's global command definitions in sync on every process start,
  // including deployments that only changed an option or description.
  await registerCommands();
}

const inviteUrl = (guildId, state = createOAuthState()) => {
  const permissions = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory | PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks | PermissionFlagsBits.Connect | PermissionFlagsBits.Speak | PermissionFlagsBits.UseVAD;
  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({ client_id: config.clientId, response_type: 'code', redirect_uri: config.redirectUri, scope: 'bot applications.commands identify guilds', permissions: permissions.toString(), state, ...(guildId ? { guild_id: guildId } : {}) });
  return url.toString();
};

module.exports = { client, karaoke, startBot, inviteUrl };
