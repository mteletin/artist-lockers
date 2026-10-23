import { randomUUID } from 'node:crypto';
import { owner, guest, imageId, now, me, media, job, limits, tick } from './fixtures.mjs';

export function fail(status, message) { throw Object.assign(new Error(message), { status }); }
const found = value => value || fail(404, 'This mock item does not exist.');
const copy = (target, body, fields) => { for (const key of fields) if (key in body) target[key] = body[key]; return target; };
const list = (items, query) => {
  const offset = Math.max(0, Number(query.get('offset')) || 0), limit = Math.min(100, Math.max(1, Number(query.get('limit')) || 60));
  return { items: items.slice(offset, offset + limit), hasMore: offset + limit < items.length };
};

export function api(state, method, url, body = {}) {
  const path = url.pathname, query = url.searchParams;
  tick(state);
  if (path === '/api/v1/me') return me(state);
  if (state.scenario === 'error') fail(503, 'Simulated service outage. Change the scenario in Developer controls to recover.');
  if (path === '/api/v1/profile') {
    if (method === 'GET') return state.profile;
    if (method === 'PUT') {
      for (const key of ['name','slug','country','bio','imageUrl']) if (body[key] && 'value' in body[key]) state.profile[key] = body[key].value;
      return state.profile;
    }
  }
  let match = path.match(/^\/api\/v1\/profile\/(artists|personas)(?:\/([^/]+))?(?:\/(personas))?$/);
  if (match) {
    const collection = state[match[1]], entity = match[2] ? found(collection.find(item => item.id === match[2])) : null;
    if (method === 'GET' && !entity) return { items: collection };
    if (method === 'DELETE' && entity) { collection.splice(collection.indexOf(entity),1); return {}; }
    if (method === 'POST' && !entity) {
      if (!body.name?.trim()) fail(400, 'Give this creative identity a name.');
      const item = { id: randomUUID(), secondaryImageUrls: [], personaIds: [], expressionImages: {}, ...body };
      collection.push(item); return item;
    }
    if (method === 'PUT' && entity) return copy(entity,body,match[3] ? ['personaIds'] : ['name','slug','description','mainImageUrl','secondaryImageUrls','expressionImages']);
  }
  match = path.match(/^\/api\/v1\/library\/(mine|shared)(?:\/(summary|[^/]+))?(?:\/(generation|share|frames))?$/);
  if (match) {
    const library = match[1], id = match[2], action = match[3];
    if (!id || id === 'summary') {
      const items = state.items.filter(item => (library === 'mine' ? item.mine : item.shared)
        && (!query.get('kind') || item.kind === query.get('kind')) && (!query.get('tag') || item.tags.includes(query.get('tag')))
        && (!query.get('from') || Date.parse(item.createdAt) >= Date.parse(query.get('from')))
        && (!query.get('to') || Date.parse(item.createdAt) < Date.parse(query.get('to'))));
      if (id === 'summary') return { total: items.length, tags: [...new Set(items.flatMap(item => item.tags))],
        days: [...new Set(items.map(item => item.createdAt.slice(0,10)))].map(day => ({ day, count: items.filter(item => item.createdAt.startsWith(day)).length })) };
      if (method === 'GET') return list(items,query);
    } else {
      const item = found(state.items.find(item => item.id === id && (library === 'mine' ? item.mine : item.shared)));
      if (action === 'generation' && method === 'GET') return { job: found(state.jobs.find(job => job.resultAssetId === id)), missingRefs: [] };
      if (action === 'share' && method === 'POST') { item.shared = true; return item; }
      if (action === 'frames') {
        if (method === 'GET') return { frameCount: 96, lastFrame: 95, fps: 24, durationSeconds: 4, width: 640, height: 480 };
        if (method === 'POST') { const frame = media('image','Saved demo frame.svg'); state.items.unshift(frame); return { item: frame, created: true }; }
      }
      if (!action && method === 'PUT') return copy(item,body,['filename','description','tags']);
      if (!action && method === 'DELETE') { state.items.splice(state.items.indexOf(item),1); const file = state.files.get(id); if (file) state.bytes -= file.bytes.length; state.files.delete(id); return {}; }
    }
  }
  if (path === '/api/v1/generations' && method === 'GET') return list(state.jobs.filter(job => (!query.get('kind') || job.kind === query.get('kind')) && (!query.get('status') || job.status === query.get('status'))),query);
  match = path.match(/^\/api\/v1\/generations\/([^/]+)$/);
  if (match && method === 'GET') return { job: found(state.jobs.find(job => job.id === match[1])), missingRefs: [] };
  if (path.startsWith('/api/v1/tools')) return tools(state,method,path.slice('/api/v1/tools'.length),body);
  if (path.startsWith('/api/codex')) return codex(state,method,path.slice('/api/codex'.length),body,query);
  fail(404, `Mock route not implemented: ${method} ${path}`);
}

