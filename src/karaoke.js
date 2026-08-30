const {
  AudioPlayerStatus, createAudioPlayer, createAudioResource, joinVoiceChannel,
  StreamType, VoiceConnectionStatus, entersState
} = require('@discordjs/voice');
const { ActivityType, EmbedBuilder } = require('discord.js');
const { ensureGuild, getGuild } = require('./db');
const { resolveTracks, createAudioStream } = require('./media');
const { findLyrics, currentLine } = require('./lyrics');
const noMentions = { parse: [] };
const presenceRefreshMs = 15_000;

function formatPresenceTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(value / 60);
  const remainingSeconds = String(value % 60).padStart(2, '0');
  return `${minutes}:${remainingSeconds}`;
}

class KaraokeManager {
  constructor(client) {
    this.client = client;
    this.sessions = new Map();
    this.presenceTimer = null;
  }

  updatePresence() {
    if (!this.client.user) return;
    const activeSessions = [...this.sessions.values()]
      .filter((session) => session.current);
    const activeTracks = activeSessions.map((session) => session.current);
    const activeSession = activeSessions[0];
    const track = activeSession?.current;
    let name = 'Use /play to sing';
    let state;
    if (track && activeSession) {
      const label = track.artist ? `${track.artist} — ${track.title}` : track.title;
      const extra = activeTracks.length > 1 ? ` (+${activeTracks.length - 1} more)` : '';
      name = `🎤 ${label}${extra}`.slice(0, 128);
      const duration = Number(track.duration);
      const elapsed = this.elapsed(activeSession);
      state = `${formatPresenceTime(elapsed)} / ${duration > 0 ? formatPresenceTime(duration) : '--:--'}`;
      this.startPresenceRefresh();
    } else {
      this.stopPresenceRefresh();
    }
    this.client.user.setActivity(name, { type: ActivityType.Playing, ...(state ? { state } : {}) });
  }

  startPresenceRefresh() {
    if (this.presenceTimer) return;
    this.presenceTimer = setInterval(() => this.updatePresence(), presenceRefreshMs);
    this.presenceTimer.unref?.();
  }

  stopPresenceRefresh() {
    if (!this.presenceTimer) return;
    clearInterval(this.presenceTimer);
    this.presenceTimer = null;
  }

