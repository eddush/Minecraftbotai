const fs = require('fs');
const path = require('path');

const root = __dirname;
const file = path.join(root, 'bot.js');
let s = fs.readFileSync(file, 'utf8');

// Ensure bot.js can load the standalone dashboard.
if (!/^const fs = require\('fs'\);/m.test(s)) {
  s = "const fs = require('fs');\nconst path = require('path');\n\n" + s;
}

// Dashboard is public; no token is required.
s = s.replace(/const DASHBOARD_TOKEN = process\.env\.DASHBOARD_TOKEN \|\| '';\s*/, "const DASHBOARD_TOKEN = '';\n");
s = s.replace(/function authorized\(req\) \{[\s\S]*?\n\}\n\nfunction auth\(req, res, next\) \{[\s\S]*?\n\}/, "function authorized(req) { return true; }\nfunction auth(req, res, next) { return next(); }");

// Use the standalone dashboard file instead of the fragile inline template.
const start = s.indexOf('const DASHBOARD_HTML = `');
const endMarker = '\n\nif (BOT_ENABLED) connect();';
const end = s.indexOf(endMarker, start);
if (start !== -1 && end !== -1) {
  s = s.slice(0, start) + "const DASHBOARD_HTML = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');" + s.slice(end);
}

// Make the API routes impossible to cache and add a tiny ping endpoint.
if (!s.includes("app.get('/api/ping'")) {
  const marker = "app.get('/api/status', auth, (_req, res) => {";
  const injection = "app.get('/api/ping', (_req, res) => {\n  res.set('Cache-Control', 'no-store');\n  res.json({ ok: true, time: Date.now() });\n});\n\n";
  s = s.replace(marker, injection + marker);
}
s = s.replace("app.get('/api/status', auth, (_req, res) => {", "app.get('/api/status', auth, (_req, res) => {\n  res.set('Cache-Control', 'no-store');");
s = s.replace("app.get('/api/logs', auth, (_req, res) => res.json({ ok: true, logs }));", "app.get('/api/logs', auth, (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ ok: true, logs }); });");
s = s.replace("app.get('/api/chat', auth, (_req, res) => res.json({ ok: true, chat }));", "app.get('/api/chat', auth, (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ ok: true, chat }); });");

// Correct Viewer proxy paths.
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
console.log('Dashboard/API runtime fix applied');
