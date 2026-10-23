import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { api, upload, fail } from './api.mjs';
import { artwork, audio, createState, me, personas, now } from './fixtures.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const webRoot = await realpath(path.resolve(directory,'../src/AiTlt.ArtistLockers.Host/wwwroot'));
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.svg':'image/svg+xml', '.woff2':'font/woff2', '.woff':'font/woff', '.png':'image/png', '.ico':'image/x-icon', '.mp4':'video/mp4' };
const scenarios = ['normal','empty','error'];
const allowedHosts = new Set(['localhost','127.0.0.1','[::1]']);

async function readBody(req) {
  const chunks = []; let length = 0;
  const max = req.headers['content-type']?.startsWith('multipart/form-data') ? 8 * 1024 * 1024 : 1024 * 1024;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > max) { req.resume(); fail(413, 'Mock request limit exceeded (1 MiB JSON / 8 MiB upload).'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function multipart(bytes, type) {
  const boundary = type.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.slice(1).find(Boolean);
  if (!boundary || boundary.length > 200) fail(400,'Multipart boundary missing.');
  const marker = Buffer.from('--'+boundary), parts = {}; let start = bytes.indexOf(marker);
  while (start >= 0) {
    const next = bytes.indexOf(marker,start+marker.length); if (next < 0) break;
    const head = bytes.indexOf('\r\n\r\n',start); if (head < 0 || head > next) break;
    const headers = bytes.subarray(start+marker.length+2,head).toString();
    const name = headers.match(/\bname="([^"]+)"/)?.[1], filename = headers.match(/\bfilename="([^"]*)"/)?.[1];
    if (name) parts[name] = { name: path.basename(filename || name), type: headers.match(/content-type:\s*([^\r\n]+)/i)?.[1] || 'application/octet-stream', bytes: bytes.subarray(head+4,next-2) };
    start = next;
  }
  return parts;
}

function send(res, value, status = 200, type = 'application/json; charset=utf-8', range) {
  let bytes = Buffer.isBuffer(value) ? value : Buffer.from(type.startsWith('application/json') ? JSON.stringify(value) : value);
  if (range) {
    const match = range.match(/^bytes=(\d+)-(\d*)$/);
    if (!match) { res.writeHead(416,{ 'Content-Range':`bytes */${bytes.length}` }); return res.end(); }
    const start = Number(match[1]), end = Math.min(match[2] ? Number(match[2]) : bytes.length-1,bytes.length-1);
    if (start > end || start >= bytes.length) { res.writeHead(416,{ 'Content-Range':`bytes */${bytes.length}` }); return res.end(); }
    res.setHeader('Content-Range',`bytes ${start}-${end}/${bytes.length}`); bytes = bytes.subarray(start,end+1); status = 206;
  }
  res.writeHead(status,{ 'Content-Type':type, 'Content-Length':bytes.length, 'Accept-Ranges':'bytes' }); res.end(bytes);
}

export function createDevServer({ persona = 'creator', scenario = 'normal', delay = 0 } = {}) {
  if (!personas.includes(persona) || !scenarios.includes(scenario) || !Number.isInteger(delay) || delay < 0 || delay > 2000) throw new Error('Invalid mock persona, scenario or delay (0–2000 ms).');
  const sessions = new Map();
  const server = http.createServer(async (req,res) => {
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Artist-Lockers-Mock','true'); res.setHeader('Referrer-Policy','no-referrer');
    let state, url;
    try {
      url = new URL(req.url,`http://${req.headers.host || 'localhost'}`);
      if (!allowedHosts.has(url.hostname) || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) fail(403,'Mock host accepts loopback requests only.');
      if (!['GET','HEAD'].includes(req.method) && (req.headers['sec-fetch-site'] === 'cross-site'
          || req.headers.origin && req.headers.origin !== url.origin)) fail(403,'Cross-origin mock writes are refused.');
      let session = req.headers.cookie?.match(/(?:^|;\s*)al_dev_session=([a-f0-9-]+)/)?.[1];
      if (!session || !sessions.has(session)) {
        if (sessions.size >= 64) sessions.delete(sessions.keys().next().value);
        session = randomUUID(); sessions.set(session,createState(persona,scenario,delay));
        res.setHeader('Set-Cookie',`al_dev_session=${session}; Path=/; HttpOnly; SameSite=Lax`);
      }
      state = sessions.get(session);
      if (url.pathname === '/__dev') return send(res,await readFile(path.join(directory,'controls.html')),200,'text/html; charset=utf-8');
      if (url.pathname === '/__dev/banner.js') return send(res,await readFile(path.join(directory,'banner.js')),200,'text/javascript; charset=utf-8');
      if (url.pathname === '/__dev/state') {
        if (req.method === 'POST') {
          const data = JSON.parse((await readBody(req)).toString() || '{}');
          if (data.persona !== undefined && !personas.includes(data.persona) || data.scenario !== undefined && !scenarios.includes(data.scenario)
              || data.delay !== undefined && (!Number.isInteger(data.delay) || data.delay < 0 || data.delay > 2000)) fail(400,'Invalid mock scenario.');
          if (data.reset || data.scenario !== undefined && data.scenario !== state.scenario) {
            state = createState(data.persona || state.persona,data.scenario || state.scenario,data.delay ?? state.delay); sessions.set(session,state);
          } else for (const key of ['persona','scenario','delay']) if (data[key] !== undefined) state[key] = data[key];
        } else if (req.method !== 'GET') fail(405,'Use GET or POST.');
        return send(res,{ persona:state.persona, scenario:state.scenario, delay:state.delay, mock:true, requests:state.requests.slice(-30) });
      }
      if (url.pathname.startsWith('/__dev/')) fail(404,'Unknown developer control.');
      if (url.pathname === '/health/ready' || url.pathname === '/health/live') return send(res,{ status:'ready', mock:true });
      if (url.pathname === '/auth/signin') {
        state.persona = state.persona === 'signed-out' ? persona === 'signed-out' ? 'creator' : persona : state.persona;
        const target = url.searchParams.get('returnUrl') || '/';
        res.writeHead(302,{ Location:target.startsWith('/') && !target.startsWith('//') && !target.includes('\\') ? target : '/' }); return res.end();
      }
      if (url.pathname === '/auth/signout' && req.method === 'POST') { state.persona = 'signed-out'; return send(res,{}); }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) {
        if (state.persona === 'signed-out') fail(401,'Sign in to the local demo first.');
        if (state.delay) await new Promise(resolve => setTimeout(resolve,state.delay));
        if (url.pathname.startsWith('/media/') || url.pathname.startsWith('/api/codex/assets/')) {
          const id = url.pathname.split('/')[url.pathname.startsWith('/media/') ? 2 : 4];
          const item = state.items.find(item => item.id === id); if (!item) fail(404,'Mock media not found.');
          if (url.pathname.endsWith('/poster') || item.kind === 'image' && !state.files.has(id)) return send(res,artwork(id),200,'image/svg+xml');
          if (state.files.has(id)) { const file = state.files.get(id); return send(res,file.bytes,200,file.type,req.headers.range); }
          return send(res,item.kind === 'audio' ? audio() : await readFile(path.join(directory,'media/study.mp4')),200,item.kind === 'audio' ? 'audio/wav' : 'video/mp4',req.headers.range);
        }
        if (/^\/api\/v1\/tools\/remaster-jobs\/[^/]+\/result$/.test(url.pathname)) {
          const item = state.remasters.find(item => item.id === url.pathname.split('/')[5]);
          if (!item?.hasResult) fail(404,'This mock remaster is not ready.'); return send(res,audio(),200,'audio/wav',req.headers.range);
        }
        const bytes = !['GET','HEAD'].includes(req.method) ? await readBody(req) : Buffer.alloc(0);
        let result;
        if (req.headers['content-type']?.startsWith('multipart/form-data')) {
          if (state.scenario === 'error') fail(503,'Simulated service outage.');
          const parts = multipart(bytes,req.headers['content-type']), file = parts.file || parts.audio || parts.audioFile;
          if (!file) fail(400,'Choose a file.');
          result = upload(state,url.pathname,file,parts.meta ? JSON.parse(parts.meta.bytes.toString()) : {});
        } else {
          const body = bytes.length ? JSON.parse(bytes.toString()) : {};
          if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400,'Expected a JSON object.');
          result = api(state,req.method,url,body);
        }
        state.requests.push(`${req.method} ${url.pathname}`); state.requests = state.requests.slice(-30);
        return send(res,result);
      }
      if (!['GET','HEAD'].includes(req.method)) fail(405,'Only static reads are supported here.');
      if (['/tools.html','/codex.html'].includes(url.pathname) && state.persona === 'signed-out') { res.writeHead(302,{ Location:'/auth/signin?returnUrl='+encodeURIComponent(url.pathname) }); return res.end(); }
      const file = await realpath(path.resolve(webRoot,'.'+decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))).catch(() => null);
      if (!file || !file.startsWith(webRoot+path.sep) || !(await stat(file)).isFile()) fail(404,'File not found.');
      const type = mime[path.extname(file)] || 'application/octet-stream'; let content = await readFile(file);
      if (type.startsWith('text/html')) content = Buffer.from(content.toString().replace('</body>','<script type="module" src="/__dev/banner.js"></script></body>'));
      return send(res,content,200,type);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error.status || (error instanceof SyntaxError || error instanceof URIError ? 400 : 500);
      if (status === 500) console.error('Mock host error:',error);
      send(res,{ code:'mock_'+status, message:status === 500 ? 'The mock host encountered an error. Check its terminal.' : error.message },status);
    }
  });
  server.requestTimeout = 15000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options:{ port:{type:'string',default:'5088'}, persona:{type:'string',default:'creator'}, scenario:{type:'string',default:'normal'}, delay:{type:'string',default:'0'} } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a port between 1 and 65535.');
  const server = createDevServer({ persona:values.persona, scenario:values.scenario, delay:Number(values.delay) });
  server.on('error',error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Use npm run dev -- --port 5090.` : error.message); process.exitCode = 1; });
  server.listen(port,'127.0.0.1',() => console.log(`Artist Lockers UI demo: http://127.0.0.1:${port}\nControls: http://127.0.0.1:${port}/__dev\nFictional data; no databases, signing keys or external services. Ctrl+C stops the host.`));
}
