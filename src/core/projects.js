'use strict';
// Find .NET projects and solutions in a folder and read their package references, the way MSBuild sees them:
// PackageReference in the project, versions from Directory.Packages.props (central package management),
// VersionOverride, $(Property) versions, PackageReference items and properties from Directory.Build.props, and
// GlobalPackageReference. Only local files are read here; nothing goes to the network.

const fs = require('fs');
const path = require('path');
const msbuild = require('./msbuild');

const PROJECT_EXT = new Set(['.csproj', '.fsproj', '.vbproj']);
const SKIP_DIRS = new Set(['node_modules', 'bin', 'obj', '.git', '.vs', '.idea', 'packages', '.nuget', 'artifacts', 'TestResults', '.vscode-test']);

/** Walk folders and collect project, solution and config files. Stops after maxEntries directory entries. */
async function discover(roots, opts = {}) {
  const maxEntries = opts.maxEntries || 60000;
  const out = { projects: [], solutions: [], packagesConfigs: [], truncated: false };
  let seen = 0;
  const walk = async (dir, depth) => {
    if (depth > 12 || out.truncated) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > maxEntries) { out.truncated = true; return; }
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(p, depth + 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (PROJECT_EXT.has(ext)) out.projects.push(p);
        else if (ext === '.sln' || ext === '.slnx') out.solutions.push(p);
        else if (e.name.toLowerCase() === 'packages.config') out.packagesConfigs.push(p);
      }
    }
  };
  for (const r of roots) await walk(r, 0);
  out.projects.sort(); out.solutions.sort();
  return out;
}

/** Project paths listed in a .sln (text) or .slnx (XML) file, absolute. */
function solutionProjects(file, text) {
  const dir = path.dirname(file);
  const res = [];
  if (file.toLowerCase().endsWith('.slnx')) {
    try {
      const els = msbuild.scan(text.replace(/^﻿/, ''));
      for (const el of els) {
        if (el.name !== 'Project') continue;
        const p = msbuild.attr(el, 'Path');
        if (p && PROJECT_EXT.has(path.extname(p.value).toLowerCase())) res.push(path.resolve(dir, p.value.replace(/\\/g, '/')));
      }
    } catch { /* a broken slnx lists nothing */ }
    return res;
  }
  const re = /^Project\("\{[^}]+\}"\)\s*=\s*"[^"]*",\s*"([^"]+)"/gm;
  let m;
  while ((m = re.exec(text))) {
    const rel = m[1].replace(/\\/g, '/');
    if (PROJECT_EXT.has(path.extname(rel).toLowerCase())) res.push(path.resolve(dir, rel));
  }
  return res;
}

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}

/** The nearest file with this name in dir or a parent folder (MSBuild's rule for Directory.*.props). */
function findUp(dir, name, cache) {
  const key = `${dir}|${name}`;
  if (cache && cache.has(key)) return cache.get(key);
  let d = dir;
  let hit = null;
  for (let k = 0; k < 40; k++) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { /* unreadable */ }
    const f = names.find((x) => x.toLowerCase() === name.toLowerCase());
    if (f) { hit = path.join(d, f); break; }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  if (cache) cache.set(key, hit);
  return hit;
}

function loadProps(file, cache) {
  if (!file) return null;
  if (cache && cache.has(file)) return cache.get(file);
  let res;
  try { res = { file, model: msbuild.read(readText(file)) }; } catch (e) { res = { file, error: e.message }; }
  if (cache) cache.set(file, res);
  return res;
}

/** Resolve an <Import Project="..."> path of a props file; null when it cannot be resolved here. */
function importPath(fromFile, el) {
  const raw = ((msbuild.attr(el, 'Project') || {}).value || '').trim();
  if (!raw) return null;
  const dir = path.dirname(fromFile);
  let m = /^\$\(\[MSBuild\]::GetPathOfFileAbove\(\s*'?([^',)]+)'?\s*(?:,\s*'?([^')]*)'?\s*)?\)\)$/i.exec(raw);
  if (m) {
    const start = m[2] ? path.resolve(dir, m[2].replace(/\$\(MSBuildThisFileDirectory\)/gi, `${dir}/`).replace(/\\/g, '/')) : path.dirname(dir);
    return findUp(start, m[1].trim(), null);
  }
  m = /^\$\(\[MSBuild\]::GetDirectoryNameOfFileAbove\(\s*'?([^',)]+)'?\s*,\s*'?([^')]+)'?\s*\)\)[\\/](.+)$/i.exec(raw);
  if (m) {
    const start = path.resolve(dir, m[1].replace(/\$\(MSBuildThisFileDirectory\)/gi, `${dir}/`).replace(/\\/g, '/'));
    const hit = findUp(start, m[2].trim(), null);
    return hit ? path.join(path.dirname(hit), m[3].replace(/\\/g, '/')) : null;
  }
  const p = raw.replace(/\$\(MSBuildThisFileDirectory\)/gi, `${dir}/`).replace(/\\/g, '/');
  if (/\$\(|[*?]/.test(p)) return null;
  return path.resolve(dir, p);
}

