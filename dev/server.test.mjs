import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createDevServer } from './server.mjs';
import { pageId, videoId } from './fixtures.mjs';

async function start(t, options) {
  const server = createDevServer(options); server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  function client() {
    let cookie;
    return async (path, { body, method = body === undefined ? 'GET' : 'POST', headers = {}, ...rest } = {}) => {
      const form = body instanceof FormData;
      const response = await fetch(base+path,{ method, redirect:'manual', headers:{ ...(cookie ? { Cookie:cookie } : {}), ...(body !== undefined && !form ? { 'Content-Type':'application/json' } : {}), ...headers },
        ...(body !== undefined ? { body:form ? body : JSON.stringify(body) } : {}), ...rest });
      cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie;
      return response;
    };
  }
  return { base, client, call:client() };
}

test('serves real UI and bundled media with no runtime configuration; does not expose source files', async t => {
  const { call } = await start(t);
  const home = await call('/'); assert.match(await home.text(),/Artist Lockers/i); assert.equal(home.headers.get('x-artist-lockers-mock'),'true');
  assert.match(await (await call('/codex.html')).text(),/\/__dev\/banner.js/);
  for (const path of ['/README.md','/package.json','/dev/server.mjs','/..%2f..%2fREADME.md','/%E0%A4%A']) assert.ok((await call(path)).status >= 400,path);
  const video = await call(`/media/${videoId}`,{ headers:{ Range:'bytes=0-31' } });
  assert.equal(video.status,206); assert.equal((await video.arrayBuffer()).byteLength,32); assert.match(video.headers.get('content-type'),/video\/mp4/);
  assert.equal((await call(`/media/${videoId}`,{ headers:{ Range:'bytes=99999999-' } })).status,416);
});

test('browser sessions are independent; sign-out, scenario reset and recoverable failures are local', async t => {
  const { call, client } = await start(t); const other = client();
  assert.equal((await call('/api/v1/me')).status,200);
  await call('/api/v1/profile',{ method:'PUT',body:{ name:{value:'Local edit'} } });
  assert.equal((await (await call('/api/v1/profile')).json()).name,'Local edit');
  assert.equal((await (await other('/api/v1/profile')).json()).name,'Rowan Vale');
  await call('/auth/signout',{ method:'POST' }); assert.equal((await call('/api/v1/me')).status,401);
  assert.equal((await other('/api/v1/me')).status,200);
  assert.equal((await call('/auth/signin?returnUrl=//evil.test')).headers.get('location'),'/');
  await call('/__dev/state',{ body:{ scenario:'empty' } });
  assert.equal((await (await call('/api/v1/library/mine')).json()).items.length,0);
  await call('/__dev/state',{ body:{ scenario:'error' } });
  assert.equal((await call('/api/v1/profile')).status,503); assert.equal((await call('/api/v1/me')).status,200);
  await call('/__dev/state',{ body:{ scenario:'normal',reset:true } });
  assert.equal((await (await call('/api/v1/profile')).json()).name,'Rowan Vale');
  assert.equal((await call('/api/unknown')).status,404);
});

test('Member uses fictional personal keys; local models require Creator; simulated jobs produce media', async t => {
  const { call } = await start(t,{ persona:'member' });
  assert.equal((await (await call('/api/v1/me')).json()).canGenerateLocal,false);
  assert.equal((await call('/api/v1/tools/jobs',{ body:{prompt:'Study',model:'minimax-h3'} })).status,403);
  assert.equal((await call('/api/v1/tools/jobs',{ body:{prompt:'Study',model:'seedance-2-5'} })).status,403);
  assert.equal((await call('/api/v1/tools/keys',{ body:{key:'a-real-key-is-not-needed'} })).status,400);
  const key = await (await call('/api/v1/tools/keys',{ body:{provider:'seevio',key:'demo-seevio-key',label:'Preview'} })).json();
  assert.equal(key.key,undefined); assert.equal(key.last4,'-key');
  const queued = await (await call('/api/v1/tools/jobs',{ body:{prompt:'Study',model:'seedance-2-5'} })).json();
  assert.equal(queued.status,'queued');
  await new Promise(resolve => setTimeout(resolve,1700));
  const completed = await (await call('/api/v1/tools/jobs/'+queued.id)).json();
  assert.equal(completed.status,'completed'); assert.equal((await call(completed.resultUrl)).status,200);
  await call('/__dev/state',{ body:{persona:'creator'} });
  assert.equal((await call('/api/v1/tools/jobs',{ body:{prompt:'Study',model:'qwen-image-2.1'} })).status,200);
});

test('Codex edits persist, stale writes conflict, and creating/deleting pages changes the inventory', async t => {
  const { call } = await start(t);
  const initial = await (await call('/api/codex/pages/'+pageId)).json();
  assert.equal((await call('/api/codex/pages/'+pageId,{method:'PUT',body:{...initial.page,title:'New title'} })).status,200);
  assert.equal((await call('/api/codex/pages/'+pageId,{method:'PUT',body:initial.page})).status,409);
  assert.equal((await (await call('/api/codex/pages/'+pageId)).json()).page.title,'New title');
  await call('/api/codex/pages/new-page',{method:'PUT',body:{version:0,title:'A character',pageType:'character',doc:{type:'doc',content:[]}}});
  assert.equal((await (await call('/api/codex')).json()).pages.length,2);
  await call('/api/codex/pages/new-page',{method:'DELETE'});
  assert.equal((await (await call('/api/codex')).json()).pages.length,1);
});

test('uploads and remaster simulation work without storing files on disk', async t => {
  const { call } = await start(t);
  const file = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'],{type:'image/svg+xml'});
  const form = new FormData(); form.append('file',file,'New.svg'); form.append('meta',new Blob([JSON.stringify({filename:'My upload.svg',tags:['upload']})],{type:'application/json'}));
  const item = await (await call('/api/v1/library/mine',{body:form})).json();
  assert.equal(item.filename,'My upload.svg'); assert.deepEqual(item.tags,['upload']);
  assert.equal(await (await call(item.url)).text(),await file.text());
  await call('/api/v1/library/mine/'+item.id,{method:'DELETE'});
  assert.equal((await call(item.url)).status,404);
  const audio = new FormData(); audio.append('audioFile',new Blob(['synthetic source'],{type:'audio/wav'}),'Source.wav');
  const remaster = await (await call('/api/v1/tools/remaster-jobs',{body:audio})).json();
  assert.equal(remaster.status,'queued');
  await new Promise(resolve => setTimeout(resolve,1700));
  const jobs = await (await call('/api/v1/tools/remaster-jobs')).json();
  assert.equal(jobs.find(job => job.id === remaster.id).hasResult,true);
  const result = Buffer.from(await (await call('/api/v1/tools/remaster-jobs/'+remaster.id+'/result')).arrayBuffer());
  assert.equal(result.toString('ascii',0,4),'RIFF');
});

test('refuses cross-origin writes and hostile Host headers; validates control settings', async t => {
  const { call, base } = await start(t);
  assert.equal((await call('/__dev/state',{body:{persona:'member'},headers:{Origin:'https://outside.invalid'}})).status,403);
  assert.equal((await call('/__dev/state',{body:{delay:99999}})).status,400);
  const status = await new Promise(resolve => { http.get(base,{headers:{Host:'outside.invalid'}},res => { res.resume(); resolve(res.statusCode); }); });
  assert.equal(status,403);
  assert.throws(() => createDevServer({persona:'unknown'}));
});
