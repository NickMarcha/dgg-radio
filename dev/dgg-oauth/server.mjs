/**
 * A stand-in for the three destiny.gg endpoints the room's sign-in uses, for
 * local development only.
 *
 * destiny.gg allows one application per account and has no test applications,
 * so the production client is the only one that exists, and its single
 * registered redirect points at the deployed site. Signing in locally would
 * mean moving that redirect off production. This serves the same protocol
 * against invented identities instead, so a local room can sign anyone in
 * without the real provider knowing.
 *
 * It is a drop-in replacement, not a bypass: the room's own OAuth code runs
 * unchanged, and the secret-bound code challenge is verified here exactly as
 * the archived PHP verifies it. A login that works against this shim exercises
 * every step except Destiny's own account check.
 *
 * It cannot reach production. `dev/` is excluded from the API image by
 * .dockerignore, the service exists only in compose.test.yaml, and the API
 * refuses to start against a provider other than destiny.gg once APP_ORIGIN is
 * https. Zero dependencies, so it runs on a bare node image with this file
 * mounted in.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8789);
const CLIENT_ID = process.env.DGG_CLIENT_ID ?? 'dev-client';
const CLIENT_SECRET = process.env.DGG_CLIENT_SECRET ?? 'dev-secret';

/** Destiny keeps an authorization code for five minutes. */
const CODE_TTL_MS = 5 * 60 * 1_000;

/** code -> { identity, codeChallenge, redirectUri, expiresAt } */
const codes = new Map();
/** access token -> identity */
const tokens = new Map();

const sha256Hex = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Destiny's challenge is not PKCE. Both hashes are lowercase hex, and the outer
 * Base64 encodes those hex characters as ASCII. This mirrors
 * buildDggCodeChallenge in src/server/auth.ts, which is the point of checking
 * it here: a mistake in either one has to show up as a failed login.
 */
const codeChallengeFor = (verifier) =>
  Buffer.from(sha256Hex(verifier + sha256Hex(CLIENT_SECRET)), 'utf8').toString('base64');

/** The same username returns to the same account, the way a real one does. */
const derivedUserId = (username) =>
  String(parseInt(sha256Hex(username.toLowerCase()).slice(0, 8), 16));

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (character) => '&#' + character.charCodeAt(0) + ';');

const splitList = (value) =>
  String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sendHtml(response, status, html) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
  });
  response.end(html);
}

/** Named the way the room reads them, since picking one is what this is for. */
const FEATURES = [
  ['subscriber', 'Subscriber'],
  ['admin', 'Destiny ADMIN flair'],
  ['moderator', 'Destiny MODERATOR flair'],
  ['bot', 'Bot'],
  ['flair35', 'Team PEPE'],
  ['flair36', 'Team YEE'],
];

const STYLE = `
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 2.5rem 1.5rem; background: #14161a; color: #e6e8ea;
    font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    display: flex; justify-content: center;
  }
  main { width: min(34rem, 100%); }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  .lede { color: #9aa3ad; margin: 0 0 2rem; }
  .lede strong { color: #e6e8ea; }
  label.field { display: block; margin-bottom: 1.25rem; }
  label.field > span { display: block; margin-bottom: .35rem; }
  label.field small { display: block; color: #9aa3ad; margin-top: .3rem; }
  input[type=text] {
    width: 100%; box-sizing: border-box; padding: .55rem .7rem;
    background: #1c1f25; color: inherit; font: inherit;
    border: 1px solid #333941; border-radius: 4px;
  }
  input[type=text]:focus { outline: 2px solid #4f8cc9; outline-offset: 1px; }
  fieldset { border: 1px solid #333941; border-radius: 4px; margin: 0 0 1.25rem; padding: 1rem; }
  legend { padding: 0 .4rem; color: #9aa3ad; }
  .check { display: flex; gap: .5rem; align-items: baseline; margin-bottom: .4rem; }
  code { color: #9aa3ad; }
  button {
    background: #4f8cc9; color: #10131a; font: inherit; font-weight: 600;
    border: 0; border-radius: 4px; padding: .6rem 1.2rem; cursor: pointer;
  }
  .error {
    border-left: 3px solid #d05353; background: #1c1f25;
    padding: .6rem .9rem; margin-bottom: 1.5rem;
  }
`;

