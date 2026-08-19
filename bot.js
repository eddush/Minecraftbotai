const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { mineflayer: mineflayerViewer } = require('prismarine-viewer');
const express = require('express');
const http = require('http');
const httpProxy = require('http-proxy');

const HOST = process.env.MC_HOST || 'eddydev.ddns.net';
const PORT = Number(process.env.MC_PORT || 25565);
const VERSION = process.env.MC_VERSION && process.env.MC_VERSION !== 'auto' ? process.env.MC_VERSION : false;
const USERNAME = process.env.MC_USERNAME || 'EddyBotAI';
const MS_EMAIL = process.env.MC_MICROSOFT_EMAIL || '';
const AUTHME_PASSWORD = process.env.AUTHME_PASSWORD || '';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const BOT_ENABLED = String(process.env.BOT_ENABLED || 'true').toLowerCase() !== 'false';
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';
const VIEWER_PORT = Number(process.env.VIEWER_PORT || 10001);
const WEB_PORT = Number(process.env.PORT || 10000);

const app = express();
app.use(express.json({ limit: '32kb' }));
let bot = null;
let viewerStarted = false;
let busy = false;
let logs = [];
let chat = [];

function log(message, level = 'info') {
  const entry = { time: new Date().toISOString(), level, message: String(message) };
  logs.push(entry);
  if (logs.length > 300) logs.shift();
  if (level === 'error') console.error(entry.message); else if (level === 'warn') console.warn(entry.message); else console.log(entry.message);
}

function authorized(req) {
  if (!DASHBOARD_TOKEN) return true;
  const token = req.get('x-dashboard-token') || req.query.token || req.body?.token || '';
  return token === DASHBOARD_TOKEN;
}
function auth(req, res, next) {
  if (authorized(req)) return next();
  res.status(401).json({ ok: false, error: 'Invalid dashboard token' });
}

app.get('/', (_req, res) => res.json({ ok: true, minecraft: `${HOST}:${PORT}`, bot: bot?.username || USERNAME, connected: !!bot?.entity, enabled: BOT_ENABLED, dashboard: '/dashboard', viewer: '/viewer/' }));
app.get('/health', (_req, res) => res.type('text').send('ok'));
app.get('/dashboard', auth, (_req, res) => res.type('html').send(DASHBOARD_HTML));
app.get('/api/status', auth, (_req, res) => {
  const p = bot?.entity?.position;
  res.json({ ok: true, enabled: BOT_ENABLED, connected: !!bot?.entity, bot: bot?.username || USERNAME, version: bot?.version || VERSION || 'unknown', server: `${HOST}:${PORT}`, position: p ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null, busy });
});
app.get('/api/logs', auth, (_req, res) => res.json({ ok: true, logs }));
app.get('/api/chat', auth, (_req, res) => res.json({ ok: true, chat }));
app.post('/api/task', auth, async (req, res) => {
  const request = String(req.body?.request || '').trim();
  if (!request) return res.status(400).json({ ok: false, error: 'request is required' });
  if (!bot?.entity) return res.status(503).json({ ok: false, error: 'Bot is not connected' });
  try { res.json({ ok: true, result: await handleRequest(request, 'Dashboard') }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/chat', auth, (req, res) => {
  if (!bot?.entity) return res.status(503).json({ ok: false, error: 'Bot is not connected' });
  const message = String(req.body?.message || '').trim().slice(0, 240);
  if (!message) return res.status(400).json({ ok: false, error: 'message is required' });
  bot.chat(message); log(`Dashboard chat: ${message}`); res.json({ ok: true });
});

const viewerProxy = httpProxy.createProxyServer({ target: `http://127.0.0.1:${VIEWER_PORT}`, ws: true, changeOrigin: true });
viewerProxy.on('error', e => log(`Viewer proxy error: ${e.message}`, 'warn'));
app.use((req, res, next) => {
  if (req.url === '/viewer' || req.url.startsWith('/viewer/')) return viewerProxy.web(req, res);
  next();
});

const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/viewer' || req.url.startsWith('/viewer/')) viewerProxy.ws(req, socket, head);
  else socket.destroy();
});
server.listen(WEB_PORT, '0.0.0.0', () => log(`Web dashboard listening on ${WEB_PORT}`));

function startViewer() {
  if (!bot?.entity || viewerStarted) return;
  try {
    mineflayerViewer(bot, { port: VIEWER_PORT, firstPerson: true, prefix: '/viewer/' });
    viewerStarted = true;
    log(`Viewer started internally on ${VIEWER_PORT}`);
  } catch (e) { log(`Viewer failed: ${e.message}`, 'warn'); }
}

