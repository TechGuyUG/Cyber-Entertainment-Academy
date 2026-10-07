'use strict';
// Local development server: `npm start` -> http://localhost:3000  (admin: /admin)
// Not used on Vercel (Vercel runs api/index.js and serves /public from its CDN).
const http = require('http');
const { handler, init, PORT } = require('./lib/app.js');

init().then(() => {
  const srv = http.createServer(handler).listen(PORT, () => console.log('Cyber Entertainment running on http://localhost:' + PORT));
  srv.requestTimeout = 18e5;
}).catch(e => { console.error('Startup failed:', e); process.exit(1); });
