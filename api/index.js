'use strict';
// Vercel serverless entry point. vercel.json rewrites /api/* and /media/* here.
module.exports = require('../lib/app.js').handler;
