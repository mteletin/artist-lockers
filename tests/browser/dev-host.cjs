const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {pathToFileURL}=require('node:url');
const engine=require(process.env.PLAYWRIGHT_PACKAGE||'playwright')[process.env.ARTISTLOCKERS_BROWSER||'chromium'];
(async()=>{
 const {createDevServer}=await import(pathToFileURL(path.resolve(__dirname,'../../dev/server.mjs')));
 const server=createDevServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const browser=await engine.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[],external=[],unexpected=[];
 const out=path.resolve(process.env.ARTISTLOCKERS_SCREENSHOTS||path.join(__dirname,'../../artifacts/dev-host'));fs.mkdirSync(out,{recursive:true});
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',response=>{if(response.status()>=400&&response.url().includes('/api/')&&!(response.status()===401&&response.url().endsWith('/api/v1/me')))unexpected.push(response.url()+': '+response.status());});
 await page.route('**/*',route=>{if(/^https?:/.test(route.request().url())&&!route.request().url().startsWith(base+'/')){external.push(route.request().url());return route.abort();}return route.continue();});
 const set=body=>page.evaluate(async body=>{const response=await fetch('/__dev/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw new Error('Controls failed');},body);
 try{
  await page.goto(base+'/#/profile');await page.getByLabel('About you').fill('An edited mock biography.');await page.getByRole('button',{name:'Save profile',exact:true}).click();await page.getByText('Profile saved',{exact:true}).waitFor();await page.reload();await page.getByLabel('About you').waitFor();assert.equal(await page.getByLabel('About you').inputValue(),'An edited mock biography.');
  await page.getByRole('tab',{name:/^Artists/}).click();await page.getByRole('button',{name:'Add artist',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByLabel('Name',{exact:true}).fill('Moss Radio');await dialog.getByRole('button',{name:'Create artist',exact:true}).click();await page.getByRole('heading',{name:'Moss Radio',exact:true}).waitFor();
  await page.goto(base+'/#/gallery');await page.getByRole('button',{name:'Open Silver fields.mp4',exact:true}).click();await page.locator('dialog video').evaluate(async video=>{await video.play();video.pause();});assert((await page.locator('dialog video').evaluate(v=>v.duration))>0);await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
  await page.goto(base+'/codex.html');await page.locator('#cxTitle').waitFor({state:'visible'});await page.locator('#cxTitle').fill('The Ochre Coast');await page.locator('#cxEditor .tiptap').fill('An edited world in the mock host.');await page.waitForResponse(r=>r.url().includes('/api/codex/pages/')&&r.request().method()==='PUT'&&r.status()===200);await page.reload();await page.locator('#cxTitle').waitFor({state:'visible'});assert.equal(await page.locator('#cxTitle').inputValue(),'The Ochre Coast');
  await page.locator('#cxViewBoard').click();await page.locator('#cxBoard').waitFor({state:'visible'});
  for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:900});
   for(const [name,url,ready] of [['profile','/#/profile','.al-profile-tabs'],['gallery','/#/gallery','.app-thumb'],['video','/tools.html#h3','#h3Form'],['image','/tools.html#image','#imgForm'],['remaster','/tools.html#remaster','.tools-job-card'],['codex','/codex.html','#cxTitle']]){
    await page.goto(base+url);await page.locator(ready).first().waitFor({state:'visible'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),name+' overflows at '+width);
    if(width===390)await page.screenshot({path:path.join(out,name+'-mobile.png')});
   }
  }
  await set({persona:'member'});await page.goto(base+'/tools.html#h3');await page.locator('#h3Model option').filter({hasText:'Add your API key'}).waitFor({state:'attached'});assert(await page.locator('#h3Submit').isDisabled());
  await page.locator('#toolsSubtabs [data-tool=ai]').click();await page.locator('#apiKeyAdd').click();await page.locator('#apiKeyAddForm input[name=key]').fill('demo-seevio-key');await page.locator('#apiKeyAddForm button[type=submit]').click();await page.locator('#toolsSubtabs [data-tool=h3]').click();await page.locator('#h3Model option[value="seedance-2-5"]').waitFor({state:'attached'});assert.equal(await page.locator('#h3Model option[value="minimax-h3"]').count(),0);
  await set({scenario:'empty'});await page.goto(base+'/#/gallery');await page.getByText('No media yet',{exact:true}).waitFor();
  assert.deepEqual(unexpected,[]);await set({scenario:'error'});await page.reload();await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').textContent(),/Simulated service outage/);assert(unexpected.length>0&&unexpected.every(item=>item.endsWith(': 503')));unexpected.length=0;
  await set({persona:'signed-out',scenario:'normal'});await page.goto(base+'/');await page.getByRole('link',{name:'Sign in',exact:true}).waitFor();assert.equal(await page.getByRole('navigation').count(),0);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(unexpected,[]);
  console.log('PASS: isolated mock host, real UI edits, media playback, Codex autosave, role/key controls, failures, and desktop/mobile layouts; no external requests.');
 }catch(error){await page.screenshot({path:path.join(out,'failure.png')});console.error({errors,external,unexpected});throw error;}
 finally{await browser.close();server.closeAllConnections();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
