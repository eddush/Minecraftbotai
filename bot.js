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
  const line = `[${new Date().toISOString()}] ${message}`;
  logs.push({ time: new Date().toISOString(), level, message });
  logs = logs.slice(-250);
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

app.get('/', (_req, res) => res.json({
  ok: true,
  minecraft: `${HOST}:${PORT}`,
  bot: bot?.username || USERNAME,
  connected: !!bot?.entity,
  enabled: BOT_ENABLED,
  dashboard: '/dashboard',
  viewer: '/viewer/'
}));
app.get('/health', (_req, res) => res.send('ok'));

app.get('/dashboard', requireAuth, (_req, res) => {
  res.type('html').send(DASHBOARD_HTML);
});

app.get('/api/status', requireAuth, (_req, res) => {
  const p = bot?.entity?.position;
  res.json({
    ok: true,
    enabled: BOT_ENABLED,
    connected: !!bot?.entity,
    bot: bot?.username || USERNAME,
    version: bot?.version || VERSION || 'unknown',
    server: `${HOST}:${PORT}`,
    position: p ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null,
    busy
  });
});

app.get('/api/logs', requireAuth, (_req, res) => res.json({ ok: true, logs }));
app.get('/api/chat', requireAuth, (_req, res) => res.json({ ok: true, chat: lastChat }));

app.post('/api/task', requireAuth, async (req, res) => {
  const request = String(req.body?.request || '').trim();
  if (!request) return res.status(400).json({ ok: false, error: 'request is required' });
  if (!bot?.entity) return res.status(503).json({ ok: false, error: 'Bot is not connected' });
  if (busy) return res.status(409).json({ ok: false, error: 'Bot is already processing another task' });
  try {
    const result = await handleRequest(request, 'Dashboard');
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/chat', requireAuth, (req, res) => {
  if (!bot?.entity) return res.status(503).json({ ok: false, error: 'Bot is not connected' });
  const message = String(req.body?.message || '').trim().slice(0, 240);
  if (!message) return res.status(400).json({ ok: false, error: 'message is required' });
  bot.chat(message);
  log(`Dashboard chat: ${message}`);
  res.json({ ok: true });
});

const server = http.createServer(app);
const viewerProxy = httpProxy.createProxyServer({ target: `http://127.0.0.1:${VIEWER_PORT}`, ws: true, changeOrigin: true });
viewerProxy.on('error', err => log(`Viewer proxy error: ${err.message}`, 'warn'));
server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/viewer')) {
    viewerProxy.ws(req, socket, head);
  } else {
    socket.destroy();
  }
});
server.listen(WEB_PORT, '0.0.0.0', () => log(`Web dashboard started on port ${WEB_PORT}`));

function startViewer() {
  if (!bot?.entity || viewerStarted) return;
  try {
    mineflayerViewer(bot, {
      port: VIEWER_PORT,
      firstPerson: true,
      prefix: '/viewer/'
    });
    viewerStarted = true;
    log(`Live viewer started at /viewer/ (internal port ${VIEWER_PORT})`);
  } catch (e) {
    log(`Viewer failed to start: ${e.message}`, 'warn');
  }
}

function setupAuthMe() {
  if (!AUTHME_PASSWORD || MS_EMAIL) return;
  setTimeout(() => {
    if (!bot?.entity) return;
    log('AuthMe: sending /register');
    bot.chat(`/register ${AUTHME_PASSWORD} ${AUTHME_PASSWORD}`);
  }, 2500);
  setTimeout(() => {
    if (!bot?.entity) return;
    log('AuthMe: sending /login');
    bot.chat(`/login ${AUTHME_PASSWORD}`);
  }, 5000);
}

