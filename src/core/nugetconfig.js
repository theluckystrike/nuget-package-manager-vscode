'use strict';
// nuget.config, read the way NuGet reads it: every nuget.config from the solution folder up to the drive root,
// then the user file (~/.nuget/NuGet/NuGet.Config, or %APPDATA%\NuGet\NuGet.Config on Windows). The closest file
// wins; <clear /> drops the sources of the files further away. Credentials: Username + ClearTextPassword (with
// %ENV_VAR% expansion) are used; an encrypted Password (Windows DPAPI) cannot be read here, so the user is asked.

const fs = require('fs');
const os = require('os');
const path = require('path');
const msbuild = require('./msbuild');

const NUGET_ORG = 'https://api.nuget.org/v3/index.json';
const CONFIG_NAMES = ['nuget.config', 'NuGet.config', 'NuGet.Config'];

function userConfigPath(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'NuGet', 'NuGet.Config');
  return path.join(home, '.nuget', 'NuGet', 'NuGet.Config');
}

/** Config files that apply to a folder, closest first. */
function configFiles(dir, opts = {}) {
  const out = [];
  let d = dir;
  for (let k = 0; k < 40; k++) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { /* unreadable */ }
    const hit = names.find((x) => x.toLowerCase() === 'nuget.config');
    if (hit) out.push(path.join(d, hit));
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  const user = opts.userConfig === undefined ? userConfigPath() : opts.userConfig;
  if (user && fs.existsSync(user) && !out.includes(user)) out.push(user);
  return out;
}

function expandEnv(value, env = process.env) {
  return String(value).replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, k) => (env[k] != null ? env[k] : m)).replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, k) => (env[k] != null ? env[k] : m));
}

function decodeKey(k) { return String(k).replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16))); }

/** Parse one nuget.config. Returns {sources: [{key,url,protocolVersion}], clear, disabled: Set, credentials: Map}. */
function parseConfig(text, file) {
  const els = msbuild.scan(String(text).replace(/^﻿/, ''));
  const res = { file, sources: [], removed: [], clear: false, disabled: new Set(), credentials: new Map(), mapping: false };
  const byIndex = (i) => els[i];
  for (const el of els) {
    const name = el.name.toLowerCase();
    if (name === 'packagesources') {
      for (const ci of el.children) {
        const c = byIndex(ci);
        const cn = c.name.toLowerCase();
        if (cn === 'clear') { res.clear = true; res.sources = []; }
        else if (cn === 'add') {
          const key = (msbuild.attr(c, 'key') || {}).value; const value = (msbuild.attr(c, 'value') || {}).value;
          if (key && value) res.sources.push({ key, url: expandEnv(value), protocolVersion: (msbuild.attr(c, 'protocolVersion') || {}).value || '', file });
        } else if (cn === 'remove') {
          const key = String((msbuild.attr(c, 'key') || {}).value || '');
          res.sources = res.sources.filter((s) => s.key.toLowerCase() !== key.toLowerCase());
          res.removed.push(key.toLowerCase());
        }
      }
    } else if (name === 'disabledpackagesources') {
      for (const ci of el.children) {
        const c = byIndex(ci);
        if (c.name.toLowerCase() === 'clear') { res.disabled.clear(); continue; }
        const key = (msbuild.attr(c, 'key') || {}).value; const value = (msbuild.attr(c, 'value') || {}).value;
        if (key && String(value).toLowerCase() === 'true') res.disabled.add(key.toLowerCase());
      }
    } else if (name === 'packagesourcecredentials') {
      for (const ci of el.children) {
        const src = byIndex(ci);
        const cred = { username: '', password: '', encrypted: false };
        for (const ai of src.children) {
          const a = byIndex(ai);
          const key = String((msbuild.attr(a, 'key') || {}).value || '').toLowerCase();
          const value = (msbuild.attr(a, 'value') || {}).value || '';
          if (key === 'username') cred.username = expandEnv(value);
          else if (key === 'cleartextpassword') cred.password = expandEnv(value);
          else if (key === 'password') cred.encrypted = true;
        }
        res.credentials.set(decodeKey(src.name).toLowerCase(), cred);
      }
    } else if (name === 'packagesourcemapping') res.mapping = true;
  }
  return res;
}

/**
 * The effective sources for a folder. Returns {sources: [{key, url, enabled, protocolVersion, file, credential?}],
 * files, errors}. Without any config the default is nuget.org.
 */
function effectiveSources(dir, opts = {}) {
  const files = opts.files || configFiles(dir, opts);
  const errors = [];
  const parsed = [];
  for (const f of files) {
    try { parsed.push(parseConfig(fs.readFileSync(f, 'utf8'), f)); } catch (e) { errors.push(`${f}: ${e.message}`); }
  }
  // Apply from the farthest (user) to the closest; a <clear/> resets what came before.
  let list = [];
  const disabled = new Set();
  const creds = new Map();
  let sawAny = false;
  for (const p of parsed.slice().reverse()) {
    if (p.clear) list = [];
    if (p.removed.length) list = list.filter((x) => !p.removed.includes(x.key.toLowerCase()));
    for (const s of p.sources) {
      sawAny = true;
      list = list.filter((x) => x.key.toLowerCase() !== s.key.toLowerCase());
      list.push({ ...s });
    }
    for (const d of p.disabled) disabled.add(d);
    for (const [k, v] of p.credentials) creds.set(k, v);
  }
  if (!sawAny && !parsed.some((p) => p.clear)) list = [{ key: 'nuget.org', url: NUGET_ORG, protocolVersion: '3', file: null }];
  const sources = list.map((s) => {
    const isHttp = /^https?:\/\//i.test(s.url);
    const v2 = isHttp && !/index\.json(\?.*)?$/i.test(s.url) && s.protocolVersion !== '3';
    return {
      ...s, enabled: !disabled.has(s.key.toLowerCase()), local: !isHttp, v2,
      isNugetOrg: /^https:\/\/api\.nuget\.org\/v3\/index\.json$/i.test(s.url),
      credential: creds.get(s.key.toLowerCase()) || null,
    };
  });
  return { sources, files, errors };
}

module.exports = { effectiveSources, parseConfig, configFiles, userConfigPath, expandEnv, NUGET_ORG };
