/** Minimal phone remote, served at /remote. Intentionally dependency-free. */
export function remoteHtml(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>LyricRoom Remote</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;background:#0b0b0c;color:#f1efe8;
  font:16px/1.4 system-ui,-apple-system,"Inter",sans-serif;
  padding:max(20px,env(safe-area-inset-top)) 20px 40px;display:flex;flex-direction:column;gap:22px}
h1{font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:#8a8478;margin:0;font-weight:600}
.now{min-height:78px}
.title{font-size:26px;font-weight:700;letter-spacing:-.02em;margin:0 0 4px;overflow-wrap:anywhere}
.artist{color:#a49c8d;margin:0;overflow-wrap:anywhere}
.meta{margin-top:10px;font-size:12px;color:#6f6a60;letter-spacing:.04em}
.row{display:flex;gap:10px;flex-wrap:wrap}
button{flex:1 1 90px;min-height:56px;border-radius:14px;border:1px solid #2a2823;
  background:#141310;color:#f1efe8;font-size:15px;font-weight:600;cursor:pointer;
  -webkit-tap-highlight-color:transparent}
button:active{background:#201e19}
button.accent{background:#e8b86d;color:#14110e;border-color:#e8b86d}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.offset{font-variant-numeric:tabular-nums;font-size:30px;font-weight:700;text-align:center;margin:6px 0}
section{display:flex;flex-direction:column;gap:10px}
.pill{display:inline-block;padding:3px 9px;border-radius:999px;background:#1c1a16;font-size:11px;
  letter-spacing:.06em;text-transform:uppercase;color:#a49c8d}
</style></head><body>
<section><h1>Now playing</h1>
<div class="now"><p class="title" id="t">--</p><p class="artist" id="a"></p>
<div class="meta"><span class="pill" id="lvl">...</span> <span id="prov"></span></div></div></section>
<section><h1>Transport</h1><div class="row">
<button id="prev">Prev</button><button id="pp" class="accent">Play / Pause</button><button id="next">Next</button>
</div></section>
<section><h1>Sync offset</h1><div class="offset" id="off">0 ms</div><div class="grid">
<button data-d="-1000">-1s</button><button data-d="-100">-100</button>
<button data-d="100">+100</button><button data-d="1000">+1s</button>
</div><div class="row"><button id="reset">Reset offset</button></div>
<p class="meta">Negative shows lyrics earlier. Saved per track.</p></section>
<section><h1>Display</h1><div class="grid">
<button data-m="auto">Auto</button><button data-m="word">Word</button>
<button data-m="line">Line</button><button data-m="art">Art</button>
</div><div class="row"><button id="reload">Reload lyrics</button><button id="nextsrc">Next source</button></div></section>
<script>
let ws, track=null, offset=0;
const $=id=>document.getElementById(id);
function send(m){ if(ws&&ws.readyState===1) ws.send(JSON.stringify(m)); }
function connect(){
  ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');
  ws.onmessage=e=>{
    const m=JSON.parse(e.data);
    if(m.type==='nowplaying'){ track=m.track;
      $('t').textContent=m.track?m.track.title:'Nothing playing';
      $('a').textContent=m.track?m.track.artist:''; }
    if(m.type==='lyrics'){ offset=m.offsetMs||0; $('off').textContent=offset+' ms';
      $('lvl').textContent=m.doc?m.doc.level:'none';
      $('prov').textContent=m.doc?m.doc.provider:''; }
  };
  ws.onclose=()=>setTimeout(connect,1500);
}
connect();
$('pp').onclick=()=>send({type:'control',action:'playpause'});
$('next').onclick=()=>send({type:'control',action:'next'});
$('prev').onclick=()=>send({type:'control',action:'previous'});
$('reload').onclick=()=>send({type:'control',action:'reloadLyrics'});
$('nextsrc').onclick=()=>send({type:'control',action:'nextProvider'});
$('reset').onclick=()=>{ if(track) send({type:'nudge',trackKey:track.trackKey,deltaMs:-offset}); };
document.querySelectorAll('[data-d]').forEach(b=>b.onclick=()=>{
  if(track) send({type:'nudge',trackKey:track.trackKey,deltaMs:Number(b.dataset.d)}); });
document.querySelectorAll('[data-m]').forEach(b=>b.onclick=()=>send({type:'setmode',mode:b.dataset.m}));
</script></body></html>`;
}
