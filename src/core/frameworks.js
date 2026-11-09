'use strict';
// A small, conservative target framework check: is a package version usable by a project's target framework?
// It reads the dependency groups of the version (from the feed's registration data). When anything is unknown or
// unusual it answers true, so a version is only held back when it clearly does not support the framework
// (for example a net10.0-only package for a net8.0 project).

function parse(tf) {
  const s = String(tf || '').trim().toLowerCase();
  let m;
  if ((m = /^\.netstandard(\d+(?:\.\d+)*)$/.exec(s)) || (m = /^netstandard(\d+(?:\.\d+)*)$/.exec(s))) return { fam: 'ns', v: ver(m[1]) };
  if ((m = /^\.netframework(\d+(?:\.\d+)*)$/.exec(s))) return { fam: 'fx', v: ver(m[1]) };
  if ((m = /^net(\d)(\d)(\d)?$/.exec(s))) return { fam: 'fx', v: [Number(m[1]), Number(m[2]), Number(m[3] || 0)] };
  if ((m = /^\.netcoreapp(\d+(?:\.\d+)*)$/.exec(s)) || (m = /^netcoreapp(\d+(?:\.\d+)*)$/.exec(s))) return { fam: 'core', v: ver(m[1]) };
  if ((m = /^net(\d+\.\d+)(?:-([a-z]+)[\d.]*)?$/.exec(s))) return { fam: 'net', v: ver(m[1]), platform: m[2] || '' };
  return null;
}
function ver(t) { return t.split('.').map(Number).concat([0, 0, 0]).slice(0, 3); }
function le(a, b) { for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; } return true; }

/** Can a project on `proj` use a package group built for `group`? */
function compatible(group, proj) {
  const g = parse(group); const p = parse(proj);
  if (!g || !p) return true;
  if (g.platform && g.platform !== (p.platform || '')) return false;
  if (p.fam === 'net') {
    if (g.fam === 'net') return le(g.v, p.v);
    if (g.fam === 'core') return true;
    if (g.fam === 'ns') return le(g.v, [2, 1, 0]);
    return false;
  }
  if (p.fam === 'core') {
    if (g.fam === 'core') return le(g.v, p.v);
    if (g.fam === 'ns') return le(g.v, le([3, 0, 0], p.v) ? [2, 1, 0] : [2, 0, 0]);
    return false;
  }
  if (p.fam === 'ns') return g.fam === 'ns' && le(g.v, p.v);
  if (p.fam === 'fx') {
    if (g.fam === 'fx') return le(g.v, p.v);
    if (g.fam === 'ns') return le(g.v, le([4, 6, 1], p.v) ? [2, 0, 0] : [1, 6, 0]);
    return false;
  }
  return true;
}

/** True unless the version clearly supports none of its groups for one of the project frameworks. */
function supports(leaf, projectTfms) {
  const groups = (leaf && leaf.dependencyGroups ? leaf.dependencyGroups : []).map((g) => g.framework).filter((f) => f && f !== 'any');
  if (!groups.length || !projectTfms || !projectTfms.length) return true;
  if (groups.some((g) => !parse(g))) return true;
  for (const t of projectTfms) {
    if (!parse(t)) return true;
    if (!groups.some((g) => compatible(g, t))) return false;
  }
  return true;
}

/** Frameworks a reference applies to: a framework named in its condition, else the project's. */
function refFrameworks(condition, projectTfms) {
  const hits = [...String(condition || '').matchAll(/'(net[a-z]*\d[\w.\-]*)'/gi)].map((m) => m[1]).filter((x) => parse(x));
  if (hits.length && /==/.test(condition) && !/!=/.test(condition)) return hits;
  return projectTfms || [];
}

module.exports = { parse, compatible, supports, refFrameworks };
