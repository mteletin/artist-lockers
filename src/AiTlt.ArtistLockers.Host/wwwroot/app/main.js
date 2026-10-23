import {api,ApiError} from '/ai-tlt/ui/v1/api.js';
import {h,mount,empty} from '/ai-tlt/ui/v1/components.js';
import {ctx,currentRoute} from './util.js';
import {header,sections} from './header.js';
const root=document.querySelector('#app');let main,version=0;
async function boot(){try{ctx.me=await api.get('/api/v1/me');}catch(error){
 if(error.status===401){mount(root,h('a',{class:'al-landing-signin',href:'/auth/signin',text:'Sign in'}),h('main',{id:'main',class:'al-landing'},h('h1',{text:'ARTIST LOCKERS'})));if(new URLSearchParams(location.search).has('error'))root.append(h('p',{class:'al-signin-error',role:'status',text:'This account could not open Artist Lockers. Please check your access in Accounts.'}));return;}
 mount(root,h('main',{class:'al-landing'},h('h1',{text:'ARTIST LOCKERS'}),h('p',{role:'status',text:'Accounts is temporarily unavailable. Please try again shortly.'})));return;
 }
 ctx.isAdmin=!!ctx.me.isAdmin;ctx.legacySiteUrl='';main=h('main',{id:'main',class:'al-main',tabIndex:-1});mount(root,header(ctx.me),main,h('ait-toast'));window.addEventListener('hashchange',route);route();}
async function route(){const token=++version;const {path,params}=currentRoute();let clean;const active=()=>token===version;
 mount(main,h('p',{class:'al-loading',role:'status',text:'Loading...'}));
 try{
  if(path==='/'||path==='/exposition'){mount(main,h('section',{class:'al-exposition'},h('div',{class:'al-section-label',text:'EXPOSITION'}),h('div',{class:'al-arena','aria-label':'Exposition concept sketch'},h('div',{class:'al-plinth al-plinth-large'},h('span',{text:'01'})),h('div',{class:'al-plinth'},h('span',{text:'02'})),h('div',{class:'al-plinth'},h('span',{text:'03'}))),h('div',{class:'al-concept-caption'},h('h1',{text:'A space for finished work.'}),h('p',{text:'An exposition of music, stories and images from your Locker. This is a concept sketch; publishing comes later.'}))));return;}
  if(path==='/locker'){mount(main,h('section',{class:'al-placeholder'},h('span',{class:'al-section-label',text:'LOCKER'}),h('h1',{text:'Room to make things.'}),h('p',{text:'Your publishing workspace will take shape here. Songs, albums and illustrated stories, designed with care, then shared in Exposition.'}),h('span',{class:'al-coming',text:'PLANNED / EDITOR NOT YET AVAILABLE'})));return;}
  if(path==='/profile'){const view=await import('./views/profile.js');if(active())await view.render(main,{isCurrent:active});return;}
  if(path==='/gallery'||path==='/shared'||path==='/generations'){
   const mode=path==='/generations'?'generations':path==='/shared'?'shared':'mine';const content=h('div');mount(main,sections([['Your media','/#/gallery','mine'],['Shared','/#/shared','shared'],...(ctx.me.canGenerate?[['Generations','/#/generations','generations']]:[])],mode),content);
   if(mode==='generations'&&!ctx.me.canGenerate){mount(content,empty({title:'Generation access is not assigned'}));return;}
   const view=await import(mode==='generations'?'./views/generations.js':'./views/gallery.js');if(active())await view.render(content,{params,library:mode,isCurrent:active});return;
  }
  if(path.startsWith('/tools/')){
   const kind=path.split('/')[2];if(!ctx.me.canGenerate||kind==='admin'&&!ctx.me.canOperate){mount(main,empty({title:'This tool is not assigned to your account.'}));return;}
   if(kind!=='admin'){if(!['video','image','ai'].includes(kind))throw new Error('This page is not available.');location.replace('/tools.html#'+(kind==='video'?'h3':kind));return;}
   const content=h('div');mount(main,sections([['Video','/tools.html#h3','video'],['Image','/tools.html#image','image'],['AI zone','/tools.html#ai','ai'],['Operations','/#/tools/admin','admin']],kind),content);
   const view=await import('./views/tools-'+kind+'.js');if(active())await view.render(content,{params,isCurrent:active});return;
  }
  mount(main,empty({title:'This page is not available.'}));
 }catch(error){if(!active())return;if(error.status===401){location.reload();return;}mount(main,h('section',{class:'al-error',role:'alert'},h('h1',{text:'Unable to open this section'}),h('p',{text:error.message}),h('button',{class:'ait-btn',type:'button',text:'Try again',onClick:route})));}
}
boot();
