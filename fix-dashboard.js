const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'bot.js');
let s = fs.readFileSync(file, 'utf8');

// Dashboard is intentionally public: no DASHBOARD_TOKEN is required.
s = s.replace(/const DASHBOARD_TOKEN = process\.env\.DASHBOARD_TOKEN \|\| '';\n/, "const DASHBOARD_TOKEN = '';\n");
s = s.replace(/function authorized\(req\) \{[\s\S]*?\n\}\n\nfunction auth\(req, res, next\) \{[\s\S]*?\n\}\n/, "function authorized(req) { return true; }\nfunction auth(req, res, next) { return next(); }\n");

// Make the viewer proxy strip /viewer before forwarding to Prismarine Viewer.
s = s.replace(/app\.use\(\(req, res, next\) => \{\n  if \(req\.url === '\/viewer' \|\| req\.url\.startsWith\('\/viewer\/'\)\) \{\n    return viewerProxy\.web\(req, res\);\n  \}\n  next\(\);\n\}\);/, `app.use((req, res, next) => {
  if (req.url === '/viewer' || req.url.startsWith('/viewer/')) {
    req.url = req.url.replace(/^\\/viewer/, '') || '/';
    return viewerProxy.web(req, res);
  }
  next();
});`);

s = s.replace(/server\.on\('upgrade', \(req, socket, head\) => \{\n  if \(req\.url === '\/viewer' \|\| req\.url\.startsWith\('\/viewer\/'\)\) \{\n    viewerProxy\.ws\(req, socket, head\);\n  \} else \{\n    socket\.destroy\(\);\n  \}\n\}\);/, `server.on('upgrade', (req, socket, head) => {
  if (req.url === '/viewer' || req.url.startsWith('/viewer/')) {
    req.url = req.url.replace(/^\\/viewer/, '') || '/';
    viewerProxy.ws(req, socket, head);
  } else {
    socket.destroy();
  }
});`);

fs.writeFileSync(file, s);
console.log('Dashboard runtime fixes applied');
