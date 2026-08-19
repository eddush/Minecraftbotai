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
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_KEY = process.env.GROQ_API_KEY;
const BOT_ENABLED = String(process.env.BOT_ENABLED || 'true').toLowerCase() !== 'false';
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';
const VIEWER_PORT = Number(process.env.VIEWER_PORT || 10001);
const WEB_PORT = Number(process.env.PORT || 10000);

const app = express();
app.use(express.json({ limit: '32kb' }));

let bot;
let lastChat = [];
let logs = [];
let busy = false;
let viewerStarted = false;

function log(message, level = 'info') {
  const time = new Date().toISOString();
  logs.push({ time, level, message });
  logs = logs.slice(-300);
  const line = `[${time}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function authorized(req) {
  if (!DASHBOARD_TOKEN) return true;
  const supplied = req.get('x-dashboard-token') || req.query.token || req.body?.token || '';
  return supplied === DASHBOARD_TOKEN;
}
function requireAuth(req, res, next) {
  if (authorized(req)) return next();
  return res.status(401).json({ ok: false, error: 'Invalid dashboard token' });
}

app.get('/', (_req, res) => res.json({ ok: true, minecraft: `${HOST}:${PORT}`, bot: bot?.username || USERNAME, connected: !!bot?.entity, enabled: BOT_ENABLED, dashboard: '/dashboard', viewer: '/viewer/' }));
app.get('/health', (_req, res) => res.send('ok'));
app.get('/dashboard', requireAuth, (_req, res) => res.type('html').send(DASHBOARD_HTML));
app.get('/api/status', requireAuth, (_req, res) => {
  const p = bot?.entity?.position;
  res.json({ ok: true, enabled: BOT_ENABLED, connected: !!bot?.entity, bot: bot?.username || USERNAME, version: bot?.version || VERSION || 'unknown', server: `${HOST}:${PORT}`, position: p ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null, busy });
});
app.get('/api/logs', requireAuth, (_req, res) => res.json({ ok: true, logs }));
app.get('/api/chat', requireAuth, (_req, res) => res.json({ ok: true, chat: lastChat }));
app.post('/api/task', requireAuth, async (req, res) => {
  const request = String(req.body?.request || '').trim();
  if (!request) return res.status(400).json({ ok: false, error: 'request is required' });
  if (!bot?.entity) return res.status(503).json({ ok: false, error: 'Bot is not connected' });
  try { res.json({ ok: true, result: await handleRequest(request, 'Dashboard') }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/chat', requireAuth, (req, res) => {
  if (!bot?.entity) return res.status(503).json({ ok: false, error: 'Bot is not connected' });
  const message = String(req.body?.message || '').trim().slice(0, 240);
  if (!message) return res.status(400).json({ ok: false, error: 'message is required' });
  bot.chat(message); log(`Dashboard chat: ${message}`); res.json({ ok: true });
});

// Render exposes one public HTTP port. Proxy BOTH HTTP and WebSocket traffic from
// /viewer/ to the internal Prismarine viewer. The previous version only proxied WS,
// which caused the viewer page/assets to be blank or 404.
const viewerProxy = httpProxy.createProxyServer({ target: `http://127.0.0.1:${VIEWER_PORT}`, ws: true, changeOrigin: true });
viewerProxy.on('error', err => log(`Viewer proxy error: ${err.message}`, 'warn'));
app.use('/viewer', (req, res) => viewerProxy.web(req, res));

const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/viewer')) viewerProxy.ws(req, socket, head);
  else socket.destroy();
});
server.listen(WEB_PORT, '0.0.0.0', () => log(`Web dashboard started on port ${WEB_PORT}`));

function startViewer() {
  if (!bot?.entity || viewerStarted) return;
  try {
    mineflayerViewer(bot, { port: VIEWER_PORT, firstPerson: true, prefix: '/viewer/' });
    viewerStarted = true;
    log(`Live viewer started at /viewer/ (internal port ${VIEWER_PORT})`);
  } catch (e) { log(`Viewer failed to start: ${e.message}`, 'warn'); }
}

