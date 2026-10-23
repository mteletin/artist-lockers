import { randomUUID } from 'node:crypto';

export const owner = '11111111-1111-4111-8111-111111111111';
export const guest = '22222222-2222-4222-8222-222222222222';
export const imageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const videoId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const audioId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const pageId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const personas = ['member', 'creator', 'administrator', 'signed-out'];
export const now = () => new Date().toISOString();

export function me(state) {
  const local = state.persona === 'creator' || state.persona === 'administrator';
  const admin = state.persona === 'administrator';
  return {
    account: { id: owner, displayName: 'Rowan Vale · demo', avatarUrl: state.items.some(item => item.id === imageId) ? `/media/${imageId}` : null },
    permissions: ['artistlockers:access', 'artistlockers:host', 'codex:access', 'studio:access',
      ...(local ? ['studio:generate_local'] : []), ...(admin ? ['artistlockers:manage'] : [])],
    roles: [local ? 'al_creator' : 'al_member', ...(admin ? ['al_admin'] : [])],
    components: ['profile', 'gallery', 'studio', 'codex'], apps: [], canSwitchApps: false,
    canGenerate: true, canGenerateLocal: local, canOperate: false, isAdmin: false, writesEnabled: true,
    legacySiteUrl: '', accountsUrl: '/__dev'
  };
}

export function media(kind, filename, extra = {}) {
  const id = randomUUID();
  return { id, kind, filename, description: 'Synthetic artwork for local UI development.',
    contentType: kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/wav' : 'image/svg+xml',
    sizeBytes: 24576, width: kind === 'audio' ? null : 1024, height: kind === 'audio' ? null : 768,
    durationSeconds: kind === 'image' ? null : 4, mine: true, shared: false, published: false, kit: false,
    owner: { id: owner, displayName: 'Rowan Vale · demo' }, tags: ['demo', 'field-notes'],
    createdAt: now(), url: `/media/${id}`, posterUrl: `/media/${id}/poster`, ...extra };
}

export function job(model = 'minimax-h3', extra = {}) {
  const image = model === 'qwen-image-2.1';
  return { id: randomUUID(), ownerId: owner, kind: image ? 'image' : 'video', model,
    modelLabel: image ? 'Qwen-Image 2.1' : model.startsWith('seedance') ? 'Seedance 2.5' : 'MiniMax H3',
    status: 'completed', prompt: 'Warm light falls across a quiet silver landscape. Slow, deliberate movement.',
    idea: 'Field notes from an imagined place.', refs: [], width: 1024, height: 768, lengthFrames: 97,
    fps: 24, steps: 20, sampler: 'euler', scheduler: 'normal', seed: '9007199254740993',
    createdAt: now(), queuedAt: now(), completedAt: now(), resultSeen: false,
    resultAssetId: image ? imageId : videoId, resultUrl: `/media/${image ? imageId : videoId}`, ...extra };
}

export function createState(persona = 'creator', scenario = 'normal', delay = 0) {
  const items = [
    media('image', 'Clay and silver.svg', { id: imageId, url: `/media/${imageId}`, posterUrl: `/media/${imageId}/poster` }),
    media('video', 'Silver fields.mp4', { id: videoId, url: `/media/${videoId}`, posterUrl: `/media/${videoId}/poster` }),
    media('audio', 'A quiet signal.wav', { id: audioId, url: `/media/${audioId}`, posterUrl: `/media/${audioId}/poster` }),
    ...['Northern room', 'Ochre archive', 'The listening place', 'After the rain', 'A distant coastline'].map(name => media('image', name + '.svg')),
    media('image', 'Shared study.svg', { mine: false, shared: true, owner: { id: guest, displayName: 'Mira Stone · demo' } })
  ];
  const doc = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'A place for unfinished worlds' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'These are fictional notes. Edit this page, try the storyboard, or create a character. Everything stays in this local mock session.' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Beyond the salt flats stands a city that remembers every song sung within its walls.' }] }
  ] };
  return {
    persona, scenario, delay, requests: [], files: new Map(), bytes: 0,
    profile: scenario === 'empty' ? {} : { name: 'Rowan Vale', slug: 'rowan-vale-demo', country: 'Lebanon', bio: 'Songs, places, and small imagined worlds.\n\nThis is synthetic development data.', imageUrl: `/media/${imageId}` },
    artists: scenario === 'empty' ? [] : [{ id: randomUUID(), name: 'Rowan & The Quiet', slug: 'rowan-and-the-quiet', description: 'Fictional songs from an imagined coastline.', mainImageUrl: `/media/${imageId}`, secondaryImageUrls: [], personaIds: [] }],
    personas: scenario === 'empty' ? [] : [{ id: randomUUID(), name: 'The Cartographer', description: 'A fictional archivist mapping the places that songs leave behind.', mainImageUrl: `/media/${imageId}`, secondaryImageUrls: [], expressionImages: {} }],
    items: scenario === 'empty' ? [] : items,
    pages: scenario === 'empty' ? [] : [{ id: pageId, parentId: null, title: 'The Silver Coast', pageType: 'world', doc,
      ownerId: owner, ownerName: 'Rowan Vale · demo', access: 'owner', version: 1, sortIndex: 0, createdAt: now(), updatedAt: now(), shares: [], shots: [] }],
    jobs: scenario === 'empty' ? [] : [job('qwen-image-2.1'), job(), job('seedance-2-5', { status: 'failed', resultUrl: null, lastError: 'Synthetic provider failure. Retry to explore the recovery UI.' })],
    keys: [], remasters: scenario === 'empty' ? [] : [{ id: randomUUID(), inputFilename: 'A quiet signal.wav', status: 'completed', hasResult: true, queuedAt: now(), resultExpiresAt: new Date(Date.now() + 86400000).toISOString() }]
  };
}