/** A props file and the props files it imports (depth first, at most 8 levels). */
function propsChain(file, cache, depth = 0, seen = new Set()) {
  const head = loadProps(file, cache);
  if (!head) return [];
  if (seen.has(file)) return [];
  seen.add(file);
  const out = [head];
  if (!head.model || depth > 8) return out;
  for (const el of head.model.els) {
    if (el.name !== 'Import' || el.parent !== 0) continue;
    const target = importPath(file, el);
    if (!target || !/\.props$/i.test(target) || !fs.existsSync(target)) continue;
    out.push(...propsChain(target, cache, depth + 1, seen));
  }
  return out;
}

const PROP_REF = /^\$\(([A-Za-z_][\w.-]*)\)$/;

/** Look a property up in the project, then Directory.Build.props, then Directory.Packages.props. */
function lookupProperty(name, sources) {
  for (const s of sources) {
    if (!s || !s.model) continue;
    const p = msbuild.property(s.model, name);
    if (p) return { file: s.file, name: p.name, value: p.value };
  }
  return null;
}

function truthy(v) { return String(v || '').trim().toLowerCase() === 'true'; }

/**
 * Read one project. ctx.cache is shared across projects of a scan.
 * Returns {file, name, kind, error?, packagesConfig, sdkStyle, tfms, cpm: {enabled, propsFile}, refs: [...]}
 */
function loadProject(file, ctx = {}) {
  const cache = ctx.cache || new Map();
  const dir = path.dirname(file);
  const res = {
    file, dir, name: path.basename(file).replace(/\.(cs|fs|vb)proj$/i, ''), kind: path.extname(file).slice(1).toLowerCase(),
    packagesConfig: fs.existsSync(path.join(dir, 'packages.config')), refs: [], tfms: [], cpm: { enabled: false, propsFile: null },
  };
  let model;
  try { model = msbuild.read(readText(file)); } catch (e) { res.error = `${path.basename(file)} could not be read: ${e.message}`; return res; }
  res.sdkStyle = !!model.sdk || model.els.some((e) => e.name === 'Sdk' || (e.name === 'Import' && /Sdk/.test((msbuild.attr(e, 'Sdk') || {}).value || '')));
  const buildChain = propsChain(findUp(dir, 'Directory.Build.props', cache), cache);
  const pkgChain = propsChain(findUp(dir, 'Directory.Packages.props', cache), cache);
  const buildProps = buildChain[0] || null;
  const pkgProps = pkgChain[0] || null;
  const self = { file, model };
  const sources = [self, ...buildChain, ...pkgChain];
  const resolveValue = (v) => {
    let cur = v; let prop = null;
    for (let k = 0; k < 4 && cur; k++) {
      const m = PROP_REF.exec(cur);
      if (!m) break;
      const hit = lookupProperty(m[1], sources);
      if (!hit) return { value: null, unresolved: m[1], prop };
      prop = prop || hit;
      cur = hit.value;
    }
    return { value: cur, prop };
  };
  const tfProp = lookupProperty('TargetFrameworks', sources) || lookupProperty('TargetFramework', sources);
  const tf = resolveValue(tfProp ? tfProp.value : '');
  res.tfms = String(tf.value || '').split(';').map((x) => x.trim()).filter(Boolean);
  // Central package management: the project wins, then Directory.Build.props, then Directory.Packages.props.
  let cpmValue = null;
  for (const s of sources) {
    if (!s || !s.model) continue;
    const p = msbuild.property(s.model, 'ManagePackageVersionsCentrally');
    if (p) { cpmValue = p.value; break; }
  }
  res.cpm = { enabled: truthy(cpmValue) && !!(pkgProps && pkgProps.model), propsFile: pkgProps ? pkgProps.file : null, error: pkgProps && pkgProps.error };
  const central = new Map();
  if (res.cpm.enabled) {
    pkgProps.model.items.filter((x) => x.kind === 'PackageVersion').forEach((x) => {
      const k = x.id.toLowerCase();
      if (!central.has(k) || (!x.condition && central.get(k).condition)) central.set(k, x);
    });
  }
  const refs = [];
  const add = (item, ownerFile, inherited) => {
    const r = {
      id: item.id, kind: item.kind, condition: item.condition, inherited: inherited || null, privateAssets: item.privateAssets,
      file: ownerFile, ref: { kind: item.kind, id: item.id, index: item.index }, itemFile: ownerFile, itemRef: { kind: item.kind, id: item.id, index: item.index }, raw: null, declared: null, source: 'project', which: 'Version', property: null,
    };
    let raw = null;
    if (item.kind === 'GlobalPackageReference') { raw = item.version; r.source = 'global'; }
    else if (item.versionOverride) { raw = item.versionOverride; r.source = 'override'; r.which = 'VersionOverride'; }
    else if (item.version) { raw = item.version; r.source = inherited ? 'inherited' : 'project'; }
    else if (res.cpm.enabled) {
      const c = central.get(item.id.toLowerCase());
      if (c) { raw = c.version; r.source = 'central'; r.file = pkgProps.file; r.ref = { kind: 'PackageVersion', id: c.id, index: c.index }; r.centralCondition = c.condition; }
      else r.missingCentral = true;
    }
    r.raw = raw;
    if (raw) {
      const v = resolveValue(raw);
      r.declared = v.value;
      if (v.prop) r.property = { file: v.prop.file, name: v.prop.name };
      if (v.unresolved) r.unresolvedProperty = v.unresolved;
    }
    refs.push(r);
  };
  for (const it of model.items) if (it.kind === 'PackageReference' && !it.isUpdate) add(it, file, null);
  for (const it of model.items) if (it.kind === 'PackageReference' && it.isUpdate) {
    // <PackageReference Update="X" Version="..."/> changes the version of an item declared elsewhere.
    const target = refs.find((r) => r.id.toLowerCase() === it.id.toLowerCase());
    if (target && it.version) { target.raw = it.version; target.declared = resolveValue(it.version).value; target.file = file; target.ref = { kind: it.kind, id: it.id, index: it.index }; target.source = 'project'; }
  }
  for (const bp of buildChain) if (bp.model) for (const it of bp.model.items) if (it.kind === 'PackageReference' && !it.isUpdate) add(it, bp.file, bp.file);
  if (res.cpm.enabled) for (const it of pkgProps.model.items) if (it.kind === 'GlobalPackageReference') add(it, pkgProps.file, pkgProps.file);
  res.refs = refs;
  res.buildPropsFile = buildProps ? buildProps.file : null;
  return res;
}

