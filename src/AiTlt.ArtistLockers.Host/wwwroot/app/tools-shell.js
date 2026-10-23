import {api} from '/ai-tlt/ui/v1/api.js';
import {header} from './header.js';
try {
 const me=await api.get('/api/v1/me');document.querySelector('#alHeader').replaceChildren(header(me));
 if(typeof window.loadAccountTools==='function')window.loadAccountTools();
 if(me.canOperate){const nav=document.querySelector('#toolsSubtabs');const link=document.createElement('a');link.className='tools-subtab';link.href='/#/tools/admin';link.textContent='Operations';nav.append(link);}
 const raw=sessionStorage.getItem('artistlockers:gen-handoff');sessionStorage.removeItem('artistlockers:gen-handoff');
 if(raw){const handoff=JSON.parse(raw);const kind=handoff.kind==='image'?'image':'video';const load=await window.MvGen.whenComposer(kind);if(load){window.selectToolTab(kind==='image'?'image':'h3');load(handoff.job,handoff.options||{});}}
} catch(error) {if(error.status===401)location.replace('/auth/signin?returnUrl='+encodeURIComponent(location.pathname+location.hash));else document.querySelector('#toolsPageStatus').textContent='Tools could not be opened. Please refresh.';}
