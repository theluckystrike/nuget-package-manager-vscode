'use strict';
// Zovo Pro tools: the licence report for the whole solution (CSV) and the one-step migration to central package
// management with a preview diff. Everything else (browse, install, update, remove, outdated, vulnerable and
// deprecated flags, private feeds, consolidation view, restore) is free and stays free.
// Each Pro tool can be used 3 times for free. A try is used only when a file is really written; cancelling at any
// step costs nothing. After the tries, starting the tool shows one modal the user asked for. Nothing about Pro
// shows when the extension starts or a project opens.
// PRO_ENABLED = false makes both tools free (one switch, nothing else changes).

const path = require('path');
const { createLicense } = require('./license');
const V = require('./core/versions');
const msbuild = require('./core/msbuild');
const { Changes } = require('./core/ops');

const PRO_ENABLED = true;
const FREE_TRIES = 3;
const SKU = 'nuget-pro';
const TRIES_KEY = 'zovoNuget.proTries';
const FREE_LIST = 'Browsing, install, update, remove, outdated and vulnerable packages, private feeds and restore stay free.';

function createPro(vscode, context, deps = {}) {
  const license = (deps.createLicense || createLicense)({ vscode, context, sku: SKU, name: 'Zovo', commandPrefix: 'zovoNuget', product: 'NuGet Package Manager' });

  function triesUsed(feature) {
    const t = context.globalState.get(TRIES_KEY, {});
    return Number((t && t[feature]) || 0);
  }

  /** May the user run the tool now? {ok, trial: n or 0}. Does not use a try. */
  async function check(feature, detail) {
    if (!PRO_ENABLED) return { ok: true, trial: 0 };
    await license.ready;
    if (license.isPro(SKU)) { license.refresh().catch(() => {}); return { ok: true, trial: 0 }; }
    const used = triesUsed(feature);
    if (used < FREE_TRIES) return { ok: true, trial: used + 1 };
    const ok = await license.requirePro(feature, `${detail} You used your ${FREE_TRIES} free tries. Zovo Pro is USD 19 once and unlocks the Pro tools in every Zovo extension. Already bought it? Choose Unlock with GitHub Sponsors (one question to GitHub, nothing else is sent) or enter your key. ${FREE_LIST}`);
    return { ok: !!ok, trial: 0 };
  }

  /** Count one try, after the tool wrote its file. */
  async function consume(feature, trial) {
    if (!PRO_ENABLED || !trial) return;
    const t = { ...(context.globalState.get(TRIES_KEY, {}) || {}) };
    t[feature] = Math.max(Number(t[feature] || 0), trial);
    await context.globalState.update(TRIES_KEY, t);
    const left = FREE_TRIES - trial;
    vscode.window.setStatusBarMessage(`NuGet: ${feature} is a Zovo Pro tool. Free try ${trial} of ${FREE_TRIES}${left ? ` (${left} left)` : ', the last one'}.`, 10000);
  }

  function status() {
    return { enabled: PRO_ENABLED, pro: PRO_ENABLED ? license.isPro(SKU) : true, tries: { licence: triesUsed('Licence report'), cpm: triesUsed('Migrate to central package management') }, free: FREE_TRIES };
  }

  return { license, check, consume, status, enabled: PRO_ENABLED };
}

// ---------- licence report ----------

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s;
}

/**
 * rows: from analysis ({projectName, ref, current}); metaById: Map(lowerId -> registration).
 * Returns {csv, summary: [{license, packages}], unknown: n, rows}
 */
function licenceReport(rows, metaById) {
  const out = [];
  for (const r of rows) {
    const m = metaById.get(r.ref.id.toLowerCase());
    const leaf = m && r.current ? m.versions.find((v) => V.compare(v.version, r.current) === 0) : null;
    const licence = leaf ? (leaf.licenseExpression || (leaf.licenseUrl && /aka\.ms\/deprecateLicenseUrl/i.test(leaf.licenseUrl) ? 'file in package' : leaf.licenseUrl ? 'see licence URL' : 'not stated')) : 'unknown (not found on the feeds)';
    out.push({ project: r.projectName, id: r.ref.id, version: r.current || r.ref.declared || '', licence, licenceUrl: leaf ? (leaf.licenseExpression ? `https://licenses.nuget.org/${encodeURIComponent(leaf.licenseExpression)}` : leaf.licenseUrl) : '', projectUrl: leaf ? leaf.projectUrl : '', authors: leaf ? leaf.authors : '', acceptance: leaf && leaf.requireLicenseAcceptance ? 'yes' : '' });
  }
  out.sort((a, b) => a.id.localeCompare(b.id, 'en', { sensitivity: 'base' }) || a.project.localeCompare(b.project));
  const head = ['Package', 'Version', 'Licence', 'Licence URL', 'Project', 'Project URL', 'Authors', 'Requires acceptance'];
  const csv = [head.join(',')].concat(out.map((x) => [x.id, x.version, x.licence, x.licenceUrl, x.project, x.projectUrl, x.authors, x.acceptance].map(csvCell).join(','))).join('\r\n') + '\r\n';
  const counts = new Map();
  const seen = new Set();
  for (const x of out) {
    const k = `${x.id.toLowerCase()}@${x.version}`;
    if (seen.has(k)) continue;
    seen.add(k);
    counts.set(x.licence, (counts.get(x.licence) || 0) + 1);
  }
  const summary = [...counts].map(([license, packages]) => ({ license, packages })).sort((a, b) => b.packages - a.packages);
  return { csv, summary, unknown: out.filter((x) => /^unknown|not stated/.test(x.licence)).length, rows: out };
}