export function limits(state) {
  const local = me(state).canGenerateLocal;
  const cloud = state.keys.some(key => key.isDefault && key.enabled);
  return { canGenerateLocal: local, continuationWorkers: local ? 1 : 0, workerCount: local ? 1 : 0,
    maxInFlightPerUser: 4, maxFrames: 241, minFrames: 25, frameStep: 24, dimensionStep: 32,
    maxPixels: 2097152, quotaBytesPerUser: 1073741824, usedBytes: 24576, allowRefImageSizeMax: true,
    maxImages: 4, maxVideos: 1, maxAudios: 1, fps: 24, defaultWidth: 1024, defaultHeight: 768,
    defaultLength: 97, defaultSteps: 20, defaultSampler: 'euler', defaultScheduler: 'normal',
    fusedSteps: 4, fusedSampler: 'euler', fusedScheduler: 'normal', samplers: ['euler', 'res_multistep'], schedulers: ['normal', 'beta'],
    image: local ? { model: 'qwen-image-2.1', label: 'Qwen-Image 2.1', sizes: { 1024: { '1:1': [1024,1024], '16:9': [1344,768], '9:16': [768,1344], '4:3': [1152,864], '3:4': [864,1152] } },
      samplers: ['euler'], schedulers: ['normal'], defaultSampler: 'euler', defaultScheduler: 'normal', defaultSteps: 20, defaultCfg: 4, maxVariants: 4, maxRefs: 4 } : null,
    models: [
      { id: 'minimax-h3', kind: 'video', label: 'MiniMax H3', provider: 'local', advisor: 'h3-r2v', enabled: local, supportsSeed: true, maxImages: 4, maxVideos: 1, maxAudios: 1 },
      { id: 'qwen-image-2.1', kind: 'image', label: 'Qwen-Image 2.1', provider: 'local', advisor: 'qwen-image', enabled: local, maxImages: 4 },
      ...(cloud ? [{ id: 'seedance-2-5', kind: 'video', label: 'Seedance 2.5', provider: 'seevio', advisor: 'seedance', enabled: true,
        supportsSeed: false, minSeconds: 4, maxSeconds: 30, defaultSeconds: 5, aspects: ['16:9','9:16','1:1','4:3','3:4'],
        resolutions: ['480p','720p','1080p'], defaultResolution: '720p', maxImages: 30, maxVideos: 10, maxAudios: 10 }] : [])
    ] };
}

export function tick(state) {
  for (const item of [...state.jobs, ...state.remasters]) {
    if (!item.mockStarted || ['completed','cancelled','failed'].includes(item.status)) continue;
    const elapsed = Date.now() - item.mockStarted;
    item.status = elapsed > 1600 ? 'completed' : elapsed > 400 ? 'running' : 'queued';
    item.progressValue = Math.min(100, Math.floor(elapsed / 16)); item.progressMax = 100;
    if (item.status !== 'completed') continue;
    item.completedAt = now();
    if ('inputFilename' in item) { item.hasResult = true; continue; }
    const asset = media(item.kind, 'Mock render ' + state.items.length + (item.kind === 'image' ? '.svg' : '.mp4'));
    state.items.unshift(asset); item.resultAssetId = asset.id; item.resultUrl = asset.url;
  }
}

export function artwork(id) {
  const palette = [['#dad7d0','#af7857','#4d5556'],['#d7d8d6','#777d7b','#c6956d'],['#dfd8ca','#9b6a4b','#555654']];
  const [paper,clay,ink] = palette[[...id].reduce((sum,c) => sum + c.charCodeAt(0),0) % palette.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768" viewBox="0 0 1024 768"><rect width="1024" height="768" fill="${paper}"/><path d="M0 560 340 220 650 560 850 350 1024 520V768H0" fill="${clay}"/><circle cx="760" cy="220" r="105" fill="${ink}"/><path d="M0 620H1024M0 650H1024" stroke="${paper}" stroke-width="2"/><text x="48" y="710" font-family="sans-serif" font-size="18" letter-spacing="5" fill="${paper}">ARTIST LOCKERS / DEMO STUDY</text></svg>`;
}

export function audio() {
  const rate = 16000, samples = rate * 4, buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8,4); buffer.write('WAVEfmt ',8); buffer.writeUInt32LE(16,16);
  buffer.writeUInt16LE(1,20); buffer.writeUInt16LE(1,22); buffer.writeUInt32LE(rate,24); buffer.writeUInt32LE(rate * 2,28);
  buffer.writeUInt16LE(2,32); buffer.writeUInt16LE(16,34); buffer.write('data',36); buffer.writeUInt32LE(samples * 2,40);
  for (let i=0;i<samples;i++) buffer.writeInt16LE(Math.round(Math.sin(i / rate * Math.PI * 440) * 1800 * Math.sin(Math.PI * i / samples) ** 2),44+i*2);
  return buffer;
}