function setupAuthMe() {
  if (!AUTHME_PASSWORD || MS_EMAIL) return;
  setTimeout(() => { if (bot?.entity) { log('AuthMe: sending /register'); bot.chat(`/register ${AUTHME_PASSWORD} ${AUTHME_PASSWORD}`); } }, 2500);
  setTimeout(() => { if (bot?.entity) { log('AuthMe: sending /login'); bot.chat(`/login ${AUTHME_PASSWORD}`); } }, 5000);
}

function connect() {
  if (!BOT_ENABLED) return;
  if (bot && (bot.entity || bot._client?.socket || bot._client)) { log('Bot connection already exists; skipping duplicate connection.', 'warn'); return; }
  const options = { host: HOST, port: PORT, username: MS_EMAIL || USERNAME, version: VERSION || undefined, auth: MS_EMAIL ? 'microsoft' : 'offline' };
  log(`Connecting to ${HOST}:${PORT} as ${options.username} (${options.auth})`);
  bot = mineflayer.createBot(options);
  bot.loadPlugin(pathfinder);
  bot.once('spawn', () => {
    log(`Logged in as ${bot.username} on ${HOST}:${PORT}`);
    setupAuthMe();
    const mcData = require('minecraft-data')(bot.version);
    bot.pathfinder.setMovements(new Movements(bot, mcData));
    startViewer();
    setTimeout(() => bot?.entity && bot.chat('AI bot online. Use !ai <request>'), 7000);
  });
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    lastChat.push({ username, message, time: new Date().toISOString() }); lastChat = lastChat.slice(-50); log(`<${username}> ${message}`);
    if (message.toLowerCase().startsWith('!ai ')) { try { await handleRequest(message.slice(4).trim(), username); } catch (e) { bot.chat(`AI error: ${e.message}`); } }
  });
  bot.on('messagestr', message => log(`Server: ${message}`));
  bot.on('kicked', reason => log(`Kicked: ${reason}`, 'warn'));
  bot.on('error', err => log(`Minecraft error: ${err.message}`, 'error'));
  bot.on('end', () => { log(BOT_ENABLED ? 'Disconnected; reconnecting in 10 seconds...' : 'Disconnected; bot is disabled.', 'warn'); bot = null; viewerStarted = false; if (BOT_ENABLED) setTimeout(() => { if (!bot) connect(); }, 10000); });
}

async function askGroq(request, username) {
  if (!GROQ_KEY) throw new Error('Groq API key is not configured');
  const pos = bot.entity?.position;
  const inventory = bot.inventory?.items().map(i => `${i.name} x${i.count}`).slice(0, 40).join(', ') || '(empty)';
  const system = `You are an autonomous Minecraft assistant controlling a Mineflayer bot named ${bot.username}.\nThe server is ${HOST}:${PORT}. A player named ${username} asked you to do something.\nReturn ONLY valid JSON: {"message":"short chat response","actions":[...]}.\nAllowed actions: say {text}; goto {x,y,z}; stop {}; dig {x,y,z}; place {x,y,z,block}.\nCoordinates are absolute. Do not invent items or coordinates. Never output commands beginning with /. Never modify permissions, OP status, bans, or security settings.`;
  const user = `Request: ${request}\nPosition: ${pos ? `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}` : 'unknown'}\nInventory: ${inventory}\nRecent chat: ${JSON.stringify(lastChat.slice(-8))}`;
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: GROQ_MODEL, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: { type: 'json_object' } }) });
  if (!response.ok) throw new Error(`Groq HTTP ${response.status}: ${await response.text()}`);
  const data = await response.json(); return JSON.parse(data.choices[0].message.content);
}

