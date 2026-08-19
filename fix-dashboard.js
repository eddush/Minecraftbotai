const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'bot.js');
let s = fs.readFileSync(file, 'utf8');

if (!/^const fs = require\('fs'\);/m.test(s)) {
  s = "const fs = require('fs');\nconst path = require('path');\n\n" + s;
}

// Public dashboard: disable token checks.
s = s.replace(/const DASHBOARD_TOKEN = process\.env\.DASHBOARD_TOKEN \|\| '';\s*/, "const DASHBOARD_TOKEN = '';\n");
s = s.replace(/function authorized\(req\) \{[\s\S]*?\n\}\n\nfunction auth\(req, res, next\) \{[\s\S]*?\n\}/, "function authorized(req) { return true; }\nfunction auth(req, res, next) { return next(); }");

// Use the standalone dashboard file.
const dashboardDecl = "const DASHBOARD_HTML = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');";
const start = s.indexOf('const DASHBOARD_HTML = ');
const endMarker = '\n\nif (BOT_ENABLED) connect();';
const end = s.indexOf(endMarker);
if (start !== -1 && end !== -1) {
  s = s.slice(0, start) + dashboardDecl + s.slice(end);
}

// dashboard.html requires /api/ping. Insert it by the stable status-route marker.
if (!s.includes("app.get('/api/ping'")) {
  const marker = "app.get('/api/status', auth, (_req, res) => {";
  const i = s.indexOf(marker);
  if (i === -1) {
    console.error('ERROR: could not find /api/status route');
    process.exit(1);
  }
  const ping = "app.get('/api/ping', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ ok: true, time: Date.now() }); });\n\n";
  s = s.slice(0, i) + ping + s.slice(i);
}

// Disable browser/proxy caching for API responses.
s = s.replace("app.get('/api/status', auth, (_req, res) => {", "app.get('/api/status', auth, (_req, res) => {\n  res.set('Cache-Control', 'no-store');");
s = s.replace("app.get('/api/logs', auth, (_req, res) => res.json({ ok: true, logs }));", "app.get('/api/logs', auth, (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ ok: true, logs }); });");
s = s.replace("app.get('/api/chat', auth, (_req, res) => res.json({ ok: true, chat }));", "app.get('/api/chat', auth, (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ ok: true, chat }); });");

// Correct Viewer proxy paths for HTTP and WebSocket.
s = s.replace(/app\.use\(\(req, res, next\) => \{[\s\S]*?\n\}\);\n\nconst server = http\.createServer/, `app.use((req, res, next) => {
  if (req.url === '/viewer' || req.url.startsWith('/viewer/')) {
    req.url = req.url.replace(/^\\/viewer/, '') || '/';
    return viewerProxy.web(req, res);
  }
  next();
});

const server = http.createServer`);
s = s.replace(/server\.on\('upgrade', \(req, socket, head\) => \{[\s\S]*?\n\}\);/, `server.on('upgrade', (req, socket, head) => {
  if (req.url === '/viewer' || req.url.startsWith('/viewer/')) {
    req.url = req.url.replace(/^\\/viewer/, '') || '/';
    viewerProxy.ws(req, socket, head);
  } else {
    socket.destroy();
  }
});`);

fs.writeFileSync(file, s);
console.log('Dashboard/API runtime fix applied: /api/ping ensured');
