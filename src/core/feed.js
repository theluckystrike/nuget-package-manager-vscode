'use strict';
// NuGet v3 client: service index, search, registration (versions, listed, deprecation, vulnerabilities, licence,
// dependencies), flat container (version list fallback), the VulnerabilityInfo resource and the README resource.
// It only calls the feed URL it was given and the URLs that feed's service index names.

const V = require('./versions');

class FeedError extends Error {
  constructor(kind, message, status) { super(message); this.kind = kind; this.status = status || 0; this.friendly = true; }
}

function hostOf(url) { try { return new URL(url).host; } catch { return url; } }

/**
 * opts: {name, url, credential: {username, password}, fetch, timeoutMs, userAgent}
 */
function createFeed(opts) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || 20000;
  const name = opts.name || hostOf(opts.url);
  let indexP = null;
  const cache = new Map();

  function headers() {
    const h = { Accept: 'application/json', 'User-Agent': opts.userAgent || 'NuGet-Package-Manager-VSCode' };
    const c = opts.credential;
    if (c && (c.password || c.username)) h.Authorization = `Basic ${Buffer.from(`${c.username || 'user'}:${c.password || ''}`).toString('base64')}`;
    return h;
  }

  async function get(url, { json = true, allow404 = false } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, { headers: headers(), signal: ctl.signal, redirect: 'follow' });
    } catch (e) {
      clearTimeout(t);
      if (e && e.name === 'AbortError') throw new FeedError('timeout', `${name} did not answer within ${Math.round(timeoutMs / 1000)} s.`);
      throw new FeedError('offline', `Could not reach ${hostOf(url)}. Check the network connection (you may be offline) or the feed URL.`);
    }
    try {
      if (res.status === 401 || res.status === 403) throw new FeedError('auth', `${name} answered ${res.status} (${res.status === 401 ? 'sign-in needed' : 'access denied'}). Set the user name and token for this feed.`, res.status);
      if (res.status === 404 && allow404) return null;
      if (!res.ok) throw new FeedError('http', `${name} answered HTTP ${res.status} for ${new URL(url).pathname}.`, res.status);
      if (!json) return await res.text();
      const body = await res.text();
      try { return JSON.parse(body); } catch { throw new FeedError('bad-response', `${name} sent a reply that is not JSON. Is ${opts.url} a NuGet v3 feed (it ends in index.json)?`); }
    } finally { clearTimeout(t); }
  }

  async function index() {
    if (!indexP) {
      indexP = get(opts.url).then((d) => {
        if (!d || !Array.isArray(d.resources)) throw new FeedError('bad-response', `${opts.url} is not a NuGet v3 service index.`);
        return d;
      });
      indexP.catch(() => { indexP = null; });
    }
    return indexP;
  }

  async function resource(...types) {
    const d = await index();
    for (const t of types) {
      const hit = d.resources.find((r) => r['@type'] === t);
      if (hit) return String(hit['@id']);
    }
    return null;
  }

  /** Search: [{id, version, versions, description, authors, totalDownloads, verified, projectUrl, licenseUrl, tags}] */
  async function search(q, { prerelease = false, skip = 0, take = 30 } = {}) {
    const base = await resource('SearchQueryService/3.5.0', 'SearchQueryService/3.0.0-rc', 'SearchQueryService');
    if (!base) throw new FeedError('no-search', `${name} has no search service.`);
    const u = new URL(base);
    u.searchParams.set('q', q || ''); u.searchParams.set('skip', String(skip)); u.searchParams.set('take', String(take));
    u.searchParams.set('prerelease', prerelease ? 'true' : 'false'); u.searchParams.set('semVerLevel', '2.0.0');
    const d = await get(u.toString());
    return {
      total: d.totalHits || 0,
      items: (d.data || []).map((x) => ({
        id: x.id, version: x.version, description: x.description || x.summary || '', authors: Array.isArray(x.authors) ? x.authors.join(', ') : (x.authors || ''),
        totalDownloads: x.totalDownloads || 0, verified: !!x.verified, projectUrl: x.projectUrl || '', licenseUrl: x.licenseUrl || '',
        tags: x.tags || [], versions: (x.versions || []).map((v) => v.version), deprecated: !!(x.deprecation), vulnerable: Array.isArray(x.vulnerabilities) && x.vulnerabilities.length > 0, feed: name,
      })),
    };
  }

  function leafOf(item) {
    const c = item.catalogEntry || {};
    return {
      version: V.normalize(c.version || ''), rawVersion: c.version || '', listed: c.listed !== false, published: c.published || '',
      description: c.description || '', summary: c.summary || '', authors: c.authors || '', projectUrl: c.projectUrl || '', licenseExpression: c.licenseExpression || '',
      licenseUrl: c.licenseUrl || '', tags: c.tags || [], title: c.title || '', iconUrl: c.iconUrl || '', readmeUrl: c.readmeUrl || '',
      requireLicenseAcceptance: !!c.requireLicenseAcceptance,
      deprecation: c.deprecation ? { reasons: c.deprecation.reasons || [], message: c.deprecation.message || '', alternate: c.deprecation.alternatePackage ? { id: c.deprecation.alternatePackage.id, range: c.deprecation.alternatePackage.range } : null } : null,
      vulnerabilities: (c.vulnerabilities || []).map((v) => ({ url: v.advisoryUrl, severity: Number(v.severity) })),
      dependencyGroups: (c.dependencyGroups || []).map((g) => ({ framework: g.targetFramework || 'any', dependencies: (g.dependencies || []).map((d) => ({ id: d.id, range: d.range })) })),
    };
  }

  /** All versions of a package with metadata, oldest first. null when the feed does not have the package. */
  async function registration(id) {
    const key = `reg|${id.toLowerCase()}`;
    if (cache.has(key)) return cache.get(key);
    const p = (async () => {
      const base = await resource('RegistrationsBaseUrl/3.6.0', 'RegistrationsBaseUrl/3.4.0', 'RegistrationsBaseUrl/3.0.0-rc', 'RegistrationsBaseUrl');
      if (!base) return flatVersions(id);
      const d = await get(`${base.replace(/\/?$/, '/')}${encodeURIComponent(id.toLowerCase())}/index.json`, { allow404: true });
      if (!d) return null;
      const pages = d.items || [];
      const loaded = await mapLimit(pages, 4, async (pg) => (pg.items ? pg : await get(pg['@id'])));
      const leaves = [];
      for (const pg of loaded) for (const it of (pg && pg.items) || []) leaves.push(leafOf(it));
      leaves.sort((a, b) => V.compare(a.version, b.version));
      return { id: (leaves.length && (d.items[0].items || [])[0] && d.items[0].items[0].catalogEntry.id) || id, versions: leaves };
    })();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
    return p;
  }

  async function flatVersions(id) {
    const base = await resource('PackageBaseAddress/3.0.0');
    if (!base) throw new FeedError('no-metadata', `${name} has no package metadata service.`);
    const d = await get(`${base.replace(/\/?$/, '/')}${encodeURIComponent(id.toLowerCase())}/index.json`, { allow404: true });
    if (!d) return null;
    return { id, versions: (d.versions || []).map((v) => ({ version: V.normalize(v), rawVersion: v, listed: true, vulnerabilities: [], dependencyGroups: [] })).sort((a, b) => V.compare(a.version, b.version)) };
  }

  /** The package README (markdown text) for one version, or '' when the feed has none. */
  async function readme(id, version) {
    const tpl = await resource('ReadmeUriTemplate/6.13.0');
    if (!tpl) return '';
    const url = tpl.replace('{lower_id}', encodeURIComponent(id.toLowerCase())).replace('{lower_version}', encodeURIComponent(V.normalize(version).toLowerCase()));
    const t = await get(url, { json: false, allow404: true });
    return t || '';
  }

  /** {updated, byId: Map(lowerId -> [{url, severity, versions}])} or null when the feed has no vulnerability data. */
  async function vulnerabilities(store) {
    const base = await resource('VulnerabilityInfo/6.7.0');
    if (!base) return null;
    const pages = await get(base);
    const stamp = (pages || []).map((p) => p['@updated']).join('|');
    if (store) { const c = await store.get(); if (c && c.stamp === stamp) return { updated: c.updated, byId: new Map(Object.entries(c.data)) }; }
    const data = {};
    for (const pg of pages || []) {
      const d = await get(pg['@id']);
      for (const [k, list] of Object.entries(d || {})) data[k.toLowerCase()] = (data[k.toLowerCase()] || []).concat(list);
    }
    const updated = (pages || []).map((p) => p['@updated']).sort().pop() || '';
    if (store) await store.set({ stamp, updated, data });
    return { updated, byId: new Map(Object.entries(data)) };
  }

  return { name, url: opts.url, index, resource, search, registration, readme, vulnerabilities, get };
}

async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let next = 0;
  const run = async () => { while (next < list.length) { const k = next++; out[k] = await fn(list[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, run));
  return out;
}

const SEVERITY = ['Low', 'Moderate', 'High', 'Critical'];

/** Advisories that match a version. vulns: the byId map from vulnerabilities(). */
function advisoriesFor(vulns, id, version) {
  if (!vulns || !version) return [];
  const list = vulns.byId.get(String(id).toLowerCase()) || [];
  const seen = new Set();
  return list.filter((a) => V.satisfies(a.versions, version)).filter((a) => { const k = a.url; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((a) => ({ url: a.url, severity: Number(a.severity), severityText: SEVERITY[Number(a.severity)] || 'Unknown', range: a.versions }));
}

module.exports = { createFeed, FeedError, advisoriesFor, mapLimit, SEVERITY };
