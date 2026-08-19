const fs = require('fs');
const path = require('path');

const root = __dirname;
const file = path.join(root, 'bot.js');
let s = fs.readFileSync(file, 'utf8');

// Make the dashboard public: no token is required.
s = s.replace(/const DASHBOARD_TOKEN = process\.env\.DASHBOARD_TOKEN \|\| '';\s*/, "const DASHBOARD_TOKEN = '';\n");
s = s.replace(/function authorized\(req\) \{[\s\S]*?\n\}\n\nfunction auth\(req, res, next\) \{[\s\S]*?\n\}/, "function authorized(req) { return true; }\nfunction auth(req, res, next) { return next(); }");

// Replace the fragile inline template-literal dashboard with a standalone HTML file.
// This avoids escaping/newline issues that previously prevented the browser JS from running.
const start = s.indexOf('const DASHBOARD_HTML = `');
const endMarker = '\n\nif (BOT_ENABLED) connect();';
const end = s.indexOf(endMarker, start);
if (start !== -1 && end !== -1) {
  s = s.slice(0, start) + "const DASHBOARD_HTML = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');" + s.slice(end);
}

// Proxy /viewer/... to the internal Prismarine Viewer without the /viewer prefix.
s = s.replace(/app\.use\(\(req, res, next\) => \{[\s\S]*?\n\}\);\n\nconst server = http\.createServer/, `app.use((req, res, next) => {
  if (req.url === '/viewer' || req.url.startsWith('/viewer/')) {
    req.url = req.url.replace(/^\\/viewer/, '') || '/';
    return viewerProxy.web(req, res);
  }
  next();
});

const server = http.createServer`);

// Proxy WebSocket requests too.
s = s.replace(/server\.on\('upgrade', \(req, socket, head\) => \{[\s\S]*?\n\}\);/, `server.on('upgrade', (req, socket, head) => {
  if (req.url === '/viewer' || req.url.startsWith('/viewer/')) {
    req.url = req.url.replace(/^\\/viewer/, '') || '/';
    viewerProxy.ws(req, socket, head);
  } else {
    socket.destroy();
  }
});`);

fs.writeFileSync(file, s);
console.log('Dashboard standalone HTML fix applied');
