const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('./config');
const { ensureGuild } = require('./db');
const { KaraokeManager } = require('./karaoke');
const { createOAuthState } = require('./oauth');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const karaoke = new KaraokeManager(client);
const commands = [
  new SlashCommandBuilder().setName('play').setDescription('Play a song and show synchronized lyrics').addStringOption((o) => o.setName('song').setDescription('YouTube URL or song search').setRequired(true)),
  new SlashCommandBuilder().setName('join').setDescription('Join your current voice channel'),
  new SlashCommandBuilder().setName('leave').setDescription('Stop karaoke and leave the voice channel'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause the karaoke'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume the karaoke'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the karaoke queue')
].map((command) => command.setDMPermission(false).toJSON());

async function registerCommands() {
  if (!config.clientId || !client.user) return;
  const rest = new REST({ version: '10' }).setToken(config.token);
  await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
}

function voiceChannel(interaction) { return interaction.member?.voice?.channel || null; }

client.once('ready', async () => {
  console.log(`[discord] logged in as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) ensureGuild(guild.id, guild.name);
  await registerCommands().catch((error) => console.error('[discord] command registration failed:', error.message));
});
client.on('guildCreate', (guild) => ensureGuild(guild.id, guild.name));

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (!karaoke.isAllowed(interaction.guildId, interaction)) return interaction.reply({ content: 'You are not allowed to control karaoke here.', ephemeral: true });
    const command = interaction.commandName;
    if (command === 'play') {
      await interaction.deferReply();
      const voice = voiceChannel(interaction);
      const track = await karaoke.add(interaction.guild, interaction.options.getString('song'), voice, voice);
      return interaction.editReply(`Added **${track.title}** to the queue. ${track.lyrics ? 'Synchronized lyrics found.' : 'No synchronized lyrics were found for this track.'}`);
    }
    if (command === 'join') {
      const voice = voiceChannel(interaction);
      await karaoke.join(interaction.guild, voice, voice);
      return interaction.reply('Joined your voice channel. Use `/play` to start singing.');
    }
    if (command === 'leave') { karaoke.leave(interaction.guildId); return interaction.reply('Stopped karaoke and left the voice channel.'); }
    if (command === 'skip') { await interaction.deferReply(); await karaoke.skip(interaction.guildId); return interaction.editReply('Skipped.'); }
    if (command === 'pause') { karaoke.pause(interaction.guildId); return interaction.reply('Paused.'); }
    if (command === 'resume') { karaoke.resume(interaction.guildId); return interaction.reply('Resumed.'); }
    if (command === 'stop') { karaoke.stop(interaction.guildId); return interaction.reply('Stopped and cleared the queue.'); }
    if (command === 'queue') {
      const status = karaoke.status(interaction.guildId);
      const songs = [status.current, ...status.queue].filter(Boolean).map((track, i) => `${i + 1}. **${track.title}**`).join('\n') || 'The queue is empty.';
      return interaction.reply(songs);
    }
  } catch (error) {
    console.error('[discord] command failed:', error);
    const message = error.message || 'Something went wrong.';
    if (interaction.deferred) interaction.editReply(`❌ ${message}`).catch(() => {});
    else if (!interaction.replied) interaction.reply({ content: `❌ ${message}`, ephemeral: true }).catch(() => {});
  }
});

async function startBot() {
  if (!config.token) return console.warn('[discord] DISCORD_TOKEN is missing; dashboard will still start.');
  await client.login(config.token);
}

const inviteUrl = (guildId) => {
  const permissions = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory | PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks | PermissionFlagsBits.Connect | PermissionFlagsBits.Speak | PermissionFlagsBits.UseVAD;
  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({ client_id: config.clientId, response_type: 'code', redirect_uri: config.redirectUri, scope: 'bot applications.commands identify guilds', permissions: permissions.toString(), state: createOAuthState(), ...(guildId ? { guild_id: guildId } : {}) });
  return url.toString();
};

module.exports = { client, karaoke, startBot, inviteUrl };