  session(guildId) {
    if (!this.sessions.has(guildId)) this.sessions.set(guildId, {
      // Remote sources can have momentary read gaps. Allow one second before
      // treating a missing frame as the end of a track.
      queue: [], connection: null, player: createAudioPlayer({ behaviors: { maxMissedFrames: 50 } }), current: null,
      textChannel: null, lyricMessage: null, lyricTimer: null, stream: null,
      startedAt: 0, pausedAt: 0, pausedTotal: 0, lastLine: null, voiceChannelId: null,
      lastCompleted: null, nextPromise: null, onPlaying: null, playbackToken: 0
    });
    const session = this.sessions.get(guildId);
    if (!session.bound) {
      session.bound = true;
      session.player.on(AudioPlayerStatus.Idle, (oldState) => {
        if (oldState.resource?.metadata?.playbackToken !== session.playbackToken) return;
        this.next(guildId).catch((error) => console.error(`[audio:${guildId}]`, error.message));
      });
      session.player.on('error', (error) => {
        console.error(`[audio:${guildId}]`, error.message);
        if (error.resource?.metadata?.playbackToken !== session.playbackToken) return;
        this.next(guildId, 'Playback failed, skipping this track.').catch((nextError) => console.error(`[audio:${guildId}]`, nextError.message));
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

  async join(guild, voiceChannel, textChannel, requesterId = null) {
    const session = this.session(guild.id);
    if (!voiceChannel?.joinable || !voiceChannel?.speakable) throw new Error('I cannot join or speak in that voice channel. Check my Discord permissions.');
    // A guild session owns one voice room at a time. Record the room explicitly
    // so a second requester cannot move an active performance away from the
    // singers who started it without first stopping the session.
    const activeChannelId = session.voiceChannelId || guild.members.me?.voice?.channelId || null;
    if (activeChannelId && activeChannelId !== voiceChannel.id) throw new Error('I am already active in another voice channel. Use /leave there before moving me.');
    session.connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false });
    await entersState(session.connection, VoiceConnectionStatus.Ready, 15_000);
    session.connection.subscribe(session.player);
    session.voiceChannelId = voiceChannel.id;
    // Discord exposes a built-in text chat on every voice channel. VoiceChannel
    // supports .send(), so lyrics stay with the people singing automatically.
    session.textChannel = textChannel || voiceChannel || session.textChannel;
    return session;
  }

  async add(guild, query, voiceChannel, textChannel, requesterId = null) {
    const session = await this.join(guild, voiceChannel, textChannel, requesterId);
    const tracks = query && typeof query === 'object' && query.source === 'library' ? [query] : await resolveTracks(query);
    tracks.forEach((track) => { track.requestedBy = requesterId; });
    session.queue.push(...tracks);
    if (!session.current) await this.next(guild.id);
    return tracks;
  }

  elapsed(session) {
    if (!session.startedAt) return 0;
    if (session.player.state.status === AudioPlayerStatus.Paused) return session.pausedAt - session.startedAt - session.pausedTotal;
    return (Date.now() - session.startedAt - session.pausedTotal) / 1000;
  }

  splitLyrics(text, limit = 3500) {
    const chunks = [];
    let remaining = String(text || '').trim();
    while (remaining.length > limit) {
      let splitAt = remaining.lastIndexOf('\n', limit);
      if (splitAt < Math.floor(limit * 0.55)) splitAt = remaining.lastIndexOf(' ', limit);
      if (splitAt < 1) splitAt = limit;
      chunks.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
  }

  async sendPlainLyrics(session, track, notice) {
    const chunks = this.splitLyrics(track.lyrics.text);
    const messages = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const embed = new EmbedBuilder()
        .setColor(0xf59e0b)
        .setTitle(index === 0 ? '🎤 Now singing · Full lyrics' : '🎤 Full lyrics · Continued')
        .setDescription(`**${track.title}**${track.artist ? `\n${track.artist}` : ''}\n\n${chunks[index]}`)
        .setFooter({ text: 'Complete lyrics · not synchronized' });
      if (track.url) embed.setURL(track.url);
      if (index === 0 && track.thumbnail) embed.setThumbnail(track.thumbnail);
      if (index === 0 && notice) embed.setFooter({ text: `${notice} · Complete lyrics · not synchronized` });
      const message = await session.textChannel.send({ embeds: [embed], allowedMentions: noMentions }).catch(() => null);
      if (message) messages.push(message);
    }
    session.lyricMessage = messages[0] || null;
  }

  async markSongEnded(message, track, nextTrack) {
    if (!message || !track) return;
    const nextDescription = nextTrack
      ? `\n\n**Up next:** ${nextTrack.title}`
      : '\n\nUse `/play` to add another song.';
    const embed = new EmbedBuilder()
      .setColor(0x70b83d)
      .setTitle('🎤 Song ended')
      .setDescription(`**${track.title}**${track.artist ? `\n${track.artist}` : ''}\n\nThanks for singing!${nextDescription}`)
      .setFooter({ text: nextTrack ? 'Playback complete · Up next' : 'Playback complete · Queue finished' });
    if (track.url) embed.setURL(track.url);
    if (track.thumbnail) embed.setThumbnail(track.thumbnail);
    await message.edit({ content: null, embeds: [embed], allowedMentions: noMentions }).catch(() => {});
  }

  disposeStream(stream) {
    if (!stream) return;
    stream.destroyChildren?.();
    if (!stream.destroyed) stream.destroy();
  }

  async next(guildId, notice) {
    const session = this.session(guildId);
    // Stopping a stream can emit Idle while a replacement track is still
    // loading. Share one transition so that event-driven and manual skips
    // cannot advance the queue more than once.
    if (session.nextPromise) return session.nextPromise;
    const transition = Promise.resolve().then(() => this.advance(guildId, notice));
    session.nextPromise = transition;
    try { return await transition; }
    finally { if (session.nextPromise === transition) session.nextPromise = null; }
  }

  async advance(guildId, notice) {
    const session = this.session(guildId);
    const previousTrack = session.current;
    const previousStream = session.stream;
    const playbackToken = ++session.playbackToken;
    session.stream = null;
    if (session.onPlaying) {
      session.player.off(AudioPlayerStatus.Playing, session.onPlaying);
      session.onPlaying = null;
    }
    // Stop the player before tearing down the producer. This prevents a late
    // frame from the previous resource from being consumed during the handoff.
    session.player.stop(true);
    this.disposeStream(previousStream);
    if (session.lyricTimer) clearInterval(session.lyricTimer);
    session.lyricTimer = null;
    session.current = session.queue.shift() || null;
    if (previousTrack) session.lastCompleted = previousTrack;
    this.updatePresence();
    session.startedAt = 0;
    session.pausedAt = 0;
    session.pausedTotal = 0;
    session.lastLine = null;
    const previousLyricMessage = session.lyricMessage;
    session.lyricMessage = null;
    if (previousLyricMessage && previousTrack) await this.markSongEnded(previousLyricMessage, previousTrack, session.current);
    if (!session.current) {
      return;
    }
    const track = session.current;
    track.lyrics = await findLyrics({ artist: track.artist, title: track.title });
    session.stream = createAudioStream(track);
    const resource = createAudioResource(session.stream, {
      inputType: StreamType.Raw,
      inlineVolume: true,
      metadata: { playbackToken }
    });
    resource.volume?.setVolume(getGuild(guildId)?.default_volume ?? 0.8);
    const onPlaying = () => {
      session.onPlaying = null;
      if (session.playbackToken !== playbackToken || session.current !== track || session.startedAt) return;
      session.startedAt = Date.now();
      this.startLyrics(guildId);
    };
    session.onPlaying = onPlaying;
    session.player.once(AudioPlayerStatus.Playing, onPlaying);
    if (session.textChannel) {
      if (track.lyrics?.mode === 'plain') {
        await this.sendPlainLyrics(session, track, notice);
      } else {
        const firstLine = track.lyrics?.lines?.[0]?.text;
        const nextLine = track.lyrics?.lines?.[1]?.text;
        const lyricPreview = firstLine ? `\n\n## ${firstLine}${nextLine ? `\n\n${nextLine}` : ''}` : '\n\nLoading synchronized lyrics…';
        const embed = new EmbedBuilder().setColor(0x8b5cf6).setTitle('🎤 Now singing').setDescription(`**${track.title}**${track.artist ? `\n${track.artist}` : ''}${lyricPreview}`);
        if (track.url) embed.setURL(track.url);
        if (track.thumbnail) embed.setThumbnail(track.thumbnail);
        if (notice) embed.setFooter({ text: notice });
        else if (firstLine) embed.setFooter({ text: 'Synchronized lyrics · starting playback' });
        session.lyricMessage = await session.textChannel.send({ embeds: [embed], allowedMentions: noMentions }).catch(() => null);
      }
    }
    if (!track.lyrics && session.lyricMessage) {
      const unavailableEmbed = new EmbedBuilder().setColor(0xf59e0b).setTitle('Lyrics unavailable').setDescription(`**${track.title}**\n\nThe song is playing, but no lyrics were found for this track.`);
      if (track.url) unavailableEmbed.setURL(track.url);
      await session.lyricMessage.edit({ content: '🎤 Now singing', embeds: [unavailableEmbed], allowedMentions: noMentions }).catch(() => {});
    }
    // Register the listener and post the initial message before starting audio,
    // otherwise a fast player can emit Playing before lyrics are ready to update.
    session.player.play(resource);
    if (session.player.state.status === AudioPlayerStatus.Playing) onPlaying();
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
    await session.lyricMessage.edit({ embeds: [embed], allowedMentions: noMentions }).catch(() => {});
  }

  status(guildId) {
    const session = this.session(guildId);
    return { connected: Boolean(session.connection), current: session.current, lastCompleted: session.lastCompleted, queue: session.queue, paused: session.player.state.status === AudioPlayerStatus.Paused, elapsed: this.elapsed(session) };
  }

  pause(guildId) {
    const session = this.session(guildId);
    if (session.player.pause() && !session.pausedAt) session.pausedAt = Date.now();
    this.updatePresence();
  }
  resume(guildId) {
    const session = this.session(guildId);
    if (session.pausedAt) session.pausedTotal += Date.now() - session.pausedAt;
    session.pausedAt = 0;
    session.player.unpause();
    this.updatePresence();
  }
  async skip(guildId, guild, requesterId) {
    const session = this.session(guildId);
    if (!session.current) throw new Error('There is no active song to skip.');
    const activeChannelId = session.voiceChannelId || guild.members.me?.voice?.channelId || null;
    const member = requesterId ? await guild.members.fetch(requesterId).catch(() => null) : null;
    const isAdministrator = member?.permissions?.has?.('Administrator') === true;
    if (!isAdministrator && (!member?.voice?.channelId || member.voice.channelId !== activeChannelId)) throw new Error('Join my active voice channel before skipping a song.');
    // A track belongs to the person who queued it. That person can skip it
    // immediately; everyone else must wait until its requester has left the
    // active room, which prevents strangers from removing another singer's song.
    // Members with the Discord Administrator permission can always skip,
    // including when they are not currently in the active voice channel.
    if (!isAdministrator && session.current.requestedBy !== requesterId) {
      const owner = session.current.requestedBy ? await guild.members.fetch(session.current.requestedBy).catch(() => null) : null;
      if (owner?.voice?.channelId === activeChannelId) throw new Error('Only the person who queued this song can skip it while they are still in the room.');
    }
    return this.next(guildId);
  }
  removeQueued(guildId, index) {
    const session = this.session(guildId);
    if (!Number.isInteger(index) || index < 0 || index >= session.queue.length) throw new Error('That queue entry no longer exists.');
    return session.queue.splice(index, 1)[0];
  }
  moveQueued(guildId, from, to) {
    const session = this.session(guildId);
    if (![from, to].every((index) => Number.isInteger(index) && index >= 0 && index < session.queue.length)) throw new Error('That queue position no longer exists.');
    if (from === to) return session.queue[from];
    const [track] = session.queue.splice(from, 1);
    session.queue.splice(to, 0, track);
    return track;
  }
  clearQueue(guildId) {
    const session = this.session(guildId);
    const removed = session.queue.length;
    session.queue = [];
    return removed;
  }
  stop(guildId) {
    const session = this.session(guildId);
    session.queue = [];
    // Invalidate the current resource before stop() emits Idle synchronously.
    session.playbackToken += 1;
    session.player.stop(true);
    if (session.onPlaying) {
      session.player.off(AudioPlayerStatus.Playing, session.onPlaying);
      session.onPlaying = null;
    }
    this.disposeStream(session.stream);
    session.stream = null;
    if (session.lyricTimer) clearInterval(session.lyricTimer);
    session.lyricTimer = null;
    if (session.connection) session.connection.destroy();
    session.connection = null;
    session.voiceChannelId = null;
    session.current = null;
    session.lastCompleted = null;
    session.lyricMessage = null;
    this.updatePresence();
  }
  leave(guildId) { this.stop(guildId); }
}

module.exports = { KaraokeManager };
