'use strict';

// Minimal HTTP routing layer over node:http — no external dependencies.

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function compilePath(pattern) {
  const keys = [];
  const source = pattern.replace(/:[A-Za-z_]+/g, (m) => {
    keys.push(m.slice(1));
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${source}$`), keys };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 5_000_000) {
        reject(new ApiError(413, 'payload_too_large', 'Request body exceeds 5 MB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createApp() {
  const routes = [];

  function route(method, pattern, handler) {
    const { regex, keys } = compilePath(pattern);
    routes.push({ method, regex, keys, handler });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    try {
      for (const r of routes) {
        if (r.method !== method) continue;
        const match = url.pathname.match(r.regex);
        if (!match) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(match[i + 1]); });

        let body = null;
        let rawBody = null;
        if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
          rawBody = await readBody(req);
          const ctype = req.headers['content-type'] || '';
          // Binary uploads (file imports) keep rawBody only; everything else
          // is parsed as JSON, matching the API's existing contract.
          if (!/octet-stream|spreadsheet|excel|csv/i.test(ctype)) {
            const text = rawBody.toString('utf8');
            if (text.trim()) {
              try {
                body = JSON.parse(text);
              } catch {
                throw new ApiError(400, 'invalid_json', 'Request body is not valid JSON');
              }
            } else {
              body = {};
            }
          }
        }

        const result = await r.handler({ req, res, params, query: url.searchParams, body, rawBody });
        if (res.writableEnded) return;
        if (result && result.__raw) {
          res.writeHead(result.status || 200, result.headers || {});
          res.end(result.body);
          return;
        }
        const status = (result && result.__status) || 200;
        const payload = result && result.__status !== undefined ? result.data : result;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload ?? null));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not_found', message: `No route for ${req.method} ${url.pathname}` }));
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      if (status === 500) console.error(err);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: err.code || 'internal_error',
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      }));
    }
  }

  return {
    routes,
    handle,
    get: (p, h) => route('GET', p, h),
    post: (p, h) => route('POST', p, h),
    patch: (p, h) => route('PATCH', p, h),
    delete: (p, h) => route('DELETE', p, h),
  };
}

// Wrap a payload with a non-200 success status, e.g. created(obj) → 201.
function created(data) {
  return { __status: 201, data };
}

module.exports = { createApp, ApiError, created };