async function execute(action) {
  const type = action?.type;
  if (type === 'say') { bot.chat(String(action.text || '').slice(0, 240)); return 'said message'; }
  if (type === 'stop') { bot.pathfinder.setGoal(null); bot.clearControlStates(); return 'stopped'; }
  if (type === 'goto') { const x = Number(action.x), y = Number(action.y), z = Number(action.z); if (![x,y,z].every(Number.isFinite)) throw new Error('invalid goto coordinates'); bot.pathfinder.setGoal(new goals.GoalNear(x,y,z,1)); return `walking to ${x},${y},${z}`; }
  if (type === 'dig') { const block = bot.blockAt({x:Number(action.x),y:Number(action.y),z:Number(action.z)}); if (!block || block.name === 'air') throw new Error('no diggable block at target'); if (bot.entity.position.distanceTo(block.position)>5) throw new Error('target is too far away'); await bot.dig(block,true); return `dug ${block.name}`; }
  if (type === 'place') { const target = bot.blockAt({x:Number(action.x),y:Number(action.y),z:Number(action.z)}); if (!target || target.name !== 'air') throw new Error('target is not an air block'); if (bot.entity.position.distanceTo(target.position)>5) throw new Error('target is too far away'); const item = bot.inventory.items().find(i=>i.name===action.block); if(!item) throw new Error(`missing item ${action.block}`); const ref=bot.blockAt({x:target.position.x,y:target.position.y-1,z:target.position.z}); if(!ref||ref.name==='air') throw new Error('no supporting block'); await bot.equip(item,'hand'); await bot.placeBlock(ref,{x:0,y:1,z:0}); return `placed ${action.block}`; }
  throw new Error(`unknown action ${type}`);
}

async function handleRequest(request, username) {
  if (!request) return {message:'',actions:[]};
  if (busy) throw new Error('Bot is already processing another task');
  busy = true;
  try { const plan=await askGroq(request,username); log(`AI plan: ${JSON.stringify(plan)}`); if(plan.message) bot.chat(String(plan.message).slice(0,240)); const results=[]; for(const action of Array.isArray(plan.actions)?plan.actions.slice(0,5):[]){try{const result=await execute(action);results.push(result);log(`Action: ${result}`)}catch(e){results.push(`failed: ${e.message}`);log(`Action failed: ${e.message}`,'warn');bot.chat(`I couldn't do that: ${e.message}`)}} return {message:plan.message||'',actions:results}; }
  catch(e){log(`AI error: ${e.message}`,'error');throw e;} finally {busy=false;}
}