function tools(state, method, path, body) {
  if (path === '/limits' && method === 'GET') return limits(state);
  if (path === '/state' && method === 'GET') return { jobs: state.jobs, shelf: state.jobs.filter(job => job.status === 'completed'),
    gpus: { cards: [], updatedAt: now() }, queue: { segments: [], workerCount: 1, maxInFlightPerUser: 4, myInFlight: 0, myStaged: 0 } };
  if (path === '/jobs' && method === 'GET') return state.jobs;
  if (path === '/jobs/shelf' && method === 'GET') return state.jobs.filter(job => job.status === 'completed');
  if (path === '/jobs' && method === 'POST') {
    const model = body.model?.trim().toLowerCase() || 'minimax-h3';
    const allowed = limits(state).models.find(item => item.id === model && item.enabled);
    if (!allowed) fail(403, model.startsWith('seedance') ? 'Add an enabled default demo key in AI zone.' : 'Local H3 and Qwen generation requires Creator access.');
    if (!body.prompt?.trim()) fail(400, 'Write a prompt first.');
    const item = job(model,{ ...body, id: randomUUID(), status: 'queued', resultUrl: null, resultAssetId: null, completedAt: null, mockStarted: Date.now() });
    state.jobs.unshift(item); return item;
  }
  if (path === '/jobs/reorder' && method === 'POST') return state.jobs;
  if (path === '/seen' && method === 'POST') { for (const item of state.jobs) item.resultSeen = true; return { cleared: state.jobs.length }; }
  let match = path.match(/^\/jobs\/([^/]+)$/);
  if (match) { const item = found(state.jobs.find(item => item.id === match[1])); if (method === 'DELETE') { item.status = 'cancelled'; return { cancelled: true }; } if (method === 'GET') return item; }
  if (path === '/prompt/advise' && method === 'POST') return { prompt: body.draft || `A cinematic study: ${body.idea || 'a quiet silver landscape'}. Soft light and natural movement.`, seed: '9007199254740993', fallback: false };
  if (path === '/prompt/summarize' && method === 'POST') return { summary: 'A quiet landscape under soft silver light.', fallback: false };
  if (path === '/refs/describe' && method === 'POST') return { description: 'Synthetic geometric landscape with clay and silver tones.', refs: [] };
  if (path === '/keys' && method === 'GET') return { providers: [{ id: 'seevio', label: 'Seevio (demo)', description: 'Use a key beginning with demo-. No provider is contacted.', keyUrl: '', maxKeys: 5 }], keys: state.keys };
  if (path === '/keys' && method === 'POST') {
    if (!body.key?.startsWith('demo-')) fail(400, 'Use a fictional key starting with demo- in this mock host.');
    if (state.keys.length >= 5) fail(400, 'The demo supports up to five key entries.');
    const item = { id: randomUUID(), provider: 'seevio', label: body.label || 'Demo key', last4: body.key.slice(-4), isDefault: !state.keys.length, enabled: true, createdAt: now(), updatedAt: now(), lastUsedAt: null, rejectedAt: null };
    state.keys.push(item); return item;
  }
  match = path.match(/^\/keys\/([^/]+)$/);
  if (match) {
    const key = found(state.keys.find(item => item.id === match[1]));
    if (method === 'DELETE') { state.keys.splice(state.keys.indexOf(key),1); return {}; }
    if (method === 'PATCH') {
      if (body.key && !body.key.startsWith('demo-')) fail(400, 'Use a fictional demo- key.');
      if (body.isDefault) for (const other of state.keys) other.isDefault = false;
      if (body.key) key.last4 = body.key.slice(-4);
      return copy(key,{ ...body, updatedAt: now() },['label','enabled','isDefault','updatedAt']);
    }
  }
  if (path === '/remaster-jobs' && method === 'GET') return state.remasters;
  match = path.match(/^\/remaster-jobs\/([^/]+)$/);
  if (match && method === 'DELETE') { found(state.remasters.find(item => item.id === match[1])).status = 'cancelled'; return {}; }
  fail(404, `Mock tool route not implemented: ${method} ${path}`);
}

