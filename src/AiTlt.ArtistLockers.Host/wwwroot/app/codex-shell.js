import {api} from '/ai-tlt/ui/v1/api.js';import {header} from './header.js';
try{const me=await api.get('/api/v1/me');document.querySelector('#alHeader').replaceChildren(header(me));}catch(error){if(error.status===401)location.replace('/auth/signin?returnUrl='+encodeURIComponent(location.pathname+location.search));}