function connect() {
  if (!BOT_ENABLED) { log('BOT_ENABLED=false; not connecting'); return; }
  if (bot) { log('Connection already exists; skipping duplicate connection', 'warn'); return; }
  const options = { host: HOST, port: PORT, username: MS_EMAIL || USERNAME, version: VERSION || undefined, auth: MS_EMAIL ? 'microsoft' : 'offline' };
  log(`Connecting ${options.username} to ${HOST}:${PORT} version=${VERSION || 'auto'}`);
  bot = mineflayer.createBot(options);
  bot.loadPlugin(pathfinder);
  bot.once('spawn', () => {
    log(`Logged in as ${bot.username}`);
    const mcData = require('minecraft-data')(bot.version);
    bot.pathfinder.setMovements(new Movements(bot, mcData));
    startViewer();
    if (AUTHME_PASSWORD && !MS_EMAIL) {
      setTimeout(() => bot?.entity && bot.chat(`/register ${AUTHME_PASSWORD} ${AUTHME_PASSWORD}`), 2500);
      setTimeout(() => bot?.entity && bot.chat(`/login ${AUTHME_PASSWORD}`), 5000);
    }
  });
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    chat.push({ username, message, time: new Date().toISOString() }); if (chat.length > 50) chat.shift();
    log(`<${username}> ${message}`);
    if (message.toLowerCase().startsWith('!ai ')) {
      try { await handleRequest(message.slice(4).trim(), username); }
      catch (e) { bot.chat(`AI error: ${e.message}`); }
    }
  });
  bot.on('messagestr', message => log(`Server: ${message}`));
  bot.on('kicked', reason => log(`Kicked: ${reason}`, 'warn'));
  bot.on('error', e => log(`Minecraft error: ${e.message}`, 'error'));
  bot.on('end', () => {
    log(BOT_ENABLED ? 'Disconnected; reconnecting in 10 seconds' : 'Disconnected', 'warn');
    bot = null; viewerStarted = false;
    if (BOT_ENABLED) setTimeout(() => { if (!bot) connect(); }, 10000);
  });
}

async function askGroq(request, username) {
  if (!GROQ_KEY) throw new Error('Groq API key is not configured');
  const p = bot.entity?.position;
  const inventory = bot.inventory.items().slice(0, 40).map(i => `${i.name} x${i.count}`).join(', ') || '(empty)';
  const system = `You control a Minecraft Mineflayer bot named ${bot.username}. Return ONLY JSON: {"message":"short response","actions":[...]}. Allowed actions: say {text}, goto {x,y,z}, stop {}, dig {x,y,z}, place {x,y,z,block}. Never output slash commands, permissions, bans or security changes. Coordinates are absolute.`;
  const user = `Player: ${username}\nRequest: ${request}\nPosition: ${p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : 'unknown'}\nInventory: ${inventory}`;
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: GROQ_MODEL, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: { type: 'json_object' } }) });
  if (!r.ok) throw new Error(`Groq HTTP ${r.status}: ${await r.text()}`);
  const d = await r.json(); return JSON.parse(d.choices[0].message.content);
}

async function execute(a) {
  if (a?.type === 'say') { bot.chat(String(a.text || '').slice(0, 240)); return 'said message'; }
  if (a?.type === 'stop') { bot.pathfinder.setGoal(null); bot.clearControlStates(); return 'stopped'; }
  if (a?.type === 'goto') { const x=Number(a.x),y=Number(a.y),z=Number(a.z); if (![x,y,z].every(Number.isFinite)) throw new Error('invalid coordinates'); bot.pathfinder.setGoal(new goals.GoalNear(x,y,z,1)); return `walking to ${x},${y},${z}`; }
  if (a?.type === 'dig') { const b=bot.blockAt({x:Number(a.x),y:Number(a.y),z:Number(a.z)}); if(!b||b.name==='air') throw new Error('no diggable block'); if(bot.entity.position.distanceTo(b.position)>5) throw new Error('target too far'); await bot.dig(b,true); return `dug ${b.name}`; }
  if (a?.type === 'place') { const x=Number(a.x),y=Number(a.y),z=Number(a.z); const target=bot.blockAt({x,y,z}); if(!target||target.name!=='air') throw new Error('target is not air'); if(bot.entity.position.distanceTo(target.position)>5) throw new Error('target too far'); const item=bot.inventory.items().find(i=>i.name===a.block); if(!item) throw new Error(`missing item ${a.block}`); const ref=bot.blockAt({x,y:y-1,z}); if(!ref||ref.name==='air') throw new Error('no supporting block'); await bot.equip(item,'hand'); await bot.placeBlock(ref,{x:0,y:1,z:0}); return `placed ${a.block}`; }
  throw new Error(`unknown action ${a?.type}`);
}

async function handleRequest(request, username) {
  if (!request) return { message: '', actions: [] };
  if (busy) throw new Error('Bot is already processing another task');
  busy = true;
  try {
    const plan = await askGroq(request, username); log(`AI plan: ${JSON.stringify(plan)}`);
    if (plan.message) bot.chat(String(plan.message).slice(0, 240));
    const results=[];
    for (const a of Array.isArray(plan.actions) ? plan.actions.slice(0,5) : []) { try { const r=await execute(a); results.push(r); log(`Action: ${r}`); } catch(e) { results.push(`failed: ${e.message}`); log(`Action failed: ${e.message}`, 'warn'); } }
    return { message: plan.message || '', actions: results };
  } finally { busy = false; }
}

