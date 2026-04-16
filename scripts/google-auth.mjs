#!/usr/bin/env node
// One-off OAuth bootstrap: get a refresh_token for Google Tasks.
// Usage: npm run auth:google
//
// Requires in .env:
//   GOOGLE_CLIENT_ID=...
//   GOOGLE_CLIENT_SECRET=...
//
// After success, copy printed refresh_token into .env as GOOGLE_REFRESH_TOKEN.

import 'dotenv/config';
import http from 'node:http';
import { URL } from 'node:url';
import { OAuth2Client } from 'google-auth-library';
import open from 'open';

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env');
  process.exit(1);
}

const PORT = 53682; // arbitrary loopback port
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = ['https://www.googleapis.com/auth/tasks'];

const oauth = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // force refresh_token issuance
  scope: SCOPES,
});

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url || !req.url.startsWith('/callback')) {
      res.writeHead(404).end();
      return;
    }
    const url = new URL(req.url, REDIRECT_URI);
    const code = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    if (err || !code) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end(`OAuth error: ${err ?? 'no code'}`);
      console.error('OAuth error:', err ?? 'no code');
      server.close();
      process.exit(1);
    }
    const { tokens } = await oauth.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
      '<h2>✅ Готово</h2><p>Можно закрыть вкладку и вернуться в терминал.</p>',
    );
    server.close();

    if (!tokens.refresh_token) {
      console.error(
        '\n❌ refresh_token не получен. Зайди на https://myaccount.google.com/permissions,',
        'удали доступ этого приложения, и запусти `npm run auth:google` ещё раз.',
      );
      process.exit(1);
    }

    console.log('\n✅ OAuth success. Вставь в .env:\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    console.log('(access_token нам не нужен — SDK обновляет его сам по refresh_token)');
    process.exit(0);
  } catch (e) {
    console.error('callback handler failed:', e);
    try {
      res.writeHead(500).end();
    } catch {}
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log('Открываю браузер для авторизации Google Tasks…');
  console.log('Если не открылось — скопируй ссылку руками:\n');
  console.log(authUrl + '\n');
  try {
    await open(authUrl);
  } catch {
    /* noop — URL уже напечатан */
  }
});
