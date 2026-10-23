import {h,avatar,appLauncher,toast} from '/ai-tlt/ui/v1/components.js';
import {api} from '/ai-tlt/ui/v1/api.js';
export function header(me){
 const perms=me.permissions||[];const allows=p=>perms.includes(p)||perms.includes(p.replace(':access',':manage'));
 const links=[['EXPOSITION','/#/exposition'],['LOCKER','/#/locker'],['CODEX','/codex.html','codex:access'],['TOOLS','/tools.html','studio:access'],['GALLERY','/#/gallery']];
 const profile=h('a',{class:'al-profile-link',href:'/#/profile','aria-label':'Your profile'},avatar(me.account.avatarUrl,me.account.displayName,'sm'),h('span',{text:me.account.displayName}),h('span',{class:'al-profile-mobile-label',text:'PROFILE'}));
 const launcher=me.canSwitchApps===true?appLauncher(me.apps||[],{currentApp:'artistlockers'}):null;
 return h('header',{class:'al-header'},h('a',{class:'al-wordmark',href:'/',text:'ARTIST LOCKERS'}),
  h('nav',{'aria-label':'Artist Lockers'},...links.map(([name,href,permission])=>permission&&!allows(permission)?h('span',{class:'al-nav-disabled',text:name,title:'This tool is not assigned to your account','aria-disabled':'true'}):h('a',{href,text:name})),profile),
  h('div',{class:'al-header-extras'},launcher,h('button',{class:'al-signout',type:'button',text:'Sign out',onClick:async()=>{try{await api.post('/auth/signout');location.replace('/');}catch(error){toast(error.message||'Sign-out failed. Please try again.','error');}}})));
}
export function sections(items,current){return h('nav',{class:'al-sections','aria-label':'Section'},items.map(([label,href,key])=>h('a',{href,text:label,'aria-current':key===current?'page':undefined})));}
