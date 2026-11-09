'use strict';
// Outdated, vulnerable, deprecated and consolidation views over a scan, given package metadata.

const V = require('./versions');
const { advisoriesFor, mapLimit } = require('./feed');
const F = require('./frameworks');

/** The version a declaration resolves to, from the known versions (or the declared lower bound). */
function currentVersion(declared, versions) {
  const r = V.parseRange(declared);
  if (!r) return null;
  if (r.simple || r.exact) return V.normalize(r.min);
  const list = (versions || []).map((v) => v.version);
  const hit = V.resolve(r, list);
  return hit || (r.min ? V.normalize(r.min) : null);
}

/**
 * Rows for every reference: {projectFile, projectName, ref, current, latest, latestInRange, kind, target, outdated,
 * deprecation, advisories, missing}. meta(id) returns the registration ({versions}) or null; it may throw.
 */
async function analyze(projects, meta, opts = {}) {
  const ids = new Map();
  for (const p of projects) for (const r of p.refs) ids.set(r.id.toLowerCase(), r.id);
  const metaById = new Map();
  const errors = [];
  await mapLimit([...ids.values()], opts.concurrency || 6, async (id) => {
    try { metaById.set(id.toLowerCase(), await meta(id)); } catch (e) { errors.push({ id, message: e.message, kind: e.kind, source: e.source || '' }); metaById.set(id.toLowerCase(), undefined); }
  });
  const rows = [];
  for (const p of projects) {
    for (const r of p.refs) {
      const m = metaById.get(r.id.toLowerCase());
      const listed = m ? m.versions.filter((v) => v.listed !== false) : [];
      const row = { projectFile: p.file, projectName: p.name, ref: r, current: null, latest: null, latestInRange: null, kind: 'unknown', target: null, outdated: false, deprecation: null, advisories: [], missing: m === null, failed: m === undefined };
      if (r.declared) {
        row.current = currentVersion(r.declared, m ? m.versions : []);
        // Offer only versions that support the frameworks this reference builds for (a net10.0-only release is
        // no update for a net8.0 project); the newest version overall is kept for the note.
        const tfms = F.refFrameworks(r.condition, p.tfms);
        const usable = listed.filter((v) => F.supports(v, tfms));
        const all = V.updateTarget(r.declared, listed.map((v) => v.version), !!opts.prerelease);
        const t = V.updateTarget(r.declared, usable.map((v) => v.version), !!opts.prerelease);
        Object.assign(row, { latest: t.latest, latestInRange: t.latestInRange, kind: t.kind });
        if (all.latest && t.latest !== all.latest) row.newerNeedsFramework = all.latest;
        row.target = t.kind === 'range' || t.kind === 'exact' ? (t.latestInRange && V.compare(t.latestInRange, row.current) > 0 ? t.latestInRange : (t.kind === 'exact' && t.latest && V.compare(t.latest, row.current) > 0 ? t.latest : null)) : (t.kind === 'simple' && t.latest && V.compare(t.latest, row.current) > 0 ? t.latest : null);
        row.outdated = !!row.target;
        if (m && row.current) {
          const leaf = m.versions.find((v) => V.compare(v.version, row.current) === 0);
          if (leaf && leaf.deprecation) row.deprecation = leaf.deprecation;
          if (leaf && leaf.vulnerabilities && leaf.vulnerabilities.length && !opts.vulns) row.advisories = leaf.vulnerabilities.map((v) => ({ url: v.url, severity: v.severity, severityText: ['Low', 'Moderate', 'High', 'Critical'][v.severity] || 'Unknown' }));
        }
        if (opts.vulns && row.current) row.advisories = advisoriesFor(opts.vulns, r.id, row.current);
      }
      rows.push(row);
    }
  }
  return { rows, errors, metaById };
}

/** Packages used in more than one version across the projects: [{id, versions: [{version, projects: [...]}]}]. */
function consolidation(projects) {
  const map = new Map();
  for (const p of projects) for (const r of p.refs) {
    if (!r.declared) continue;
    const k = r.id.toLowerCase();
    if (!map.has(k)) map.set(k, { id: r.id, versions: new Map() });
    const v = V.parse(r.declared) ? V.normalize(r.declared) : r.declared;
    const e = map.get(k).versions;
    if (!e.has(v)) e.set(v, []);
    if (!e.get(v).includes(p.name)) e.get(v).push(p.name);
  }
  return [...map.values()].filter((x) => x.versions.size > 1).map((x) => ({ id: x.id, versions: [...x.versions].map(([version, ps]) => ({ version, projects: ps })).sort((a, b) => V.compare(a.version, b.version)) }));
}

module.exports = { analyze, currentVersion, consolidation };
