const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const express = require('express');

const HOST = process.env.MC_HOST || 'eddydev.ddns.net';
const PORT = Number(process.env.MC_PORT || 25565);
const VERSION = process.env.MC_VERSION && process.env.MC_VERSION !== 'auto' ? process.env.MC_VERSION : false;
const USERNAME = process.env.MC_USERNAME || 'EddyBotAI';
const MS_EMAIL = process.env.MC_MICROSOFT_EMAIL || '';
const AUTHME_PASSWORD = process.env.AUTHME_PASSWORD || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_KEY = process.env.GROQ_API_KEY;

if (!GROQ_KEY) console.warn('WARNING: GROQ_API_KEY is not set. The bot can connect, but AI commands will not work.');
if (!AUTHME_PASSWORD && !MS_EMAIL) console.warn('WARNING: AUTHME_PASSWORD is not set. AuthMe registration/login will be skipped.');

const app = express();
app.get('/', (_req, res) => res.json({ ok: true, minecraft: `${HOST}:${PORT}`, bot: bot?.username || null, connected: !!bot?.entity }));
app.get('/health', (_req, res) => res.send('ok'));
app.listen(Number(process.env.PORT || 10000), '0.0.0.0', () => console.log('HTTP health server started'));

let bot;
let lastChat = [];
let busy = false;

function setupAuthMe() {
  if (!AUTHME_PASSWORD || MS_EMAIL) return;

  setTimeout(() => {
    if (!bot?.entity) return;
    console.log('AuthMe: sending /register');
    bot.chat(`/register ${AUTHME_PASSWORD} ${AUTHME_PASSWORD}`);
  }, 2500);

  setTimeout(() => {
    if (!bot?.entity) return;
    console.log('AuthMe: sending /login');
    bot.chat(`/login ${AUTHME_PASSWORD}`);
  }, 5000);
}

function connect() {
  const options = {
    host: HOST,
    port: PORT,
    username: MS_EMAIL || USERNAME,
    version: VERSION || undefined,
    auth: MS_EMAIL ? 'microsoft' : 'offline'
  };
  console.log(`Connecting to ${HOST}:${PORT} as ${options.username} (${options.auth})`);
  bot = mineflayer.createBot(options);
  bot.loadPlugin(pathfinder);

  bot.once('spawn', () => {
    console.log(`Logged in as ${bot.username} on ${HOST}:${PORT}`);
    setupAuthMe();
    const mcData = require('minecraft-data')(bot.version);
    const movements = new Movements(bot, mcData);
    bot.pathfinder.setMovements(movements);
    setTimeout(() => bot.chat('AI bot online. Use !ai <request>'), 7000);
  });

  bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    lastChat.push({ username, message, time: new Date().toISOString() });
    lastChat = lastChat.slice(-12);
    if (message.toLowerCase().startsWith('!ai ')) {
      await handleRequest(message.slice(4).trim(), username);
    }
  });

  bot.on('messagestr', message => console.log('Server:', message));
  bot.on('kicked', reason => console.log('Kicked:', reason));
  bot.on('error', err => console.error('Minecraft error:', err.message));
  bot.on('end', () => {
    console.log('Disconnected; reconnecting in 10 seconds...');
    setTimeout(connect, 10000);
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
  if (!request || busy) return;
  if (!GROQ_KEY) return bot.chat('Groq API key is not configured.');
  busy = true;
  try {
    const plan = await askGroq(request, username);
    console.log('AI plan:', JSON.stringify(plan));
    if (plan.message) bot.chat(String(plan.message).slice(0, 240));
    for (const action of Array.isArray(plan.actions) ? plan.actions.slice(0, 5) : []) {
      try { console.log('Action:', await execute(action)); }
      catch (e) { console.warn('Action failed:', e.message); bot.chat(`I couldn't do that: ${e.message}`); }
    }
  } catch (e) {
    console.error('AI error:', e.message);
    bot.chat('AI error. Check the Render logs.');
  } finally { busy = false; }
}

connect();
