#!/usr/bin/env node
// One-time Strava OAuth helper. Run on the laptop to mint a refresh_token.
//
//   node scripts/strava-link.mjs
//
// It reads STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET from .env, serves a local
// page that bounces you through Strava's authorize screen (scope
// activity:read_all, read-only), exchanges the returned code for tokens, and
// writes the long-lived refresh_token back into .env as STRAVA_REFRESH_TOKEN.
// The access_token it also returns is short-lived (~6h) and intentionally not
// saved; agents/health/strava.sh refreshes its own on every call.
//
// Prereq: a Strava API app (strava.com/settings/api) with Authorization
// Callback Domain set to `localhost`. The token shown on that settings page
// is NOT usable here (it lacks the activity:read_all scope); you must do this
// authorize flow to get a scoped refresh_token.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');
const PORT = Number(process.env.PORT || 8080);
const REDIRECT = `http://localhost:${PORT}/callback`;

// Load .env without overriding vars already set on the command line.
const envFile = readFileSync(ENV_PATH, 'utf8');
for (const line of envFile.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing STRAVA_CLIENT_ID and/or STRAVA_CLIENT_SECRET in .env');
  process.exit(1);
}

const mask = (t) => t ? `${t.slice(0, 8)}…${t.slice(-4)} (len ${t.length})` : '(none)';

function persistRefresh(token) {
  let env = readFileSync(ENV_PATH, 'utf8');
  // Function replacer, not a string: a token with $-sequences would otherwise
  // be interpreted as special replacement patterns ($&, $1, $$) and corrupt it.
  env = /^STRAVA_REFRESH_TOKEN=.*$/m.test(env)
    ? env.replace(/^STRAVA_REFRESH_TOKEN=.*$/m, () => `STRAVA_REFRESH_TOKEN=${token}`)
    : env.trimEnd() + `\nSTRAVA_REFRESH_TOKEN=${token}\n`;
  writeFileSync(ENV_PATH, env, { mode: 0o600 });
}

const authorizeUrl = 'https://www.strava.com/oauth/authorize?' + new URLSearchParams({
  client_id: CLIENT_ID,
  response_type: 'code',
  redirect_uri: REDIRECT,
  approval_prompt: 'force',
  scope: 'activity:read_all',
}).toString();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/') {
      res.writeHead(302, { Location: authorizeUrl });
      res.end();
      return;
    }

    if (url.pathname === '/callback') {
      const err = url.searchParams.get('error');
      if (err) throw new Error(`Strava denied authorization: ${err}`);
      const code = url.searchParams.get('code');
      if (!code) throw new Error('No code in callback');

      // Form-encoded to match strava.sh's refresh grant and Strava's documented
      // token-endpoint contract (URLSearchParams sets the form content-type).
      const r = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(`${data.message || r.status}: ${JSON.stringify(data.errors || data)}`);

      persistRefresh(data.refresh_token);
      const who = data.athlete ? `${data.athlete.firstname} ${data.athlete.lastname}` : 'athlete';

      console.log(`\n✅ Strava connected for ${who}`);
      console.log(`   refresh_token: ${mask(data.refresh_token)}`);
      console.log(`   scope granted: activity:read_all (read-only)`);
      console.log('   → written to .env as STRAVA_REFRESH_TOKEN');
      console.log('\nDone. Stop this server (Ctrl-C), then deploy .env to the VPS.');

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`Success, connected ${who}.\nrefresh_token ${mask(data.refresh_token)} saved to .env.\nReturn to the terminal.`);
      return;
    }

    res.writeHead(404); res.end('not found');
  } catch (e) {
    console.error('Error:', e.message);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Error: ' + e.message);
  }
});

server.listen(PORT, () => {
  console.log(`Strava Link helper. client_id ${CLIENT_ID}, scope activity:read_all (read-only).`);
  console.log(`Make sure your Strava app's Authorization Callback Domain is "localhost".`);
  console.log(`Open http://localhost:${PORT} in your browser.`);
});
