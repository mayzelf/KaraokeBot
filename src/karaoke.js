const {
  AudioPlayerStatus, createAudioPlayer, createAudioResource, joinVoiceChannel,
  StreamType, VoiceConnectionStatus, entersState
} = require('@discordjs/voice');
const { EmbedBuilder } = require('discord.js');
const { ensureGuild, getGuild } = require('./db');
const { resolveTrack, createAudioStream } = require('./media');
const { findLyrics, currentLine } = require('./lyrics');

class KaraokeManager {
  constructor(client) {
    this.client = client;
    this.sessions = new Map();
  }

  session(guildId) {
    if (!this.sessions.has(guildId)) this.sessions.set(guildId, {
      queue: [], connection: null, player: createAudioPlayer(), current: null,
      textChannel: null, lyricMessage: null, lyricTimer: null, stream: null,
      startedAt: 0, pausedAt: 0, pausedTotal: 0, lastLine: null
    });
    const session = this.sessions.get(guildId);
    if (!session.bound) {
      session.bound = true;
      session.player.on(AudioPlayerStatus.Idle, () => this.next(guildId));
      session.player.on('error', (error) => {
        console.error(`[audio:${guildId}]`, error.message);
        this.next(guildId, 'Playback failed, skipping this track.');
      });
    }
    return session;
  }

  isAllowed(guildId, interaction) {
    const settings = getGuild(guildId) || ensureGuild(guildId, interaction.guild?.name || '');
    const member = interaction.member;
    const isAdmin = member?.permissions?.has?.('ManageGuild') || member?.permissions?.has?.('Administrator');
    if (isAdmin) return true;
    if (settings.allowedRoles.length && !member?.roles?.cache?.some((role) => settings.allowedRoles.includes(role.id))) return false;
    if (settings.allowedTextChannels.length && !settings.allowedTextChannels.includes(interaction.channelId)) return false;
    if (settings.allowedVoiceChannels.length && !member?.voice?.channelId) return false;
    if (settings.allowedVoiceChannels.length && !settings.allowedVoiceChannels.includes(member.voice.channelId)) return false;
    return true;
  }