function authorizePage(params, error) {
  // Every parameter of the request comes back on the submit, so the POST is
  // checked against the same authorization request the GET was.
  const hidden = [
    'response_type',
    'client_id',
    'redirect_uri',
    'state',
    'code_challenge',
    'code_challenge_method',
  ]
    .map((name) => `<input type="hidden" name="${name}" value="${escapeHtml(params.get(name) ?? '')}">`)
    .join('\n      ');

  const checkboxes = FEATURES.map(
    ([value, label]) => `
        <label class="check">
          <input type="checkbox" name="features" value="${value}">
          <span>${label} <code>${value}</code></span>
        </label>`,
  ).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in — local Destiny stand-in</title>
  <style>${STYLE}</style>
</head>
<body>
  <main>
    <h1>Local Destiny stand-in</h1>
    <p class="lede">Not destiny.gg. This is <strong>dev/dgg-oauth</strong>, and it signs the local
      room in as whoever you describe here.</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <form method="post" action="/oauth/authorize">
      ${hidden}
      <label class="field">
        <span>Username</span>
        <input type="text" name="username" required autofocus autocomplete="off" placeholder="StrawWaffle">
        <small>A name in ADMIN_DGG_USERNAMES signs in as an admin, the same as on the real site.</small>
      </label>
      <label class="field">
        <span>Destiny user id</span>
        <input type="text" name="userId" autocomplete="off" placeholder="derived from the username">
        <small>The account identity. Leave it blank for a stable id derived from the username,
          or paste an existing users.dgg_user_id to sign in as that row.</small>
      </label>
      <fieldset>
        <legend>Features</legend>${checkboxes}
        <label class="field" style="margin: .8rem 0 0">
          <span>Others</span>
          <input type="text" name="extraFeatures" autocomplete="off" placeholder="flair1, flair13">
          <small>Comma separated. The ones that colour a username are listed in src/server/flair.ts.</small>
        </label>
      </fieldset>
      <label class="field">
        <span>Roles</span>
        <input type="text" name="roles" value="USER" autocomplete="off">
        <small>Stored on the account and shown on the admin page. The room grants nothing from them.</small>
      </label>
      <button type="submit">Sign in</button>
    </form>
  </main>
</body>
</html>`;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** Destiny accepts only these, and refusing anything else keeps the room honest. */
function authorizeError(params) {
  if (params.get('client_id') !== CLIENT_ID) return 'Unknown client_id.';
  if (params.get('response_type') !== 'code') return 'response_type must be code.';
  if (params.get('code_challenge_method') !== 'S256') return 'code_challenge_method must be S256.';
  if (!params.get('code_challenge')) return 'code_challenge is required.';
  if (!params.get('redirect_uri')) return 'redirect_uri is required.';
  return null;
}

function dropExpiredCodes() {
  const now = Date.now();
  for (const [code, grant] of codes) if (grant.expiresAt <= now) codes.delete(code);
}

function handleAuthorizePost(form, response) {
  const error = authorizeError(form);
  if (error) return sendHtml(response, 400, authorizePage(form, error));

  const username = (form.get('username') ?? '').trim();
  if (!username) return sendHtml(response, 400, authorizePage(form, 'A username is required.'));

  const identity = {
    nick: username,
    username,
    userId: (form.get('userId') ?? '').trim() || derivedUserId(username),
    status: 'Active',
    createdDate: new Date().toISOString(),
    roles: splitList(form.get('roles')),
    features: [...form.getAll('features'), ...splitList(form.get('extraFeatures'))],
    subscription: null,
  };

  const code = randomBytes(24).toString('hex');
  codes.set(code, {
    identity,
    codeChallenge: form.get('code_challenge'),
    redirectUri: form.get('redirect_uri'),
    expiresAt: Date.now() + CODE_TTL_MS,
  });

  // Destiny appends to the registered redirect rather than replacing it.
  const target = new URL(form.get('redirect_uri'));
  target.searchParams.set('code', code);
  target.searchParams.set('state', form.get('state') ?? '');
  response.writeHead(302, { location: target.toString(), 'cache-control': 'no-store' });
  response.end();
}

function handleToken(params, response) {
  const code = params.get('code') ?? '';
  const grant = codes.get(code);
  // Single use, the way the real one is.
  codes.delete(code);

  const valid =
    grant !== undefined &&
    params.get('grant_type') === 'authorization_code' &&
    params.get('client_id') === CLIENT_ID &&
    params.get('redirect_uri') === grant.redirectUri &&
    codeChallengeFor(params.get('code_verifier') ?? '') === grant.codeChallenge;

  if (!valid) return sendJson(response, 400, { error: 'invalid_grant' });

  const accessToken = randomBytes(24).toString('hex');
  tokens.set(accessToken, grant.identity);
  sendJson(response, 200, {
    access_token: accessToken,
    refresh_token: randomBytes(24).toString('hex'),
    expires_in: 3600,
    scope: 'identify',
    token_type: 'bearer',
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  dropExpiredCodes();

  if (url.pathname === '/health') return sendJson(response, 200, { status: 'ok' });

  if (url.pathname === '/oauth/authorize' && request.method === 'GET') {
    const error = authorizeError(url.searchParams);
    return sendHtml(response, error ? 400 : 200, authorizePage(url.searchParams, error));
  }

  if (url.pathname === '/oauth/authorize' && request.method === 'POST') {
    return handleAuthorizePost(new URLSearchParams(await readBody(request)), response);
  }

  if (url.pathname === '/oauth/token') return handleToken(url.searchParams, response);

  if (url.pathname === '/api/userinfo') {
    const identity = tokens.get(url.searchParams.get('token') ?? '');
    return identity
      ? sendJson(response, 200, identity)
      : sendJson(response, 400, { error: 'invalid_token' });
  }

  sendJson(response, 404, { error: 'not_found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Local Destiny stand-in listening on http://localhost:${PORT}`);
});
