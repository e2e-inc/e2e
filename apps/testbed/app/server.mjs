/**
 * Playground app for dogfooding the e2e runner. No dependencies. The pages
 * live under `pages/` by group; this file serves them, the API, and the
 * cookie session. Any other path goes to the routes of the tests ported from
 * Playwright (`playwright/`).
 */

import { createServer } from 'node:http';
import { layout } from './layout.mjs';
import { pages } from './pages/index.mjs';
import { playwrightRoutes } from './playwright/routes.mjs';

const PORT = Number(process.env.PORT ?? 4271);
const playwright = playwrightRoutes(PORT);

/** Who can sign in. `reviewer` is there for tests that sign two users in at once. */
const USERS = { admin: 'admin-pass', reviewer: 'reviewer-pass' };

/** The notes of each room, by its id: what everyone with the room open sees. */
const rooms = new Map();

/** The signed-in user the request's cookie names, or undefined for a guest. */
function signedIn(request) {
  const { session } = parseCookies(request);
  return Object.hasOwn(USERS, session ?? '') ? session : undefined;
}

function parseCookies(request) {
  const header = request.headers.cookie ?? '';
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim().split('='))
      .filter((pair) => pair.length === 2),
  );
}

/** One page's document: its content rendered for `request`, in the shared layout. */
function render(path, request = {}) {
  const { title, body } = pages[path](request);
  return layout(title, body);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  const send = (status, headers, body) => {
    response.writeHead(status, headers);
    response.end(body);
  };
  const html = (body) => send(200, { 'content-type': 'text/html; charset=utf-8' }, body);

  if (url.pathname === '/api/users') {
    send(
      200,
      { 'content-type': 'application/json' },
      JSON.stringify([{ name: 'Ada' }, { name: 'Grace' }, { name: 'Margaret' }]),
    );
    return;
  }
  if (url.pathname === '/files/report.csv') {
    send(
      200,
      { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' },
      'id,name\n1,Ada\n2,Grace\n',
    );
    return;
  }
  if (url.pathname === '/login' && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const params = new URLSearchParams(body);
    const username = params.get('username') ?? '';
    if (Object.hasOwn(USERS, username) && params.get('password') === USERS[username]) {
      send(303, { 'set-cookie': `session=${username}; Path=/; HttpOnly`, location: '/dashboard' });
    } else {
      html(render('/login', { failed: true }));
    }
    return;
  }
  if (url.pathname === '/logout') {
    send(303, { 'set-cookie': 'session=; Path=/; Max-Age=0', location: '/login' });
    return;
  }
  if (url.pathname === '/dashboard') {
    const user = signedIn(request);
    if (user === undefined) {
      send(303, { location: '/login' });
      return;
    }
    html(render('/dashboard', { user }));
    return;
  }
  if (url.pathname === '/room') {
    html(render('/room', { user: signedIn(request), room: url.searchParams.get('id') ?? 'lobby' }));
    return;
  }
  if (url.pathname === '/api/room') {
    const id = url.searchParams.get('id') ?? 'lobby';
    const notes = rooms.get(id) ?? [];
    rooms.set(id, notes);
    if (request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      notes.push({ author: signedIn(request) ?? 'guest', text: String(JSON.parse(body).text) });
    }
    send(200, { 'content-type': 'application/json' }, JSON.stringify(notes));
    return;
  }

  if (!(url.pathname in pages)) {
    await playwright.handle(request, response);
    return;
  }
  html(render(url.pathname));
});

server.on('upgrade', playwright.upgrade);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`playground listening on http://127.0.0.1:${PORT}`);
});
