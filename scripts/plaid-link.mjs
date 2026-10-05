#!/usr/bin/env node
// One-time Plaid Link helper — run on the laptop to mint an access_token.
//
//   PLAID_ENV=sandbox    node scripts/plaid-link.mjs   # free, test bank, 0 connections
//   PLAID_ENV=production node scripts/plaid-link.mjs   # real bank, spends 1 connection
//
// It reads client_id/secret from .env (sandbox uses PLAID_SANDBOX_SECRET so the
// production secret is never touched while testing), serves a local page that
// runs Plaid Link, exchanges the resulting public_token for an access_token, and
// — in production only — writes that token back into .env as PLAID_ACCESS_TOKEN.
// Sandbox runs print a masked confirmation and persist nothing.
//
// Read-only: requests the `transactions` product. Never money-movement.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');
const PORT = Number(process.env.PORT || 8080);

// Load .env without overriding vars already set on the command line.
const envFile = readFileSync(ENV_PATH, 'utf8');
for (const line of envFile.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const PLAID_ENV = process.env.PLAID_ENV || 'sandbox';
const CLIENT_ID = process.env.PLAID_CLIENT_ID;
const SECRET = PLAID_ENV === 'sandbox'
  ? process.env.PLAID_SANDBOX_SECRET
  : process.env.PLAID_SECRET;

// Update mode: re-consent an existing Item to add the investments product.
// No new Item is created (costs no connection) and the access_token is unchanged.
const ADD_INVESTMENTS = process.env.PLAID_ADD_INVESTMENTS === '1';
const ACCESS_TOKEN = process.env.PLAID_ACCESS_TOKEN;
if (ADD_INVESTMENTS && !ACCESS_TOKEN) {
  console.error('PLAID_ADD_INVESTMENTS=1 needs an existing PLAID_ACCESS_TOKEN in .env');
  process.exit(1);
}

if (!CLIENT_ID || !SECRET) {
  console.error(`Missing credentials for ${PLAID_ENV}: need PLAID_CLIENT_ID and ` +
    `${PLAID_ENV === 'sandbox' ? 'PLAID_SANDBOX_SECRET' : 'PLAID_SECRET'} in .env`);
  process.exit(1);
}

const BASE = `https://${PLAID_ENV}.plaid.com`;
const mask = (t) => t ? `${t.slice(0, 12)}…${t.slice(-4)} (len ${t.length})` : '(none)';

async function plaid(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, secret: SECRET, ...body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${data.error_code}: ${data.error_message}`);
  return data;
}

function persistToken(token) {
  const updated = readFileSync(ENV_PATH, 'utf8')
    .replace(/^PLAID_ACCESS_TOKEN=.*$/m, `PLAID_ACCESS_TOKEN=${token}`);
  writeFileSync(ENV_PATH, updated, { mode: 0o600 });
}

const server = createServer(async (req, res) => {
  try {
    if (req.url === '/') {
      const linkReq = {
        client_name: 'Varius Finances',
        user: { client_user_id: 'shri' },
        country_codes: ['US'],
        language: 'en',
      };
      if (ADD_INVESTMENTS) {
        linkReq.access_token = ACCESS_TOKEN;            // update mode
        linkReq.additional_consented_products = ['investments'];
      } else {
        linkReq.products = ['transactions'];
      }
      const { link_token } = await plaid('/link/token/create', linkReq);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><meta charset=utf8>
<title>Plaid Link — ${PLAID_ENV}</title>
<style>body{font:16px system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem}
button{font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:0;background:#111;color:#fff;cursor:pointer}
.env{padding:.2rem .5rem;border-radius:6px;background:${PLAID_ENV === 'production' ? '#fde68a' : '#bbf7d0'}}</style>
<h1>${ADD_INVESTMENTS ? 'Add investments access' : 'Connect a bank'}</h1>
<p>Environment: <span class=env><b>${PLAID_ENV}</b></span>
${ADD_INVESTMENTS
  ? '— update mode on your existing bank. Approve <b>investments</b> access. No new connection is used.'
  : PLAID_ENV === 'sandbox'
    ? '— test bank, log in with <code>user_good</code> / <code>pass_good</code>. Costs no connections.'
    : '— <b>real bank. Completing this spends 1 of your trial connections.</b>'}</p>
<button id=go>Launch Plaid Link</button>
<pre id=out></pre>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script>
const UPDATE = ${ADD_INVESTMENTS};
const out = document.getElementById('out');
const handler = Plaid.create({
  token: ${JSON.stringify(link_token)},
  onSuccess: async (public_token) => {
    if (UPDATE) {
      out.textContent = '✅ Investments access granted. Return to the terminal.';
      return;
    }
    out.textContent = 'Exchanging token…';
    const r = await fetch('/exchange', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ public_token }),
    });
    out.textContent = await r.text();
  },
  onExit: (err) => { if (err) out.textContent = 'Exited: ' + JSON.stringify(err, null, 2); },
});
document.getElementById('go').onclick = () => handler.open();
</script>`);
      return;
    }

    if (req.url === '/exchange' && req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const { public_token } = JSON.parse(Buffer.concat(chunks).toString());
      const { access_token, item_id } = await plaid('/item/public_token/exchange', { public_token });

      const persisted = PLAID_ENV === 'production';
      if (persisted) persistToken(access_token);

      console.log(`\n✅ ${PLAID_ENV} Item created`);
      console.log(`   item_id:      ${item_id}`);
      console.log(`   access_token: ${mask(access_token)}`);
      console.log(persisted
        ? '   → written to .env as PLAID_ACCESS_TOKEN'
        : '   → sandbox token NOT persisted (production secret untouched)');
      console.log('\nDone. You can stop this server (Ctrl-C).');

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`Success (${PLAID_ENV}).\nitem_id: ${item_id}\naccess_token: ${mask(access_token)}\n` +
        (persisted ? 'Saved to .env — return to the terminal.' : 'Sandbox test passed — nothing saved.'));
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
  console.log(`Plaid Link helper — env=${PLAID_ENV}${ADD_INVESTMENTS ? ' (update mode: adding investments)' : ''}, reaching ${BASE}`);
  console.log(`Open http://localhost:${PORT} in your browser.`);
  if (ADD_INVESTMENTS) console.log('ℹ️  Update mode — no new connection is used; your access_token is unchanged.');
  else if (PLAID_ENV === 'production') console.log('⚠️  Completing a real login here spends 1 trial connection.');
});