const DASHBOARD_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EddyBotAI Dashboard</title><style>*{box-sizing:border-box}body{margin:0;background:#090e1b;color:#eaf0ff;font:14px system-ui,Arial}header{padding:15px 18px;background:#111a2d;border-bottom:1px solid #26365d;display:flex;justify-content:space-between;align-items:center}main{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:14px;padding:14px}.card{background:#111a2d;border:1px solid #26365d;border-radius:14px;padding:14px;box-shadow:0 8px 30px #0004}h2{margin:0 0 10px}.viewer{width:100%;height:540px;border:0;border-radius:10px;background:#000}.console{height:310px;overflow:auto;background:#050811;border-radius:10px;padding:10px;font:12px ui-monospace,monospace;white-space:pre-wrap}.row{display:flex;gap:8px}.row input,.row textarea{flex:1;background:#080d18;color:white;border:1px solid #34466f;border-radius:9px;padding:10px}.row button{background:#705cff;color:white;border:0;border-radius:9px;padding:10px 14px;font-weight:700;cursor:pointer}.status{padding:10px;border-radius:9px;background:#080d18;margin-bottom:10px}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#777;margin-right:6px}.online{background:#2ee66b}.muted{color:#9aa9c8}.chat{max-height:190px;overflow:auto;margin-bottom:10px}.msg{padding:6px 0;border-bottom:1px solid #1d2946}.error{color:#ff8d8d}.ok{color:#69f0a1}@media(max-width:850px){main{grid-template-columns:1fr}.viewer{height:420px}}</style></head><body><header><div><b>🤖 EddyBotAI</b><div class="muted">Minecraft AI control center</div></div><div id="status">Loading...</div></header><main><section><div class="card"><h2>👁️ What the bot sees</h2><iframe id="viewer" class="viewer" src="about:blank" allow="fullscreen"></iframe></div><div class="card" style="margin-top:14px"><h2>🖥️ Console</h2><div id="console" class="console">Loading...</div></div></section><aside><div class="card"><h2>🤖 Status</h2><div id="details" class="status">Loading...</div></div><div class="card"><h2>🧠 AI task</h2><textarea id="task" rows="5" style="width:100%;resize:vertical" placeholder="Build a small wooden house near spawn"></textarea><div style="margin-top:8px" class="row"><button id="sendTask">Send task</button><button id="stop">Stop</button></div><div id="taskResult" class="muted" style="margin-top:8px"></div></div><div class="card" style="margin-top:14px"><h2>💬 Minecraft chat</h2><div id="chat" class="chat">Loading...</div><div class="row"><input id="chatInput" placeholder="Message the server..."><button id="sendChat">Send</button></div></div></aside></main><script>const params=new URLSearchParams(location.search);const token=params.get('token')||sessionStorage.getItem('dashboardToken')||'';if(token)sessionStorage.setItem('dashboardToken',token);const headers=()=>token?{'x-dashboard-token':token}:{};async function api(path,opt={}){opt.headers=Object.assign({'Content-Type':'application/json'},headers(),opt.headers||{});const r=await fetch(path,opt);const text=await r.text();let d;try{d=JSON.parse(text)}catch{throw new Error(text||('HTTP '+r.status))}if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d}function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}async function refresh(){try{const s=await api('/api/status');document.getElementById('status').innerHTML='<span class="dot '+(s.connected?'online':'')+'"></span>'+(s.connected?'Online':'Offline');document.getElementById('details').innerHTML='<b>'+esc(s.bot)+'</b><br>Version: '+esc(s.version)+'<br>Server: '+esc(s.server)+'<br>Position: '+(s.position?esc(s.position.x+', '+s.position.y+', '+s.position.z):'—')+'<br>Task: '+(s.busy?'Running':'Idle');const l=await api('/api/logs');const c=document.getElementById('console');c.textContent=l.logs.map(x=>'['+new Date(x.time).toLocaleTimeString()+'] '+x.message).join('\n');c.scrollTop=c.scrollHeight}catch(e){document.getElementById('status').innerHTML='<span class="error">'+esc(e.message)+'</span>'}try{const d=await api('/api/chat');document.getElementById('chat').innerHTML=d.chat.map(x=>'<div class="msg"><b>'+esc(x.username)+'</b>: '+esc(x.message)+'</div>').join('')||'<span class="muted">No chat yet</span>'}catch(e){}}document.getElementById('sendTask').onclick=async()=>{const box=document.getElementById('task'),out=document.getElementById('taskResult'),request=box.value.trim();if(!request)return;out.textContent='Sending...';try{const d=await api('/api/task',{method:'POST',body:JSON.stringify({request})});out.innerHTML='<span class="ok">'+esc(JSON.stringify(d.result))+'</span>';box.value=''}catch(e){out.innerHTML='<span class="error">'+esc(e.message)+'</span>'}refresh()};document.getElementById('stop').onclick=async()=>{document.getElementById('task').value='stop';document.getElementById('sendTask').click()};document.getElementById('sendChat').onclick=async()=>{const i=document.getElementById('chatInput'),m=i.value.trim();if(!m)return;try{await api('/api/chat',{method:'POST',body:JSON.stringify({message:m})});i.value='';refresh()}catch(e){alert(e.message)}};document.getElementById('chatInput').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('sendChat').click()});document.getElementById('viewer').src='/viewer/';refresh();setInterval(refresh,2000);</script></body></html>`;

if (BOT_ENABLED) connect();
