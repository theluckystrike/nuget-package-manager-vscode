'use strict';
// A small NuGet v3 feed for tests and the real-app gate: service index, search, registration (one inline page and
// one paged), flat container and README. Every request needs Basic auth user:token when `token` is set, else 401.
const http = require('http');

const PACKAGES = {
  'acme.internal': { id: 'Acme.Internal', versions: ['1.0.0', '1.1.0', '2.0.0-beta.1'], description: 'Internal helpers of Acme.', license: 'MIT' },
  'acme.logging': { id: 'Acme.Logging', versions: ['0.9.0', '1.0.0'], description: 'Logging for Acme services.', license: 'Apache-2.0', deprecated: '0.9.0' },
};

function start({ port = 0, token = '', user = 'gate' } = {}) {
  const log = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    log.push({ path: url.pathname, auth: !!req.headers.authorization });
    const base = `http://127.0.0.1:${server.address().port}`;
    if (token) {
      const want = `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
      if (req.headers.authorization !== want) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="feed"' }); res.end('unauthorized'); return; }
    }
    const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const leaf = (p, v) => ({ '@id': `${base}/reg/${p.id.toLowerCase()}/${v}.json`, catalogEntry: { id: p.id, version: v, listed: true, description: p.description, authors: 'Acme', licenseExpression: p.license, projectUrl: 'https://example.com/acme', published: '2026-01-01T00:00:00Z', deprecation: p.deprecated === v ? { reasons: ['Legacy'], message: 'Use Acme.Logging 1.0.0' } : undefined, dependencyGroups: [{ targetFramework: 'net8.0', dependencies: [{ id: 'Acme.Internal', range: '[1.0.0, )' }] }] } });
    if (url.pathname === '/v3/index.json') return json({ version: '3.0.0', resources: [
      { '@id': `${base}/query`, '@type': 'SearchQueryService/3.5.0' },
      { '@id': `${base}/reg/`, '@type': 'RegistrationsBaseUrl/3.6.0' },
      { '@id': `${base}/flat/`, '@type': 'PackageBaseAddress/3.0.0' },
      { '@id': `${base}/flat/{lower_id}/{lower_version}/readme`, '@type': 'ReadmeUriTemplate/6.13.0' },
    ] });
    if (url.pathname === '/query') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const pre = url.searchParams.get('prerelease') === 'true';
      const data = Object.values(PACKAGES).filter((p) => p.id.toLowerCase().includes(q)).map((p) => { const vs = p.versions.filter((v) => pre || !v.includes('-')); return { id: p.id, version: vs[vs.length - 1], description: p.description, authors: ['Acme'], totalDownloads: 42, versions: vs.map((v) => ({ version: v })) }; });
      return json({ totalHits: data.length, data });
    }
    let m = /^\/reg\/([^/]+)\/index\.json$/.exec(url.pathname);
    if (m) {
      const p = PACKAGES[m[1]];
      if (!p) { res.writeHead(404); res.end(); return; }
      if (m[1] === 'acme.logging') return json({ count: 1, items: [{ '@id': `${base}/reg/acme.logging/page1.json`, lower: '0.9.0', upper: '1.0.0', count: 2 }] });
      return json({ count: 1, items: [{ '@id': `${base}/reg/${m[1]}/index.json#page`, lower: p.versions[0], upper: p.versions[p.versions.length - 1], items: p.versions.map((v) => leaf(p, v)) }] });
    }
    if (url.pathname === '/reg/acme.logging/page1.json') { const p = PACKAGES['acme.logging']; return json({ items: p.versions.map((v) => leaf(p, v)) }); }
    m = /^\/flat\/([^/]+)\/index\.json$/.exec(url.pathname);
    if (m && PACKAGES[m[1]]) return json({ versions: PACKAGES[m[1]].versions });
    m = /^\/flat\/([^/]+)\/([^/]+)\/readme$/.exec(url.pathname);
    if (m && PACKAGES[m[1]]) { res.writeHead(200, { 'Content-Type': 'text/markdown' }); res.end(`# ${PACKAGES[m[1]].id}\n\nREADME for ${m[2]}.`); return; }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}/v3/index.json`, log, close: () => new Promise((r) => server.close(r)) })));
}

module.exports = { start, PACKAGES };

if (require.main === module) {
  start({ port: Number(process.argv[2] || 0), token: process.argv[3] || '' }).then((f) => console.log(`mock feed ${f.url}`));
}
