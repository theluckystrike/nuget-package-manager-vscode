'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFeed, advisoriesFor } = require('../src/core/feed');
const mock = require('./support/mockfeed');

test('feed: private v3 feed with a token: search, registration (inline and paged), readme', async () => {
  const f = await mock.start({ token: 'tok-123' });
  try {
    const feed = createFeed({ name: 'acme', url: f.url, credential: { username: 'gate', password: 'tok-123' } });
    const s = await feed.search('acme', { prerelease: false });
    assert.deepEqual(s.items.map((x) => [x.id, x.version]), [['Acme.Internal', '1.1.0'], ['Acme.Logging', '1.0.0']]);
    const pre = await feed.search('internal', { prerelease: true });
    assert.equal(pre.items[0].version, '2.0.0-beta.1');
    const reg = await feed.registration('Acme.Internal');
    assert.deepEqual(reg.versions.map((v) => v.version), ['1.0.0', '1.1.0', '2.0.0-beta.1']);
    const paged = await feed.registration('acme.logging');
    assert.deepEqual(paged.versions[0].deprecation.reasons, ['Legacy']);
    assert.equal(paged.versions[1].licenseExpression, 'Apache-2.0');
    assert.equal(await feed.registration('Nope'), null);
    assert.match(await feed.readme('Acme.Internal', '1.1.0'), /README for 1\.1\.0/);
    assert.ok(f.log.every((x) => x.auth));
  } finally { await f.close(); }
});

test('feed: 401 without a token, a clear offline message, and a non-v3 URL', async () => {
  const f = await mock.start({ token: 'tok-123' });
  try {
    const feed = createFeed({ name: 'acme', url: f.url });
    await assert.rejects(feed.search('x'), (e) => e.kind === 'auth' && /acme answered 401 \(sign-in needed\)/.test(e.message));
    const wrong = createFeed({ name: 'acme', url: f.url, credential: { username: 'gate', password: 'bad' } });
    await assert.rejects(wrong.registration('Acme.Internal'), (e) => e.kind === 'auth');
  } finally { await f.close(); }
  const off = createFeed({ name: 'nuget.org', url: 'http://127.0.0.1:9/v3/index.json', timeoutMs: 3000 });
  await assert.rejects(off.search('x'), (e) => e.kind === 'offline' && /Could not reach 127\.0\.0\.1:9/.test(e.message));
  const fakeFetch = async () => ({ ok: true, status: 200, text: async () => '<html>not json</html>' });
  const v2 = createFeed({ name: 'old', url: 'https://example.com/api/v2', fetch: fakeFetch });
  await assert.rejects(v2.search('x'), (e) => e.kind === 'bad-response' && /index\.json/.test(e.message));
});

test('feed: vulnerability pages merge, the store skips a refetch, advisories match ranges', async () => {
  const calls = [];
  const pages = { 'https://f/v3/index.json': { resources: [{ '@type': 'VulnerabilityInfo/6.7.0', '@id': 'https://f/vuln/index.json' }] },
    'https://f/vuln/index.json': [{ '@name': 'base', '@id': 'https://f/vuln/base.json', '@updated': '2026-11-07' }, { '@name': 'update', '@id': 'https://f/vuln/upd.json', '@updated': '2026-11-08' }],
    'https://f/vuln/base.json': { 'System.Text.Json': [{ url: 'https://github.com/advisories/GHSA-a', severity: 2, versions: '[8.0.0, 8.0.4]' }] },
    'https://f/vuln/upd.json': { 'system.text.json': [{ url: 'https://github.com/advisories/GHSA-b', severity: 3, versions: '(, 6.0.10)' }] } };
  const fetch = async (u) => { calls.push(u); return { ok: true, status: 200, text: async () => JSON.stringify(pages[u]) }; };
  let saved = null;
  const store = { get: async () => saved, set: async (v) => { saved = v; } };
  const feed = createFeed({ name: 'nuget.org', url: 'https://f/v3/index.json', fetch });
  const v = await feed.vulnerabilities(store);
  assert.equal(v.byId.get('system.text.json').length, 2);
  assert.deepEqual(advisoriesFor(v, 'System.Text.Json', '8.0.0').map((a) => a.severityText), ['High']);
  assert.deepEqual(advisoriesFor(v, 'System.Text.Json', '6.0.0').map((a) => a.severityText), ['Critical']);
  assert.deepEqual(advisoriesFor(v, 'System.Text.Json', '8.0.5'), []);
  const n = calls.length;
  const feed2 = createFeed({ name: 'nuget.org', url: 'https://f/v3/index.json', fetch });
  await feed2.vulnerabilities(store);
  assert.equal(calls.length - n, 2, 'service index + page list only; the cached data is reused');
});
