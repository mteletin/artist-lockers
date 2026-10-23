const state = await fetch('/__dev/state').then(response => response.json());
const link = document.createElement('a');
link.href = '/__dev'; link.textContent = 'DEMO · ' + state.persona; link.title = 'Developer controls — fictional, in-memory data';
Object.assign(link.style,{ position:'fixed', bottom:'8px', right:'8px', zIndex:'2147483647', padding:'10px 12px',
  background:'#383a37', color:'#f2f0e9', border:'1px solid #bd8a68', font:'12px system-ui', textDecoration:'none' });
document.body.append(link);
