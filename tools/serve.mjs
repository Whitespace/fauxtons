// Static file server for local development; disables caching so edits show up on reload. It also saves
// lamp layouts: a PUT of JSON to /layouts/<count>.json writes that file (see Save in the page). Other
// sites can't do that from a browser, as a PUT needs a CORS preflight, which this server never grants.
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.PORT ?? 8000);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
const LAYOUT = /^\/layouts\/\d{1,3}\.json$/;
const MAX_LAYOUT_BYTES = 1 << 20;

async function saveLayout(request, response, path) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_LAYOUT_BYTES) return response.writeHead(413).end();
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    JSON.parse(text);
  } catch {
    return response.writeHead(400).end();
  }
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  response.writeHead(204).end();
}

createServer(async (request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (request.method === 'PUT') {
    if (!LAYOUT.test(path)) return response.writeHead(405).end();
    return saveLayout(request, response, path);
  }
  const file = join(root, normalize(path === '/' ? '/index.html' : path));
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': types[extname(file)] ?? 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => console.log(`http://localhost:${port}`));
