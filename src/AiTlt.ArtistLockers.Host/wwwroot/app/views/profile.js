import {api} from '/ai-tlt/ui/v1/api.js';
import {h,mount,avatar,openDialog,confirmDialog,toast} from '/ai-tlt/ui/v1/components.js';
import {ctx,reportError} from '../util.js';
import {openPicker} from '../tools.js';
const base='/api/v1/profile';
const input=(value='',extra={})=>h('input',{value:value||'',...extra});
const textarea=(value='',extra={})=>{const el=h('textarea',extra);el.value=value||'';return el;};
const field=(label,control,hint)=>h('label',{},h('span',{text:label}),control,hint?h('small',{text:hint}):null);
const action=(text,onClick)=>h('button',{type:'button',text,onClick});
export async function render(page,{isCurrent}){
 let profile;try{profile=await api.get(base);}catch(error){if(error.status!==404)throw error;profile={};}
 const [artists,personas]=await Promise.all([api.get(base+'/artists'),api.get(base+'/personas')]);if(!isCurrent())return;
 const name=input(profile.name,{maxLength:200}),slug=input(profile.slug,{maxLength:100}),country=input(profile.country,{maxLength:100}),bio=textarea(profile.bio,{rows:7,maxLength:8000});
 let imageUrl=profile.imageUrl||'';const portrait=h('div',{},avatar(imageUrl||ctx.me.account.avatarUrl,profile.name||ctx.me.account.displayName,'lg'));
 const status=h('span',{class:'al-profile-status',role:'status'});const submit=h('button',{class:'ait-btn ait-btn-primary',type:'submit',text:'Save profile'});
 const form=h('form',{class:'al-profile-form',onSubmit:async event=>{event.preventDefault();submit.disabled=true;status.textContent='Saving...';try{
  profile=await api.put(base,{slugSeed:name.value.trim()||ctx.me.account.displayName,name:{value:name.value.trim()||null},slug:slug.value.trim()?{value:slug.value.trim()}:null,country:{value:country.value.trim()||null},bio:{value:bio.value.trim()||null},imageUrl:{value:imageUrl||null}});
  slug.value=profile.slug||'';status.textContent='Profile saved';
 }catch(error){status.textContent=error.message||'Your profile could not be saved.';}finally{submit.disabled=false;}}},
 field('Display name',name),field('Profile address',slug,'Your existing profile address is shared across AI-TLT products.'),field('Country',country),field('About you',bio),
 h('div',{class:'al-entity-actions'},action('Choose portrait',()=>openPicker('image',item=>{imageUrl=location.origin+'/media/'+item.id;mount(portrait,avatar(imageUrl,name.value||ctx.me.account.displayName,'lg'));})),action('Remove portrait',()=>{imageUrl='';mount(portrait,avatar(null,name.value||ctx.me.account.displayName,'lg'));})),
 h('div',{},submit,status));
 const side=h('aside',{class:'al-profile-aside'});
 const redraw=()=>{mount(side,collection('Artists','artists',artists.items||[]),collection('Personas','personas',personas.items||[]));};
 function collection(title,type,items){return h('section',{},h('h2',{text:title}),...items.map(item=>h('article',{class:'al-entity'},h('h3',{text:item.name}),item.description?h('p',{text:item.description}):null,h('div',{class:'al-entity-actions'},action('Edit',()=>editEntity(type,item)),type==='artists'?action('Link personas',()=>linkPersonas(item)):null,action('Archive',()=>archive(type,item))))),h('button',{class:'ait-btn ait-btn-ghost ait-btn-sm',type:'button',text:'Add '+(type==='artists'?'artist':'persona'),onClick:()=>editEntity(type,null)}));}
 async function editEntity(type,existing){const title=type==='artists'?'artist':'persona';const n=input(existing?.name,{maxLength:200}),description=textarea(existing?.description,{rows:5,maxLength:8000}),s=input(existing?.slug);let mainImageUrl=existing?.mainImageUrl||null;
 const body=h('div',{class:'al-profile-form'},field('Name',n),type==='artists'?field('Address',s):null,field('Description',description),h('button',{class:'ait-btn ait-btn-ghost',type:'button',text:'Choose image',onClick:()=>openPicker('image',item=>{mainImageUrl=location.origin+'/media/'+item.id;toast('Image selected');})}));
 const saved=await openDialog({title:(existing?'Edit ':'Create ')+title,body,submitLabel:existing?'Save changes':'Create '+title,onSubmit:async()=>{if(!n.value.trim())throw new Error('Please enter a name.');const data={name:n.value.trim(),description:description.value.trim()||null,mainImageUrl,secondaryImageUrls:existing?.secondaryImageUrls||[]};if(type==='artists')data.slug=s.value.trim()||null;if(type==='personas'&&existing?.expressionImages)data.expressionImages=existing.expressionImages;return existing?api.put(base+'/'+type+'/'+existing.id,data):api.post(base+'/'+type,data);}});
 if(saved){const data=await api.get(base+'/'+type);if(type==='artists')artists.items=data.items;else personas.items=data.items;if(isCurrent())redraw();}
 }
 async function archive(type,item){if(!await confirmDialog({title:'Archive '+item.name+'?',message:'This removes it from your active profile. Existing content references keep their history.',confirmLabel:'Archive'}))return;
 try{await api.del(base+'/'+type+'/'+item.id);const source=type==='artists'?artists:personas;source.items=source.items.filter(value=>value.id!==item.id);if(isCurrent())redraw();}catch(error){reportError(error);}}
 async function linkPersonas(artist){const selected=new Set(artist.personaIds||[]);const body=h('div',{class:'al-profile-form'},...(personas.items||[]).map(persona=>field(persona.name,h('input',{type:'checkbox',checked:selected.has(persona.id),onChange:event=>event.target.checked?selected.add(persona.id):selected.delete(persona.id)}))));
 const saved=await openDialog({title:'Personas for '+artist.name,body,submitLabel:'Save links',onSubmit:()=>api.put(base+'/artists/'+artist.id+'/personas',{personaIds:[...selected]})});if(saved)artist.personaIds=[...selected];}
 redraw();mount(page,h('div',{class:'al-profile-head'},portrait,h('div',{},h('h1',{text:'Your profile'}),h('p',{text:ctx.me.account.displayName}))),h('div',{class:'al-profile-grid'},form,side));
}
