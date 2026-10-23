import {api} from '/ai-tlt/ui/v1/api.js';
import {h,mount,avatar,openDialog,confirmDialog,toast} from '/ai-tlt/ui/v1/components.js';
import {ctx,reportError} from '../util.js';
import {openPicker} from '../tools.js';
const base='/api/v1/profile';
const input=(value='',extra={})=>h('input',{value:value||'',...extra});
const textarea=(value='',extra={})=>{const el=h('textarea',extra);el.value=value||'';return el;};
const field=(label,control,hint)=>h('label',{class:'al-field'},h('span',{text:label}),control,hint?h('small',{text:hint}):null);
const action=(text,onClick,extra={})=>h('button',{class:'ait-btn ait-btn-sm',type:'button',text,onClick,...extra});
const mediaUrl=item=>location.origin+'/media/'+item.id;

export async function render(page,{isCurrent}){
 let profile;try{profile=await api.get(base);}catch(error){if(error.status!==404)throw error;profile={};}
 const [artists,personas]=await Promise.all([api.get(base+'/artists'),api.get(base+'/personas')]);if(!isCurrent())return;
 const name=input(profile.name,{maxLength:200,autocomplete:'nickname'}),slug=input(profile.slug,{maxLength:100}),country=input(profile.country,{maxLength:100,autocomplete:'country-name'}),bio=textarea(profile.bio,{rows:8,maxLength:8000});
 let imageUrl=profile.imageUrl||'',dirty=false,tab='profile';
 const portrait=h('div',{class:'al-profile-portrait'}),previewName=h('h2'),previewBio=h('p',{class:'al-profile-preview-bio'}),previewCountry=h('p',{class:'ait-small ait-muted'});
 const status=h('span',{class:'al-profile-status',role:'status','aria-live':'polite'});
 const submit=h('button',{class:'ait-btn ait-btn-primary',type:'submit',text:'Save profile'});
 const reset=action('Discard changes',()=>{name.value=profile.name||'';slug.value=profile.slug||'';country.value=profile.country||'';bio.value=profile.bio||'';imageUrl=profile.imageUrl||'';dirty=false;status.textContent='Changes discarded';updatePreview();});
 function updatePreview(){mount(portrait,avatar(imageUrl||ctx.me.account.avatarUrl,name.value||ctx.me.account.displayName,'lg'));previewName.textContent=name.value.trim()||ctx.me.account.displayName;previewBio.textContent=bio.value.trim()||'Your introduction will appear here.';previewCountry.textContent=country.value.trim();reset.disabled=!dirty;}
 function changed(){dirty=true;status.textContent='You have unsaved changes';status.classList.remove('is-error');updatePreview();}
 const form=h('form',{class:'al-profile-form',onSubmit:async event=>{event.preventDefault();submit.disabled=true;reset.disabled=true;for(const el of [name,slug,country,bio])el.disabled=true;status.textContent='Saving...';status.classList.remove('is-error');try{
  const saved=await api.put(base,{slugSeed:name.value.trim()||ctx.me.account.displayName,name:{value:name.value.trim()||null},slug:slug.value.trim()?{value:slug.value.trim()}:null,country:{value:country.value.trim()||null},bio:{value:bio.value.trim()||null},imageUrl:{value:imageUrl||null}});
  profile={...profile,name:name.value.trim(),slug:slug.value.trim(),country:country.value.trim(),bio:bio.value.trim(),imageUrl,...saved};slug.value=profile.slug||'';dirty=false;status.textContent='Profile saved';updatePreview();
 }catch(error){status.textContent=error.message||'Your profile could not be saved.';status.classList.add('is-error');}finally{submit.disabled=false;reset.disabled=!dirty;for(const el of [name,slug,country,bio])el.disabled=false;}}},
 h('div',{class:'al-profile-fields'},field('Display name',name,'The name shown on your creator profile.'),field('Country',country)),
 field('Profile address',slug,'Your profile address is shared across AI-TLT products.'),field('About you',bio,'Introduce your work, influences, or the worlds you are creating.'),
 h('div',{class:'al-profile-save'},submit,reset,status));
 form.addEventListener('input',changed);
 const pictureActions=h('div',{class:'al-picture-actions'},action('Choose portrait',()=>openPicker('image',item=>{imageUrl=mediaUrl(item);changed();})),action('Remove portrait',()=>{imageUrl='';changed();}));
 const preview=h('aside',{class:'al-profile-preview'},h('span',{class:'al-section-label',text:'PROFILE PREVIEW'}),portrait,previewName,previewCountry,previewBio,pictureActions);
 const profilePanel=h('section',{class:'al-profile-edit',role:'tabpanel',id:'al-profile-panel','aria-labelledby':'al-profile-tab'},h('div',{class:'al-profile-card'},h('h2',{text:'Profile details'}),h('p',{class:'al-section-intro',text:'Tell people who you are. Your profile and creative identities stay the same across your apps.'}),form),preview);
 const collections=h('section',{role:'tabpanel',id:'al-collection-panel',hidden:true});
 const tabs=h('div',{class:'al-profile-tabs',role:'tablist','aria-label':'Profile sections'});
 function redrawTabs(){mount(tabs,...[['profile','Profile'],['artists','Artists'],['personas','Personas']].map(([key,label])=>h('button',{type:'button',role:'tab',id:'al-'+key+'-tab','aria-selected':String(tab===key),'aria-controls':key==='profile'?'al-profile-panel':'al-collection-panel',tabIndex:tab===key?0:-1,text:label+(key==='profile'?'':' ('+(key==='artists'?artists:personas).items.length+')'),onClick:()=>selectTab(key)})));}
 function selectTab(key){tab=key;profilePanel.hidden=tab!=='profile';collections.hidden=tab==='profile';redrawTabs();if(tab!=='profile'){collections.setAttribute('aria-labelledby','al-'+tab+'-tab');mount(collections,collection(tab));}tabs.querySelector('[aria-selected=true]')?.focus({preventScroll:true});}
 tabs.addEventListener('keydown',event=>{const keys=['profile','artists','personas'];let index=keys.indexOf(tab);if(event.key==='ArrowRight')index=(index+1)%3;else if(event.key==='ArrowLeft')index=(index+2)%3;else if(event.key==='Home')index=0;else if(event.key==='End')index=2;else return;event.preventDefault();selectTab(keys[index]);});
 function redraw(){redrawTabs();if(tab!=='profile')mount(collections,collection(tab));}
 function collection(type){const items=(type==='artists'?artists:personas).items||[],singular=type==='artists'?'artist':'persona';
  const cards=items.map(item=>h('article',{class:'al-identity-card'},h('div',{class:'al-identity-head'},avatar(item.mainImageUrl,item.name,'lg'),h('div',{},h('h3',{text:item.name}),h('p',{class:'ait-small ait-muted',text:type==='artists'?(item.slug?'@'+item.slug:'Artist identity'):'Character / persona'}))),h('p',{class:'al-identity-description',text:item.description||'Add a description to introduce this '+singular+'.'}),
   type==='artists'?h('div',{class:'al-linked-personas'},h('span',{class:'al-section-label',text:'LINKED PERSONAS'}),h('p',{text:(item.personaIds||[]).map(id=>personas.items.find(p=>p.id===id)?.name).filter(Boolean).join(', ')||'No personas linked yet.'})):null,
   h('div',{class:'al-identity-actions'},action('Edit '+singular,()=>editEntity(type,item),{class:'ait-btn ait-btn-primary ait-btn-sm'}),type==='artists'?action('Link personas',()=>linkPersonas(item)):null,action('Archive',()=>archive(type,item),{class:'ait-btn ait-btn-ghost ait-btn-sm al-archive'}))));
  return h('div',{class:'al-collection'},h('div',{class:'al-collection-head'},h('div',{},h('h2',{text:type==='artists'?'Your artists':'Your personas'}),h('p',{class:'al-section-intro',text:type==='artists'?'Manage your stage names and creative identities. Link the personas that belong to each artist.':'Build the characters behind your work. Give each a name, description, and images.'})),action('Add '+singular,()=>editEntity(type,null),{class:'ait-btn ait-btn-primary'})),items.length?h('div',{class:'al-identity-grid'},cards):h('div',{class:'al-collection-empty'},h('h3',{text:'Create your first '+singular}),h('p',{text:type==='artists'?'Use your own name or create a stage identity.':'Give a character a place in your creative world.'}),action('Add '+singular,()=>editEntity(type,null),{class:'ait-btn'})));
 }
 async function editEntity(type,existing){const title=type==='artists'?'artist':'persona',n=input(existing?.name,{maxLength:200}),description=textarea(existing?.description,{rows:6,maxLength:8000}),s=input(existing?.slug,{maxLength:100});let mainImageUrl=existing?.mainImageUrl||null;const extraImages=[...(existing?.secondaryImageUrls||[])];
  const imagePreview=h('div',{class:'al-editor-portrait'}),extraPreview=h('div',{class:'al-extra-images'});
  function redrawImages(){mount(imagePreview,avatar(mainImageUrl,n.value||'New '+title,'lg'));mount(extraPreview,...extraImages.map((url,index)=>h('div',{class:'al-extra-image'},h('img',{src:url,alt:'Additional image '+(index+1)}),action('Remove',()=>{extraImages.splice(index,1);redrawImages();},{'aria-label':'Remove additional image '+(index+1)}))));}
  const body=h('div',{class:'al-profile-form al-identity-editor'},h('div',{class:'al-editor-picture'},imagePreview,h('div',{class:'al-picture-actions'},action('Choose image',()=>openPicker('image',item=>{mainImageUrl=mediaUrl(item);redrawImages();})),action('Remove image',()=>{mainImageUrl=null;redrawImages();}))),field('Name',n),type==='artists'?field('Address',s,'Leave blank to create an address from the name.'):null,field('Description',description),h('section',{},h('h3',{text:'Additional images'}),extraPreview,action('Add image',()=>{if(extraImages.length>=24){toast('You can keep up to 24 additional images.');return;}openPicker('image',item=>{const url=mediaUrl(item);if(!extraImages.includes(url))extraImages.push(url);redrawImages();});})));
  n.addEventListener('input',redrawImages);redrawImages();
  const saved=await openDialog({title:(existing?'Edit ':'Create ')+title,description:'Changes are shared across your apps. Nothing is saved until you confirm.',body,submitLabel:existing?'Save changes':'Create '+title,onSubmit:async()=>{if(!n.value.trim())throw new Error('Please enter a name.');const data={name:n.value.trim(),description:description.value.trim()||null,mainImageUrl,secondaryImageUrls:extraImages};if(type==='artists')data.slug=s.value.trim()||null;return existing?api.put(base+'/'+type+'/'+existing.id,data):api.post(base+'/'+type,data);}});
  if(saved){try{const data=await api.get(base+'/'+type);if(type==='artists')artists.items=data.items;else personas.items=data.items;if(isCurrent())redraw();toast((title==='artist'?'Artist':'Persona')+' saved');}catch(error){reportError(error);}}
 }
 async function archive(type,item){if(!await confirmDialog({title:'Archive '+item.name+'?',message:'This removes it from your active profile. Existing content references keep their history.',confirmLabel:'Archive'}))return;
  try{await api.del(base+'/'+type+'/'+item.id);const source=type==='artists'?artists:personas;source.items=source.items.filter(value=>value.id!==item.id);if(isCurrent())redraw();toast('Archived '+item.name);}catch(error){reportError(error);}}
 async function linkPersonas(artist){const selected=new Set(artist.personaIds||[]);
  if(!personas.items.length){selectTab('personas');toast('Create a persona first, then link it to your artist.');return;}
  const body=h('div',{class:'al-persona-choices'},...personas.items.map(persona=>h('label',{class:'al-persona-choice'},h('input',{type:'checkbox',checked:selected.has(persona.id),onChange:event=>event.target.checked?selected.add(persona.id):selected.delete(persona.id)}),avatar(persona.mainImageUrl,persona.name,'sm'),h('span',{},h('strong',{text:persona.name}),h('small',{text:persona.description||'Persona'})))));
  const saved=await openDialog({title:'Personas for '+artist.name,description:'Select the personas associated with this artist.',body,submitLabel:'Save links',onSubmit:()=>api.put(base+'/artists/'+artist.id+'/personas',{personaIds:[...selected]})});if(saved){artist.personaIds=[...selected];if(isCurrent())redraw();toast('Persona links saved');}}
 const warn=event=>{if(dirty){event.preventDefault();event.returnValue='';}};
 let confirming=false;
 const leave=async event=>{const link=event.target.closest?.('a[href]');if(!dirty||!link||event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||link.target==='_blank'||link.download)return;const target=new URL(link.href);if(target.href===location.href)return;event.preventDefault();event.stopPropagation();if(confirming)return;confirming=true;try{if(await confirmDialog({title:'Discard unsaved profile changes?',message:'Your profile has changes that have not been saved.',confirmLabel:'Discard and leave'})){dirty=false;location.assign(target.href);}}finally{confirming=false;}};
 window.addEventListener('beforeunload',warn);document.addEventListener('click',leave,true);
 redrawTabs();updatePreview();mount(page,h('div',{class:'al-profile-head'},h('div',{},h('span',{class:'al-section-label',text:'YOUR CREATIVE IDENTITY'}),h('h1',{text:'Your profile'}),h('p',{text:'Profile, artists, and personas. One place to make them yours.'}))),tabs,profilePanel,collections);
 return ()=>{window.removeEventListener('beforeunload',warn);document.removeEventListener('click',leave,true);};
}
