const { recordUsage } = require('./db');

function recordWebRequest(req, canTrackGuild) {
  const match = String(req.originalUrl || '').split('?')[0].match(/^\/api\/guilds\/(\d{15,25})(?:\/|$)/);
  if (!match || !req.session?.user?.id) return;
  if (typeof canTrackGuild === 'function' && !canTrackGuild(match[1])) return;
  recordUsage({ guildId: match[1], userId: req.session.user.id, source: 'api' });
}

module.exports = { recordUsage, recordWebRequest };
