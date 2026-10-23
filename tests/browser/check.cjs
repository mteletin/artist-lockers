const http=require('http'),fs=require('fs'),path=require('path'),assert=require('assert');
const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const root=path.resolve(__dirname,'../../src/AiTlt.ArtistLockers.Host/wwwroot'),out=path.resolve(process.env.ARTISTLOCKERS_SCREENSHOTS || path.join(__dirname,'../../artifacts/browser'));
fs.mkdirSync(out,{recursive:true});
const me={account:{id:'11111111-1111-1111-1111-111111111111',displayName:'Rowan Vale',avatarUrl:null},permissions:['artistlockers:access','codex:access','studio:access','studio:manage'],apps:[{id:'artistlockers',name:'Artist Lockers',url:'/'},{id:'mobvision',name:'Mobvision',url:'https://mobvision.eu/'}],canGenerate:true,canOperate:true,writesEnabled:true,roles:[]};
const image={model:'qwen-image',label:'Qwen Image',sizes:{1024:{'1:1':[1024,1024],'16:9':[1344,768]}},samplers:['euler'],schedulers:['normal'],defaultSampler:'euler',defaultScheduler:'normal',defaultSteps:20,defaultCfg:4,maxVariants:4,maxRefs:4};
const limits={continuationWorkers:1,models:[{id:'minimax-h3',label:'MiniMax H3',kind:'video',enabled:true,provider:'local',maxImages:4,maxAudios:1,maxVideos:1}],image,defaultWidth:768,defaultHeight:448,maxPixels:1048576,minFrames:25,maxFrames:241,frameStep:24,defaultLength:121,fps:24,samplers:['euler'],schedulers:['normal'],defaultSampler:'euler',defaultScheduler:'normal',defaultSteps:20,maxInFlightPerUser:4,maxImages:4,maxAudios:1,maxVideos:1,defaultCfg:6};
const aid='22222222-2222-2222-2222-222222222222';const now=new Date().toISOString();
const vid='33333333-3333-3333-3333-333333333333';let signed=true,posted=[],pages=[];const unknown=[];
const item={id:aid,filename:'Clay study.png',kind:'image',contentType:'image/png',sizeBytes:12200,mine:true,shared:false,published:false,tags:['study'],createdAt:now,width:1024,height:1024,url:'/media/'+aid};
const server=http.createServer(async(req,res)=>{const u=new URL(req.url,'http://localhost');function json(value,status=200){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}
if(req.method!=='GET'){let body='';for await(const chunk of req)body+=chunk;posted.push({path:u.pathname,method:req.method,headers:req.headers,body});if(u.pathname==='/api/v1/profile')return json(JSON.parse(body));
if(u.pathname.startsWith('/api/codex/pages/')&&req.method==='PUT'){const data=JSON.parse(body);const doc={...data,id:u.pathname.split('/')[4],version:data.version+1,ownerId:me.account.id,access:'owner',updatedAt:now};pages=[doc];return json(doc);}
if(u.pathname==='/auth/signout'){signed=false;return json({signedOut:true});}if(u.pathname==='/api/v1/tools/jobs')return json({id:'job-new',status:'queued'});if(u.pathname.endsWith('/frames'))return json({item,created:true});if(u.pathname.endsWith('/prompt/summarize'))return json({summary:'A quiet landscape.'});return json({});}
if(u.pathname==='/api/v1/me')return json(me,signed?200:401);
if(u.pathname==='/api/v1/profile')return json({name:'Rowan Vale',slug:'rowan-vale',bio:'Songs, places and small imagined worlds.',country:'Lebanon'});
if(u.pathname==='/api/v1/profile/artists')return json({items:[{id:aid,name:'Rowan',description:'Music and stories',personaIds:[]}]});
if(u.pathname==='/api/v1/profile/personas')return json({items:[]});
if(u.pathname.endsWith('/frames'))return json({frameCount:48,lastFrame:47,fps:24,durationSeconds:2,width:768,height:448});
if(u.pathname.endsWith('/summary'))return json({total:1,days:[{day:now.slice(0,10),count:1}],tags:['study']});
if(/^\/api\/v1\/library\/(mine|shared)$/.test(u.pathname))return json({items:u.searchParams.get('kind')==='video'?[{...item,id:vid,kind:'video',filename:'Silver fields.mp4',url:'/media/'+vid}]:[item],hasMore:false});
if(u.pathname.endsWith('/generation'))return json({job:{id:'job-one',kind:u.pathname.includes(vid)?'video':'image',model:u.pathname.includes(vid)?'minimax-h3':'qwen-image',lengthFrames:121,width:768,height:448,modelLabel:'Qwen Image',prompt:'Clay and silver',refs:[],status:'completed',seed:'9007199254740993',width:1024,height:1024,createdAt:now},missingRefs:[]});
if(u.pathname==='/api/v1/tools/limits')return json(limits);
if(u.pathname==='/api/v1/tools/state')return json({queue:{segments:[]},jobs:[],shelf:[]});
if(u.pathname==='/api/v1/tools/keys')return json({providers:[],keys:[]});
if(u.pathname==='/api/codex/access')return json({allowed:true,staff:true});
if(u.pathname==='/api/codex')return json({pages,userId:me.account.id,pageTypes:['page','character','scene']});
if(/^\/api\/codex\/pages\/[^/]+$/.test(u.pathname))return json({page:pages[0],access:'owner',anchors:[],backlinks:[],shots:[]});
if(u.pathname.endsWith('/gen-jobs'))return json([]);
if(u.pathname.endsWith('/coverage'))return json({pages:[],total:0,covered:0,pending:0});
if(u.pathname==='/api/codex/team')return json({canCreateTasks:false,roles:[],team:[]});
if(u.pathname.startsWith('/media/')){res.writeHead(200,{'Content-Type':'image/svg+xml'});return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#b98b70"/><rect x="190" y="190" width="644" height="644" fill="#d6c8b7"/><circle cx="512" cy="512" r="210" fill="#8d6650"/></svg>');}
if(u.pathname.startsWith('/api/')){unknown.push(u.pathname);return json({error:'Unexpected fixture request'},404);}
const file=path.resolve(root,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}const type={'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream';res.writeHead(200,{'Content-Type':type});fs.createReadStream(file).pipe(res);
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
signed=false;await page.goto(base);await page.getByRole('link',{name:'Sign in',exact:true}).waitFor();assert(!await page.getByRole('navigation').count());await page.screenshot({path:path.join(out,'landing.png')});
signed=true;await page.goto(base+'/#/exposition');await page.reload();await page.getByText('A space for finished work.').waitFor();await page.screenshot({path:path.join(out,'exposition.png')});
await page.goto(base+'/#/profile');await page.getByText('Your profile',{exact:true}).waitFor();assert.equal(await page.locator('textarea').inputValue(),'Songs, places and small imagined worlds.');await page.getByRole('button',{name:'Save profile',exact:true}).click();await page.getByText('Profile saved',{exact:true}).waitFor();await page.getByRole('button',{name:'Add artist',exact:true}).click();await page.getByRole('dialog').waitFor();assert.equal(await page.getByRole('dialog').evaluate(el=>getComputedStyle(el).borderRadius),'0px');await page.screenshot({path:path.join(out,'profile-dialog.png')});await page.keyboard.press('Escape');
await page.goto(base+'/#/gallery');await page.getByRole('button',{name:'Open Clay study.png',exact:true}).click();await page.getByRole('button',{name:'Repeat',exact:true}).waitFor();await page.screenshot({path:path.join(out,'gallery.png')});await page.getByRole('button',{name:'Repeat',exact:true}).click();await page.waitForURL('**/tools.html#image');await page.locator('#imgStudio').waitFor({state:'visible'});assert.equal(await page.locator('#imgPrompt').inputValue(),'Clay and silver');
await page.goto(base+'/tools.html#h3');await page.locator('#h3Form').waitFor({state:'visible'});await page.screenshot({path:path.join(out,'tools.png')});await page.locator('#h3Prompt').fill('Silver fields at sunrise');await page.locator('#h3Advanced summary').click();await page.locator('#h3Seed').fill('9007199254740993');await page.locator('#h3Form').evaluate(form=>form.requestSubmit());await page.waitForTimeout(300);assert(posted.some(p=>p.path==='/api/v1/tools/jobs'&&p.headers['x-aitlt-request']==='1'));
assert.equal(JSON.parse(posted.find(p=>p.path==='/api/v1/tools/jobs').body).seed,'9007199254740993');await page.locator('#toolsSubtabs [data-tool=image]').click();await page.locator('#imgForm').waitFor({state:'visible'});await page.screenshot({path:path.join(out,'image-tools.png')});
await page.goto(base+'/#/gallery?kind=video');await page.getByRole('button',{name:'Open Silver fields.mp4',exact:true}).click();await page.getByRole('button',{name:'Save a frame',exact:true}).click();await page.getByRole('button',{name:'Extend+',exact:true}).click();await page.waitForURL('**/tools.html#h3');await page.locator('#h3ContNote').waitFor({state:'visible'});
await page.goto(base+'/codex.html');await page.locator('#cxContent').waitFor({state:'visible'});await page.locator('#cxNewPage').click();await page.locator('#cxPageTitle').fill('A silver world');await page.locator('#cxPageSubmit').click();await page.locator('#cxTitle').waitFor({state:'visible'});assert.equal(await page.locator('#cxTitle').inputValue(),'A silver world');
await page.locator('#cxEditor .tiptap').fill('The first notes of an imagined world.');
await page.waitForTimeout(1800);
assert(posted.some(p=>p.path.startsWith('/api/codex/pages/')&&p.headers['x-aitlt-request']==='1'&&p.body.includes('The first notes')));
await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(out,'codex.png')});

await page.setViewportSize({width:390,height:844});await page.goto(base+'/#/profile');await page.getByText('Your profile',{exact:true}).waitFor();await page.screenshot({path:path.join(out,'profile-mobile.png')});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
for(const [name,url] of [['tools-mobile','/tools.html#h3'],['codex-mobile','/codex.html']]){await page.goto(base+url);await page.locator('.al-header').waitFor();await page.waitForTimeout(300);await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(out,name+'.png')});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),name+' overflows');}
console.log(JSON.stringify({errors,unknown,posted:posted.map(p=>({path:p.path,csrf:p.headers['x-aitlt-request']}))}));assert.deepEqual(errors,[]);assert.deepEqual(unknown,[]);
}catch(e){console.error('Browser errors',errors,'Unknown',unknown);await page.screenshot({path:path.join(out,'failure.png')});throw e;}finally{await browser.close();server.close();}})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