/** Scan folders: projects, solutions (with their project lists) and the packages.config projects. */
async function scanWorkspace(roots, opts = {}) {
  const found = await discover(roots, opts);
  const cache = new Map();
  const projects = found.projects.map((f) => loadProject(f, { cache }));
  const solutions = found.solutions.map((f) => {
    let list = [];
    try { list = solutionProjects(f, fs.readFileSync(f, 'utf8')); } catch { /* unreadable */ }
    return { file: f, name: path.basename(f), projects: list.filter((p) => projects.some((x) => x.file === p)) };
  });
  const legacy = found.packagesConfigs.filter((pc) => !projects.some((p) => p.dir === path.dirname(pc)));
  projects.push(...centralPins(projects, cache));
  return { projects, solutions, packagesConfigs: legacy, truncated: found.truncated };
}

/**
 * PackageVersion lines of a Directory.Packages.props that no project references directly (pins for transitive
 * packages, or leftovers). They get their own entry, named after the props file, so "Update all" and the
 * outdated and vulnerable views include them. Installing into this entry is not offered.
 */
function centralPins(projects, cache) {
  const byProps = new Map();
  for (const p of projects) if (p.cpm && p.cpm.enabled && p.cpm.propsFile) {
    if (!byProps.has(p.cpm.propsFile)) byProps.set(p.cpm.propsFile, []);
    byProps.get(p.cpm.propsFile).push(p);
  }
  const out = [];
  for (const [file, users] of byProps) {
    const chain = propsChain(file, cache);
    const props = chain[0];
    if (!props || !props.model) continue;
    const used = new Set();
    for (const p of users) for (const r of p.refs) used.add(r.id.toLowerCase());
    const pins = props.model.items.filter((x) => x.kind === 'PackageVersion' && !used.has(x.id.toLowerCase()));
    if (!pins.length) continue;
    const refs = pins.map((x) => {
      const ref = { kind: 'PackageVersion', id: x.id, index: x.index };
      const r = { id: x.id, kind: 'PackageVersion', condition: x.condition, inherited: null, privateAssets: '', file, ref, itemFile: file, itemRef: ref, raw: x.version, declared: x.version, source: 'pin', which: 'Version', property: null };
      const m = x.version && PROP_REF.exec(x.version);
      if (m) {
        const hit = lookupProperty(m[1], chain);
        if (hit) { r.declared = hit.value; r.property = { file: hit.file, name: hit.name }; } else r.unresolvedProperty = m[1];
      }
      return r;
    });
    out.push({ file, dir: path.dirname(file), name: path.basename(file), kind: 'props', isProps: true, packagesConfig: false, refs, tfms: [], cpm: { enabled: true, propsFile: file }, sdkStyle: true, buildPropsFile: null });
  }
  return out;
}

/** Group a scan's references by package id (for the Installed view and consolidation). */
function packagesById(projects) {
  const map = new Map();
  for (const p of projects) {
    for (const r of p.refs) {
      const k = r.id.toLowerCase();
      if (!map.has(k)) map.set(k, { id: r.id, uses: [] });
      map.get(k).uses.push({ project: p.file, projectName: p.name, ref: r });
    }
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { sensitivity: 'base' }));
}

module.exports = { centralPins, discover, solutionProjects, loadProject, scanWorkspace, packagesById, findUp, PROJECT_EXT };