const DASHBOARD_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EddyBotAI</title><style>body{margin:0;background:#090e1b;color:#eef;font:14px Arial}header{padding:14px;background:#111a2d;display:flex;justify-content:space-between}main{display:grid;grid-template-columns:2fr 1fr;gap:14px;padding:14px}.card{background:#111a2d;border:1px solid #26365d;border-radius:12px;padding:12px;margin-bottom:14px}.viewer{width:100%;height:540px;border:0;background:#000;border-radius:8px}.console{height:260px;overflow:auto;background:#050811;padding:10px;white-space:pre-wrap;font:12px monospace}.row{display:flex;gap:8px}.row>*{flex:1}input,textarea{background:#080d18;color:white;border:1px solid #34466f;border-radius:8px;padding:10px}button{background:#705cff;color:white;border:0;border-radius:8px;padding:10px;font-weight:bold}.chat{max-height:180px;overflow:auto}.msg{padding:5px;border-bottom:1px solid #26365d}.ok{color:#69f0a1}.err{color:#ff8d8d}@media(max-width:850px){main{grid-template-columns:1fr}.viewer{height:420px}}</style></head><body><header><b>🤖 EddyBotAI</b><span id="top">Loading...</span></header><main><section><div class="card"><h3>👁️ What the bot sees</h3><iframe id="viewer" class="viewer" src="/viewer/" allow="fullscreen"></iframe></div><div class="card"><h3>🖥️ Console</h3><div id="logs" class="console">Loading...</div></div></section><aside><div class="card"><h3>🤖 Status</h3><div id="status">Loading...</div></div><div class="card"><h3>🧠 AI task</h3><textarea id="task" rows="5" placeholder="Build a small wooden house near spawn"></textarea><div class="row"><button id="send">Send task</button><button id="stop">Stop</button></div><p id="result"></p></div><div class="card"><h3>💬 Chat</h3><div id="chat" class="chat"></div><div class="row"><input id="msg" placeholder="Message Minecraft chat"><button id="chatBtn">Send</button></div></div></aside></main><script>
const token=new URLSearchParams(location.search).get('token')||sessionStorage.getItem('dashboardToken')||'';if(token)sessionStorage.setItem('dashboardToken',token);
async function api(url,opt={}){opt.headers=Object.assign({'Content-Type':'application/json'},opt.headers||{},token?{'x-dashboard-token':token}:{});const r=await fetch(url,opt);const t=await r.text();let d;try{d=JSON.parse(t)}catch(e){throw new Error(t||('HTTP '+r.status))}if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function refresh(){try{const s=await api('/api/status');document.getElementById('top').textContent=s.connected?'🟢 Online':'🔴 Offline';document.getElementById('status').innerHTML='<b>'+esc(s.bot)+'</b><br>Version: '+esc(s.version)+'<br>Position: '+(s.position?esc(s.position.x+', '+s.position.y+', '+s.position.z):'—')+'<br>Task: '+(s.busy?'Running':'Idle');const l=await api('/api/logs');document.getElementById('logs').textContent=l.logs.map(x=>'['+new Date(x.time).toLocaleTimeString()+'] '+x.message).join('\n');const c=await api('/api/chat');document.getElementById('chat').innerHTML=c.chat.map(x=>'<div class="msg"><b>'+esc(x.username)+'</b>: '+esc(x.message)+'</div>').join('')||'No chat yet'}catch(e){document.getElementById('top').innerHTML='<span class="err">'+esc(e.message)+'</span>'}}
document.getElementById('send').onclick=async()=>{const v=document.getElementById('task').value.trim();if(!v)return;const o=document.getElementById('result');o.textContent='Sending...';try{const d=await api('/api/task',{method:'POST',body:JSON.stringify({request:v})});o.innerHTML='<span class="ok">'+esc(JSON.stringify(d.result))+'</span>';document.getElementById('task').value=''}catch(e){o.innerHTML='<span class="err">'+esc(e.message)+'</span>'}refresh()};
document.getElementById('stop').onclick=()=>{document.getElementById('task').value='Stop moving';document.getElementById('send').click()};
document.getElementById('chatBtn').onclick=async()=>{const i=document.getElementById('msg'),v=i.value.trim();if(!v)return;try{await api('/api/chat',{method:'POST',body:JSON.stringify({message:v})});i.value='';refresh()}catch(e){alert(e.message)}};
document.getElementById('msg').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('chatBtn').click()});refresh();setInterval(refresh,2000);
</script></body></html>`;

if (BOT_ENABLED) connect();
