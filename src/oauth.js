const crypto = require('node:crypto');
const config = require('./config');

function createOAuthState() {
  const payload = `${Date.now().toString(36)}.${crypto.randomBytes(8).toString('hex')}`;
  const signature = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('hex').slice(0, 32);
  return `${payload}.${signature}`;
}

function validOAuthState(state, expectedState) {
  if (typeof state !== 'string') return false;
  if (expectedState !== undefined && state !== expectedState) return false;
  const parts = state.split('.');
  if (parts.length !== 3 || !/^[0-9a-z]{8,14}$/.test(parts[0]) || !/^[a-f0-9]{16,48}$/.test(parts[1]) || !/^[a-f0-9]{32,64}$/.test(parts[2])) return false;
  const issuedAt = parseInt(parts[0], 36);
  if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > 10 * 60 * 1000 || issuedAt > Date.now() + 60 * 1000) return false;
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(`${parts[0]}.${parts[1]}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected.slice(0, parts[2].length)), Buffer.from(parts[2]));
}

module.exports = { createOAuthState, validOAuthState };