  async join(guild, voiceChannel, textChannel) {
    const session = this.session(guild.id);
    if (!voiceChannel?.joinable || !voiceChannel?.speakable) throw new Error('I cannot join or speak in that voice channel. Check my Discord permissions.');
    session.connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false });
    await entersState(session.connection, VoiceConnectionStatus.Ready, 15_000);
    session.connection.subscribe(session.player);
    // Discord exposes a built-in text chat on every voice channel. VoiceChannel
    // supports .send(), so lyrics stay with the people singing automatically.
    session.textChannel = textChannel || voiceChannel || session.textChannel;
    return session;
  }

  async add(guild, query, voiceChannel, textChannel) {
    const session = await this.join(guild, voiceChannel, textChannel);
    const track = await resolveTrack(query);
    session.queue.push(track);
    if (!session.current) await this.next(guild.id);
    return track;
  }

  elapsed(session) {
    if (!session.startedAt) return 0;
    if (session.player.state.status === AudioPlayerStatus.Paused) return session.pausedAt - session.startedAt - session.pausedTotal;
    return (Date.now() - session.startedAt - session.pausedTotal) / 1000;
  }

  async next(guildId, notice) {
    const session = this.session(guildId);
    if (session.stream?.destroyChildren) session.stream.destroyChildren();
    if (session.lyricTimer) clearInterval(session.lyricTimer);
    session.lyricTimer = null;
    session.current = session.queue.shift() || null;
    session.startedAt = 0;
    session.pausedAt = 0;
    session.pausedTotal = 0;
    session.lastLine = null;
    const previousLyricMessage = session.lyricMessage;
    session.lyricMessage = null;
    if (!session.current) {
      if (previousLyricMessage) await previousLyricMessage.edit({ content: '🎤 Queue finished. Use `/play` to add another song.' }).catch(() => {});
      return;
    }
    const track = session.current;
    track.lyrics = await findLyrics(`${track.artist} ${track.title}`);
    session.stream = createAudioStream(track);
    const resource = createAudioResource(session.stream, { inputType: StreamType.Raw, inlineVolume: true });
    resource.volume?.setVolume(getGuild(guildId)?.default_volume ?? 0.8);
    session.player.once(AudioPlayerStatus.Playing, () => {
      session.startedAt = Date.now();
      this.startLyrics(guildId);
    });
    if (session.textChannel) {
      const embed = new EmbedBuilder().setColor(0x8b5cf6).setTitle('🎤 Now singing').setDescription(`**${track.title}**${track.artist ? `\n${track.artist}` : ''}\n\nLoading synchronized lyrics…`).setURL(track.url);
      if (track.thumbnail) embed.setThumbnail(track.thumbnail);
      if (notice) embed.setFooter({ text: notice });
      session.lyricMessage = await session.textChannel.send({ embeds: [embed] }).catch(() => null);
    }
    if (!track.lyrics?.lines?.length && session.lyricMessage) {
      await session.lyricMessage.edit({ content: '🎤 Now singing', embeds: [new EmbedBuilder().setColor(0xf59e0b).setTitle('Synchronized lyrics unavailable').setDescription(`**${track.title}**\n\nThe song is playing, but no timed lyrics were found for this track.`).setURL(track.url)] }).catch(() => {});
    }
    // Register the listener and post the initial message before starting audio,
    // otherwise a fast player can emit Playing before lyrics are ready to update.
    session.player.play(resource);
  }

  startLyrics(guildId) {
    const session = this.session(guildId);
    if (session.lyricTimer) clearInterval(session.lyricTimer);
    session.lyricTimer = setInterval(() => this.updateLyrics(guildId), 500);
    this.updateLyrics(guildId);
  }

  async updateLyrics(guildId) {
    const session = this.session(guildId);
    if (!session.current || !session.lyricMessage || !session.current.lyrics?.lines?.length) return;
    const lines = session.current.lyrics.lines;
    const index = currentLine(lines, this.elapsed(session));
    if (index < 0 || index === session.lastLine) return;
    session.lastLine = index;
    const previous = index > 0 ? lines[index - 1].text : '';
    const current = lines[index]?.text || '';
    const next = lines[index + 1]?.text || '';
    const embed = new EmbedBuilder().setColor(0xec4899).setTitle('🎤 Karaoke').setDescription(`**${session.current.title}**\n\n${previous ? `~~${previous}~~\n` : ''}## ${current}\n${next ? `\n${next}` : ''}`).setFooter({ text: `Synchronized lyrics · ${session.current.lyrics.source}` });
    await session.lyricMessage.edit({ embeds: [embed] }).catch(() => {});
  }

  status(guildId) {
    const session = this.session(guildId);
    return { connected: Boolean(session.connection), current: session.current, queue: session.queue, paused: session.player.state.status === AudioPlayerStatus.Paused, elapsed: this.elapsed(session) };
  }

  pause(guildId) {
    const session = this.session(guildId);
    if (session.player.pause() && !session.pausedAt) session.pausedAt = Date.now();
  }
  resume(guildId) {
    const session = this.session(guildId);
    if (session.pausedAt) session.pausedTotal += Date.now() - session.pausedAt;
    session.pausedAt = 0;
    session.player.unpause();
  }
  skip(guildId) { return this.next(guildId); }
  stop(guildId) {
    const session = this.session(guildId);
    session.queue = [];
    session.player.stop(true);
    if (session.stream?.destroyChildren) session.stream.destroyChildren();
    if (session.connection) session.connection.destroy();
    session.connection = null;
    session.current = null;
  }
  leave(guildId) { this.stop(guildId); }
}

module.exports = { KaraokeManager };
