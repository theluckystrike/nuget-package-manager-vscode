'use strict';
// Package sources for the open folder: nuget.config files plus tokens the user pasted (SecretStorage only).
// Metadata for a package is looked up on each enabled v3 source in nuget.config order; the first that has it wins.

const fs = require('fs');
const path = require('path');
const { effectiveSources } = require('./core/nugetconfig');
const { createFeed, FeedError } = require('./core/feed');

const SECRET_PREFIX = 'zovoNuget.feed.';
const VULN_FILE = 'vulnerabilities-v1.json';

function createFeeds({ vscode, context, root, userAgent }) {
  let sources = [];
  let configFiles = [];
  let configErrors = [];
  const feeds = new Map();
  const secrets = new Map();
  let metaCache = new Map();
  let vulnP = null;

  async function load() {
    const r = effectiveSources(root || process.cwd());
    sources = r.sources; configFiles = r.files; configErrors = r.errors;
    secrets.clear();
    for (const s of sources) {
      try { const v = await context.secrets.get(SECRET_PREFIX + s.url.toLowerCase()); if (v) secrets.set(s.url.toLowerCase(), JSON.parse(v)); } catch { /* keychain unavailable */ }
    }
    feeds.clear(); metaCache = new Map(); vulnP = null;
    return sources;
  }

  function usable() { return sources.filter((s) => s.enabled && !s.local && !s.v2); }

  function credentialFor(s) {
    const saved = secrets.get(s.url.toLowerCase());
    if (saved) return saved;
    if (s.credential && !s.credential.encrypted && s.credential.password) return s.credential;
    return null;
  }

  function feedFor(s) {
    if (!feeds.has(s.url)) feeds.set(s.url, createFeed({ name: s.key, url: s.url, credential: credentialFor(s), userAgent }));
    return feeds.get(s.url);
  }

  function byKey(key) { return usable().find((s) => s.key === key) || null; }

  /** Registration from the first source that has the package; null when none has it. */
  function meta(id) {
    const k = id.toLowerCase();
    if (metaCache.has(k)) return metaCache.get(k);
    const p = (async () => {
      let firstErr = null;
      for (const s of usable()) {
        try {
          const r = await feedFor(s).registration(id);
          if (r) return { ...r, source: s.key };
        } catch (e) { e.source = e.source || s.key; if (!firstErr) firstErr = e; if (e.kind === 'offline' && s.isNugetOrg) break; }
      }
      if (firstErr) throw firstErr;
      return null;
    })();
    metaCache.set(k, p);
    p.catch(() => metaCache.delete(k));
    return p;
  }

  /** nuget.org vulnerability data (cached in global storage, refreshed when the feed says it changed). */
  function vulnerabilities() {
    if (!vulnP) {
      vulnP = (async () => {
        const s = usable().find((x) => x.isNugetOrg);
        if (!s) return null;
        const dir = context.globalStorageUri.fsPath;
        const file = path.join(dir, VULN_FILE);
        const store = {
          get: async () => { try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { return null; } },
          set: async (v) => { try { await fs.promises.mkdir(dir, { recursive: true }); await fs.promises.writeFile(file, JSON.stringify(v)); } catch { /* cache only */ } },
        };
        return feedFor(s).vulnerabilities(store);
      })();
      vulnP.catch(() => { vulnP = null; });
    }
    return vulnP;
  }

  async function setCredential(s, cred) {
    await context.secrets.store(SECRET_PREFIX + s.url.toLowerCase(), JSON.stringify({ username: cred.username || '', password: cred.password || '' }));
    secrets.set(s.url.toLowerCase(), cred);
    feeds.delete(s.url); metaCache = new Map();
  }

  async function clearCredential(s) {
    await context.secrets.delete(SECRET_PREFIX + s.url.toLowerCase());
    secrets.delete(s.url.toLowerCase());
    feeds.delete(s.url); metaCache = new Map();
  }

  function describe() {
    return sources.map((s) => ({
      key: s.key, url: s.url, enabled: s.enabled, local: s.local, v2: s.v2, isNugetOrg: s.isNugetOrg, file: s.file,
      auth: secrets.has(s.url.toLowerCase()) ? 'token saved in VS Code' : s.credential ? (s.credential.encrypted ? 'encrypted password in nuget.config (not readable here)' : 'user name and password from nuget.config') : '',
      usable: s.enabled && !s.local && !s.v2,
    }));
  }

  return { load, usable, feedFor, byKey, meta, vulnerabilities, setCredential, clearCredential, describe, get sources() { return sources; }, get configFiles() { return configFiles; }, get configErrors() { return configErrors; }, clearCache() { metaCache = new Map(); feeds.clear(); } };
}

module.exports = { createFeeds, FeedError };
