import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { resolve, relative, extname, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const port = Number(process.env.ARMTD_PORT || 5500);
const url = `http://127.0.0.1:${port}/`;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
const insideRoot = path => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); };
const server = createServer(async (req, res) => {
  const fail = (code, message) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(message); };
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); return fail(405, 'Method not allowed'); }
  try {
    const pathname = decodeURIComponent(new URL(req.url, url).pathname);
    const parts = pathname.replaceAll('\\', '/').split('/');
    if (parts.some(part => part.startsWith('.') || part.includes(':') || part.includes('\0'))) return fail(403, 'Forbidden');
    const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!insideRoot(path) || !types[extname(path).toLowerCase()]) return fail(403, 'Forbidden');
    const canonical = await realpath(path);
    if (!insideRoot(canonical)) return fail(403, 'Forbidden');
    const info = await stat(canonical);
    if (!info.isFile()) return fail(404, 'Not found');
    res.writeHead(200, { 'Content-Type': types[extname(path).toLowerCase()], 'Content-Length': info.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(canonical);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch (error) {
    fail(error instanceof URIError ? 400 : error.code === 'ENOENT' ? 404 : 500, 'Request failed');
  }
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `${port} portu kullanimda. Onceki oyun sunucusunu kapatin; tekrar deneyin.` : error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`ARMTD hazir: ${url}\nSunucuyu kapatmak icin Ctrl+C veya bu pencereyi kapatin.\nKayitlar bu adrese baglidir; her seferinde ayni baslaticiyi kullanin.`);
  if (process.argv.includes('--open')) {
    const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/d', '/c', 'start', '', url] : [url];
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', error => console.error(`Tarayici acilamadi: ${error.message}. Adresi elle acabilirsiniz.`));
  }
});