function connect() {
  if (!BOT_ENABLED) return;
  if (bot && (bot.entity || bot._client?.socket || bot._client)) {
    log('Bot connection already exists; skipping duplicate connection.', 'warn');
    return;
  }

  const options = {
    host: HOST,
    port: PORT,
    username: MS_EMAIL || USERNAME,
    version: VERSION || undefined,
    auth: MS_EMAIL ? 'microsoft' : 'offline'
  };
  log(`Connecting to ${HOST}:${PORT} as ${options.username} (${options.auth})`);
  bot = mineflayer.createBot(options);
  bot.loadPlugin(pathfinder);

  bot.once('spawn', () => {
    log(`Logged in as ${bot.username} on ${HOST}:${PORT}`);
    setupAuthMe();
    const mcData = require('minecraft-data')(bot.version);
    const movements = new Movements(bot, mcData);
    bot.pathfinder.setMovements(movements);
    startViewer();
    setTimeout(() => bot?.entity && bot.chat('AI bot online. Use !ai <request>'), 7000);
  });

  bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    lastChat.push({ username, message, time: new Date().toISOString() });
    lastChat = lastChat.slice(-30);
    log(`<${username}> ${message}`);
    if (message.toLowerCase().startsWith('!ai ')) {
      await handleRequest(message.slice(4).trim(), username);
    }
  });

  bot.on('messagestr', message => log(`Server: ${message}`));
  bot.on('kicked', reason => log(`Kicked: ${reason}`, 'warn'));
  bot.on('error', err => log(`Minecraft error: ${err.message}`, 'error'));
  bot.on('end', () => {
    log(BOT_ENABLED ? 'Disconnected; reconnecting in 10 seconds...' : 'Disconnected; bot is disabled.', 'warn');
    bot = null;
    viewerStarted = false;
    if (BOT_ENABLED) setTimeout(() => { if (!bot) connect(); }, 10000);
  });
}

