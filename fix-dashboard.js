const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'bot.js');
let s = fs.readFileSync(file, 'utf8');

// The dashboard is public; do not require DASHBOARD_TOKEN.
s = s.replace(/const DASHBOARD_TOKEN = process\.env\.DASHBOARD_TOKEN \|\| '';\s*/, "const DASHBOARD_TOKEN = '';\n");
s = s.replace(/function authorized\(req\) \{[\s\S]*?\n\}\n\nfunction auth\(req, res, next\) \{[\s\S]*?\n\}/, "function authorized(req) { return true; }\nfunction auth(req, res, next) { return next(); }");

// IMPORTANT: bot.js contains the dashboard inside a template literal.
// The dashboard's inner JavaScript needs a literal \\n// so it does not become a real newline inside join('...').
s = s.replace(".join('\\\\n');", ".join('\\\\\\\\n');");

// Make API failures visible instead of leaving the UI on Loading forever.
s = s.replace(
  "}catch(e){document.getElementById('top').innerHTML='<span class=\"err\">'+esc(e.message)+'</span>'}",
  "}catch(e){document.getElementById('top').innerHTML='<span class=\"err\">API error: '+esc(e.message)+'</span>';document.getElementById('status').textContent='API error: '+e.message;document.getElementById('logs').textContent='API error: '+e.message}"
);

// Forward /viewer/... correctly to the internal Prismarine Viewer.
s = s.replace(
`app.use((req, res, next) => {
  if (req.url === '/viewer' || req.url.startsWith('/viewer/')) {
    return viewerProxy.web(req, res);
  }
  next();
});`,
`app.use((req, res, next) => {
  if (req.url === '/viewer' || req.url.startsWith('/viewer/')) {
    req.url = req.url.replace(/^\\/viewer/, '') || '/';
    return viewerProxy.web(req, res);
  }
  next();
});`
);

s = s.replace(
`server.on('upgrade', (req, socket, head) => {
  if (req.url === '/viewer' || req.url.startsWith('/viewer/')) {
    viewerProxy.ws(req, socket, head);
  } else {
    socket.destroy();
  }
});`,
`server.on('upgrade', (req, socket, head) => {
  if (req.url === '/viewer' || req.url.startsWith('/viewer/')) {
    req.url = req.url.replace(/^\\/viewer/, '') || '/';
    viewerProxy.ws(req, socket, head);
  } else {
    socket.destroy();
  }
});`
);

fs.writeFileSync(file, s);
console.log('Dashboard fixes applied before bot startup');
