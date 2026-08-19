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

app.get('/', (_req, res) => res.json({ ok: true, minecraft: `${HOST}:${PORT}`, bot: bot?.username || USERNAME, connected: !!bot?.entity, enabled: BOT_ENABLED, dashboard: '/dashboard', viewer: '/vi[...]
app.get('/health', (_req, res) => res.type('text').send('ok'));
app.get('/dashboard', (_req, res) => res.type('html').send(DASHBOARD_HTML));
app.get('/api/status', (_req, res) => {
  const p = bot?.entity?.position;
  res.json({ ok: true, enabled: BOT_ENABLED, connected: !!bot?.entity, bot: bot?.username || USERNAME, version: bot?.version || VERSION || 'unknown', server: `${HOST}:${PORT}`, position: p ? { x: [...]
});
app.get('/api/logs', (_req, res) => res.json({ ok: true, logs }));
app.get('/api/chat', (_req, res) => res.json({ ok: true, chat }));
app.post('/api/task', async (req, res) => {
  const request = String(req.body?.request || '').trim();
  if (!request) return res.status(400).json({ ok: false, error: 'request is required' });
  if (!bot?.entity) return res.status(503).json({ ok: false, error: 'Bot is not connected' });
  try { res.json({ ok: true, result: await handleRequest(request, 'Dashboard') }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/chat', (req, res) => {
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
  const system = `You control a Minecraft Mineflayer bot named ${bot.username}. Return ONLY JSON: {"message":"short response","actions":[...]}. Allowed actions: say {text}, goto {x,y,z}, stop {},[...]
  const user = `Player: ${username}\nRequest: ${request}\nPosition: ${p ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : 'unknown'}\nInventory: ${inventory}`;
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' }, body: JSON.strin[...]
  if (!r.ok) throw new Error(`Groq HTTP ${r.status}: ${await r.text()}`);
  const d = await r.json(); return JSON.parse(d.choices[0].message.content);
}

async function execute(a) {
  if (a?.type === 'say') { bot.chat(String(a.text || '').slice(0, 240)); return 'said message'; }
  if (a?.type === 'stop') { bot.pathfinder.setGoal(null); bot.clearControlStates(); return 'stopped'; }
  if (a?.type === 'goto') { const x=Number(a.x),y=Number(a.y),z=Number(a.z); if (![x,y,z].every(Number.isFinite)) throw new Error('invalid coordinates'); bot.pathfinder.setGoal(new goals.GoalNear[...]
  if (a?.type === 'dig') { const b=bot.blockAt({x:Number(a.x),y:Number(a.y),z:Number(a.z)}); if(!b||b.name==='air') throw new Error('no diggable block'); if(bot.entity.position.distanceTo(b.posit[...]
  if (a?.type === 'place') { const x=Number(a.x),y=Number(a.y),z=Number(a.z); const target=bot.blockAt({x,y,z}); if(!target||target.name!=='air') throw new Error('target is not air'); if(bot.enti[...]
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
    for (const a of Array.isArray(plan.actions) ? plan.actions.slice(0,5) : []) { try { const r=await execute(a); results.push(r); log(`Action: ${r}`); } catch(e) { results.push(`failed: ${e.mess[...]
    return { message: plan.message || '', actions: results };
  } finally { busy = false; }
}

const DASHBOARD_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EddyBotAI</title><style>body{margin:0;background[...]
const token=new URLSearchParams(location.search).get('token')||sessionStorage.getItem('dashboardToken')||'';if(token)sessionStorage.setItem('dashboardToken',token);
async function api(url,opt={}){opt.headers=Object.assign({'Content-Type':'application/json'},opt.headers||{},token?{'x-dashboard-token':token}:{});const r=await fetch(url,opt);const t=await r.tex[...]
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function refresh(){try{const s=await api('/api/status');document.getElementById('top').textContent=s.connected?'🟢 Online':'🔴 Offline';document.getElementById('status').innerHTML='<b>'[...]
document.getElementById('send').onclick=async()=>{const v=document.getElementById('task').value.trim();if(!v)return;const o=document.getElementById('result');o.textContent='Sending...';try{const [...]
document.getElementById('stop').onclick=()=>{document.getElementById('task').value='Stop moving';document.getElementById('send').click()};
document.getElementById('chatBtn').onclick=async()=>{const i=document.getElementById('msg'),v=i.value.trim();if(!v)return;try{await api('/api/chat',{method:'POST',body:JSON.stringify({message:v})[...]
document.getElementById('msg').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('chatBtn').click()});refresh();setInterval(refresh,2000);
</script></body></html>`;

if (BOT_ENABLED) connect();