async function askGroq(request, username) {
  const pos = bot.entity?.position;
  const inventory = bot.inventory?.items().map(i => `${i.name} x${i.count}`).slice(0, 40).join(', ') || '(empty)';
  const system = `You are an autonomous Minecraft assistant controlling a Mineflayer bot named ${bot.username}.\n` +
    `The server is ${HOST}:${PORT}. A player named ${username} asked you to do something.\n` +
    `Return ONLY valid JSON with this exact shape: {"message":"short chat response","actions":[...]}.\n` +
    `Allowed actions: say {text}; goto {x,y,z}; stop {}; dig {x,y,z}; place {x,y,z,block}.\n` +
    `Coordinates are absolute Minecraft coordinates. For dig, the target must be a nearby block. For place, choose a block from the inventory and place it at the requested coordinate when possible.\n` +
    `Do not invent items or coordinates. If the request is impossible, explain it in message and use actions:[].\n` +
    `Never output commands beginning with /. Never attempt to modify server permissions, OP status, bans, or security settings.`;
  const user = `Request: ${request}\nPosition: ${pos ? `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}` : 'unknown'}\nInventory: ${inventory}\nRecent chat: ${JSON.stringify(lastChat.slice(-8))}`;

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.2,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' }
    })
  });
  if (!response.ok) throw new Error(`Groq HTTP ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return JSON.parse(data.choices[0].message.content);
}

async function execute(action) {
  const type = action?.type;
  if (type === 'say') {
    bot.chat(String(action.text || '').slice(0, 240));
    return 'said message';
  }
  if (type === 'stop') {
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    return 'stopped';
  }
  if (type === 'goto') {
    const x = Number(action.x), y = Number(action.y), z = Number(action.z);
    if (![x,y,z].every(Number.isFinite)) throw new Error('invalid goto coordinates');
    bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 1));
    return `walking to ${x},${y},${z}`;
  }
  if (type === 'dig') {
    const block = bot.blockAt({ x: Number(action.x), y: Number(action.y), z: Number(action.z) });
    if (!block || block.name === 'air') throw new Error('no diggable block at target');
    if (bot.entity.position.distanceTo(block.position) > 5) throw new Error('target is too far away');
    await bot.dig(block, true);
    return `dug ${block.name}`;
  }
  if (type === 'place') {
    const target = bot.blockAt({ x: Number(action.x), y: Number(action.y), z: Number(action.z) });
    if (!target || target.name !== 'air') throw new Error('target is not an air block');
    if (bot.entity.position.distanceTo(target.position) > 5) throw new Error('target is too far away');
    const item = bot.inventory.items().find(i => i.name === action.block);
    if (!item) throw new Error(`missing item ${action.block}`);
    const ref = bot.blockAt({ x: target.position.x, y: target.position.y - 1, z: target.position.z });
    if (!ref || ref.name === 'air') throw new Error('no supporting block');
    await bot.equip(item, 'hand');
    await bot.placeBlock(ref, { x: 0, y: 1, z: 0 });
    return `placed ${action.block}`;
  }
  throw new Error(`unknown action ${type}`);
}

async function handleRequest(request, username) {
  if (!request) return { message: '', actions: [] };
  if (busy) throw new Error('Bot is already processing another task');
  if (!GROQ_KEY) throw new Error('Groq API key is not configured');
  busy = true;
  try {
    const plan = await askGroq(request, username);
    log(`AI plan: ${JSON.stringify(plan)}`);
    if (plan.message) bot.chat(String(plan.message).slice(0, 240));
    const results = [];
    for (const action of Array.isArray(plan.actions) ? plan.actions.slice(0, 5) : []) {
      try {
        const result = await execute(action);
        results.push(result);
        log(`Action: ${result}`);
      } catch (e) {
        results.push(`failed: ${e.message}`);
        log(`Action failed: ${e.message}`, 'warn');
        bot.chat(`I couldn't do that: ${e.message}`);
      }
    }
    return { message: plan.message || '', actions: results };
  } catch (e) {
    log(`AI error: ${e.message}`, 'error');
    throw e;
  } finally {
    busy = false;
  }
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EddyBotAI Dashboard</title>
<style>body{margin:0;background:#0b1020;color:#eaf0ff;font:14px system-ui,Arial}header{padding:16px 20px;background:#111a33;display:flex;justify-content:space-between;align-items:center}main{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:14px;padding:14px}.card{background:#111a33;border:1px solid #26345d;border-radius:14px;padding:14px;box-shadow:0 8px 30px #0003}h2{margin:0 0 10px}.viewer{width:100%;height:520px;border:0;border-radius:10px;background:#000}.console{height:360px;overflow:auto;background:#070b14;border-radius:10px;padding:10px;font:12px ui-monospace,monospace;white-space:pre-wrap}.row{display:flex;gap:8px}.row input,.row textarea{flex:1;background:#080d19;color:white;border:1px solid #34446f;border-radius:9px;padding:10px}.row button{background:#6d5dfc;color:white;border:0;border-radius:9px;padding:10px 14px;font-weight:700}.status{padding:10px;border-radius:9px;background:#080d19;margin-bottom:10px}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#777;margin-right:6px}.online{background:#2ee66b}.muted{color:#9ba9c9}.chat{max-height:180px;overflow:auto;margin-bottom:10px}.msg{padding:5px 0;border-bottom:1px solid #1d2947}@media(max-width:850px){main{grid-template-columns:1fr}.viewer{height:400px}}</style></head>
<body><header><div><b>🤖 EddyBotAI</b><div class="muted">Minecraft AI control center</div></div><div id="status">Loading...</div></header>
<main><section><div class="card"><h2>👁️ What the bot sees</h2><iframe class="viewer" src="/viewer/"></iframe></div><div class="card" style="margin-top:14px"><h2>🧠 AI task</h2><div class="row"><textarea id="task" rows="3" placeholder="Build a small house near spawn..."></textarea><button onclick="sendTask()">Send</button></div><div id="taskResult" class="muted" style="margin-top:8px"></div></div></section>
<aside><div class="card"><h2>🖥️ Console</h2><div id="console" class="console"></div></div><div class="card" style="margin-top:14px"><h2>💬 Minecraft chat</h2><div id="chat" class="chat"></div><div class="row"><input id="chatInput" placeholder="Send chat message"><button onclick="sendChat()">Chat</button></div></div></aside></main>
<script>async function api(path,opt={}){const r=await fetch(path,{headers:{'Content-Type':'application/json'},...opt});return r.json()}async function refresh(){try{const s=await api('/api/status');document.getElementById('status').innerHTML='<span class="dot '+(s.connected?'online':'')+'"></span>'+(s.connected?'ONLINE':'OFFLINE')+' · '+(s.version||'unknown')+(s.position?' · '+s.position.x+', '+s.position.y+', '+s.position.z:'');const l=await api('/api/logs');document.getElementById('console').textContent=l.logs.map(x=>'['+new Date(x.time).toLocaleTimeString()+'] '+x.message).join('\n');const c=await api('/api/chat');document.getElementById('chat').innerHTML=c.chat.map(x=>'<div class="msg"><b>'+esc(x.username)+'</b>: '+esc(x.message)+'</div>').join('');document.getElementById('console').scrollTop=999999}catch(e){document.getElementById('status').textContent='Dashboard error'}}function esc(s){return String(s).replace(/[&<>\"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]))}async function sendTask(){const v=document.getElementById('task').value.trim();if(!v)return;document.getElementById('taskResult').textContent='Working...';const r=await api('/api/task',{method:'POST',body:JSON.stringify({request:v})});document.getElementById('taskResult').textContent=r.ok?'Done: '+JSON.stringify(r.result):'Error: '+r.error;refresh()}async function sendChat(){const v=document.getElementById('chatInput').value.trim();if(!v)return;const r=await api('/api/chat',{method:'POST',body:JSON.stringify({message:v})});if(!r.ok)alert(r.error);document.getElementById('chatInput').value='';refresh()}document.getElementById('task').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey))sendTask()});setInterval(refresh,2000);refresh();</script></body></html>`;

if (BOT_ENABLED) connect();