function codex(state, method, path, body, query) {
  if (path === '/access') return { allowed: true, staff: true };
  if (!path && method === 'GET') return { pages: state.pages, userId: owner, pageTypes: ['page','world','story','chapter','character','place','item','faction','event'] };
  if (path === '/search') return state.pages.filter(page => page.title.toLowerCase().includes((query.get('q') || '').toLowerCase()));
  if (path === '/team') return { canCreateTasks: false, roles: [], team: [] };
  if (path === '/people') return [{ id: guest, displayName: 'Mira Stone · demo', avatarUrl: null }];
  let match = path.match(/^\/pages\/([^/]+)(?:\/(.*))?$/);
  if (!match) fail(404, `Mock Codex route not implemented: ${method} ${path}`);
  const id = match[1], action = match[2];
  let page = state.pages.find(page => page.id === id);
  if (!action && method === 'PUT') {
    if (page && Number(body.version) !== page.version) fail(409, 'This mock page changed. Reload before saving again.');
    if (!page) { page = { id, ownerId: owner, ownerName: 'Rowan Vale · demo', access: 'owner', version: 0, shares: [], shots: [], createdAt: now() }; state.pages.push(page); }
    copy(page,body,['parentId','pageType','title','doc']); page.version++; page.updatedAt = now(); return page;
  }
  found(page);
  if (!action && method === 'GET') return { page, access: 'owner', rootId: page.id, shares: page.shares, anchors: [], backlinks: [], shots: page.shots };
  if (!action && method === 'DELETE') { state.pages.splice(state.pages.indexOf(page),1); return {}; }
  if (action === 'move' && method === 'POST') { page.parentId = body.parentId || null; return page; }
  if (action === 'anchors' && method === 'GET') return [];
  if (action === 'image-brief' && method === 'POST') return { idea: body.idea || 'An illustration of '+page.title,
    refs: (body.assetIds || []).map(assetId => ({assetId,usable:state.items.some(item => item.id === assetId)})) };
  if (action === 'gen-jobs') {
    page.genJobs ||= [];
    if (method === 'POST' && !page.genJobs.includes(body.jobId)) { found(state.jobs.find(job => job.id === body.jobId)); page.genJobs.push(body.jobId); }
    return page.genJobs.map(id => state.jobs.find(job => job.id === id)).filter(Boolean).map(job => ({...job,jobId:job.id,mine:true,createdByName:'Rowan Vale · demo',error:job.lastError}));
  }
  if (action === 'coverage' && method === 'GET') return { pages: [], total: 0, covered: 0, pending: 0 };
  if (action === 'cut' && method === 'GET') return { title: page.title, pages: [{ id: page.id, title: page.title, shots: page.shots.map(shot => ({ ...shot, take: null })) }] };
  if (action === 'shares' && method === 'PUT') {
    page.shares = page.shares.filter(item => item.userId !== body.userId);
    page.shares.push({ ...body, displayName: 'Mira Stone · demo' }); return page.shares;
  }
  if (action?.startsWith('shares/') && method === 'DELETE') { page.shares = page.shares.filter(item => item.userId !== action.split('/')[1]); return page.shares; }
  if (action === 'shots' && method === 'GET') return page.shots;
  if (action === 'shots' && method === 'POST') {
    const shot = { id: body.shotId || randomUUID(), pageId: page.id, title: 'New shot', quote: '', concept: '', provider: 'h3', model: 'minimax-h3', prompt: '', prompts: {}, refs: [], cast: [], takes: [], version: 1, ...body };
    decorateShot(state,shot,body);
    page.shots.push(shot); return shot;
  }
  if (action === 'shots/order' && method === 'POST') { page.shots.sort((a,b) => body.ids.indexOf(a.id) - body.ids.indexOf(b.id)); return page.shots; }
  match = action?.match(/^shots\/([^/]+)(?:\/(.*))?$/);
  if (match) {
    const shot = found(page.shots.find(item => item.id === match[1]));
    if (!match[2] && method === 'PUT') { copy(shot,body,['title','concept','quote','provider','model','prompt','prompts','blockId','durationSeconds','aspect','lengthFrames']); decorateShot(state,shot,body); shot.version++; return shot; }
    if (!match[2] && method === 'DELETE') { page.shots.splice(page.shots.indexOf(shot),1); return {}; }
    if (match[2] === 'takes' && method === 'POST') { const source = found(state.jobs.find(job => job.id === body.jobId)); const take = { id: randomUUID(), jobId: source.id, kind: source.kind, status: source.status, resultAssetId: source.resultAssetId, tags: [], verdict: null }; shot.takes.push(take); return shot; }
  }
  fail(404, `Mock Codex route not implemented: ${method} ${path}`);
}

function decorateShot(state, shot, body) {
  if (body.castPageIds) shot.cast = body.castPageIds.map(pageId => state.pages.find(page => page.id === pageId)).filter(Boolean).map(page => ({pageId:page.id,title:page.title,pageType:page.pageType,summary:''}));
  if (body.refAssetIds) shot.refs = body.refAssetIds.map(assetId => state.items.find(item => item.id === assetId)).filter(Boolean).map(item => ({assetId:item.id,filename:item.filename,usable:true}));
}

export function upload(state, path, file, meta = {}) {
  if (path === '/api/v1/tools/remaster-jobs') {
    const item = { id: randomUUID(), inputFilename: file.name, queuedAt: now(), hasResult: false, status: 'queued', mockStarted: Date.now() };
    state.remasters.unshift(item); return item;
  }
  if (path !== '/api/v1/library/mine') fail(404, 'This mock upload route is not implemented.');
  if (!/^image\/|^audio\/|^video\//.test(file.type)) fail(415, 'Choose an image, audio or video file.');
  if (state.bytes + file.bytes.length > 32 * 1024 * 1024) fail(413, 'Mock uploads are limited to 32 MiB per session. Reset demo data to start again.');
  const item = media(file.type.split('/')[0],meta.filename || file.name,{ contentType: file.type, sizeBytes: file.bytes.length, description: meta.description || '', tags: meta.tags || [] });
  state.files.set(item.id,file); state.bytes += file.bytes.length; state.items.unshift(item); return item;
}