// ---------- migrate to central package management ----------

const PROPS_TEMPLATE = (eol, items, floating) => [
  '<Project>',
  '  <PropertyGroup>',
  '    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>',
  ...(floating ? ['    <CentralPackageFloatingVersionsEnabled>true</CentralPackageFloatingVersionsEnabled>'] : []),
  '  </PropertyGroup>',
  '  <ItemGroup>',
  ...items.map((x) => `    <PackageVersion Include="${x.id.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" Version="${String(x.version).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" />`),
  '  </ItemGroup>',
  '</Project>',
  '',
].join(eol);

/**
 * Plan the move of every project under root that does not use central package management yet.
 * Returns {propsFile, changes (ops.Changes), central: [{id, version}], raised: [{id, project, from, to}],
 * overrides: [{id, project, version}], skipped: [{project, reason}], projects: n}
 */
function planCpm(projects, root) {
  const propsFile = path.join(root, 'Directory.Packages.props');
  const changes = new Changes();
  const skipped = [];
  const todo = [];
  for (const p of projects) {
    if (p.error) { skipped.push({ project: p.name, reason: p.error }); continue; }
    if (p.packagesConfig && !p.refs.length) { skipped.push({ project: p.name, reason: 'uses packages.config' }); continue; }
    if (p.cpm.enabled) { skipped.push({ project: p.name, reason: 'already uses central package management' }); continue; }
    if (!(p.file + path.sep).startsWith(root + path.sep)) { skipped.push({ project: p.name, reason: 'outside the folder' }); continue; }
    todo.push(p);
  }
  // Collect versioned references, each declaration once (Directory.Build.props items are shared by projects).
  const decls = new Map();
  for (const p of todo) {
    for (const r of p.refs) {
      if (!r.raw || !r.declared || r.source === 'override' || r.source === 'global') continue;
      const key = `${r.file}|${r.ref.kind}|${r.ref.id.toLowerCase()}|${r.ref.index}`;
      if (!decls.has(key)) decls.set(key, { r, project: p });
    }
  }
  const byId = new Map();
  for (const d of decls.values()) {
    const k = d.r.id.toLowerCase();
    if (!byId.has(k)) byId.set(k, []);
    byId.get(k).push(d);
  }
  const central = [];
  const raised = [];
  const overrides = [];
  for (const list of byId.values()) {
    const versions = list.map((d) => d.r.declared);
    const best = versions.slice().sort((a, b) => V.compare((V.parseRange(a) || {}).min || V.parse('0'), (V.parseRange(b) || {}).min || V.parse('0'))).pop();
    central.push({ id: list[0].r.id, version: best });
    for (const d of list) {
      const same = d.r.declared === best;
      const viaProperty = !!d.r.property;
      if (!same && d.r.condition) {
        overrides.push({ id: d.r.id, project: d.project.name, version: d.r.declared });
        changes.edit(d.r.file, (t) => {
          const once = msbuild.removeAttribute(t, d.r.ref, 'Version');
          return msbuild.setVersion(once, d.r.ref, d.r.declared, 'VersionOverride').text;
        });
        continue;
      }
      if (!same) raised.push({ id: d.r.id, project: d.project.name, from: d.r.declared, to: best });
      if (viaProperty && d.r.property.file !== d.r.file) { /* the property stays; it is now unused by this item */ }
      changes.edit(d.r.file, (t) => msbuild.removeAttribute(t, d.r.ref, 'Version'));
    }
  }
  central.sort((a, b) => a.id.localeCompare(b.id, 'en', { sensitivity: 'base' }));
  // Central package management refuses floating versions (1.*) unless this is set (NU1011).
  const floating = central.some((c) => /\*/.test(c.version)) || overrides.some((o) => /\*/.test(o.version));
  if (central.length) {
    changes.edit(propsFile, (t) => {
      if (t == null) return PROPS_TEMPLATE('\n', central, floating);
      let out = t;
      const m = msbuild.read(out);
      const has = msbuild.property(m, 'ManagePackageVersionsCentrally');
      out = has ? msbuild.setProperty(out, 'ManagePackageVersionsCentrally', 'true') : msbuild.addProperty(out, 'ManagePackageVersionsCentrally', 'true');
      if (floating) out = msbuild.property(msbuild.read(out), 'CentralPackageFloatingVersionsEnabled') ? msbuild.setProperty(out, 'CentralPackageFloatingVersionsEnabled', 'true') : msbuild.addProperty(out, 'CentralPackageFloatingVersionsEnabled', 'true');
      for (const c of central) {
        const now = msbuild.read(out).items.find((x) => x.kind === 'PackageVersion' && x.id.toLowerCase() === c.id.toLowerCase());
        out = now ? msbuild.setVersion(out, { kind: 'PackageVersion', id: now.id, index: now.index }, c.version).text : msbuild.addItem(out, 'PackageVersion', c.id, c.version);
      }
      return out;
    });
  }
  return { propsFile, changes, central, raised, overrides, skipped, floating, projects: todo.length };
}

module.exports = { createPro, licenceReport, planCpm, csvCell, PRO_ENABLED, FREE_TRIES, SKU };
