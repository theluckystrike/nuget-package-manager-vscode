'use strict';
// NuGet versions and version ranges (the rules NuGet itself uses):
//   1.2.3, 1.2.3.4, 1.2.3-beta.1, 1.2.3+build (metadata is ignored when comparing),
//   ranges "1.0" (>= 1.0), "[1.0]" (exact), "[1.0,2.0)", "(,2.0]", and floating "1.*", "1.2.*-*", "*".
// Prerelease labels compare part by part: numbers by value, text case-insensitively, a number sorts before text,
// and a release sorts after every prerelease of the same version.

const RE = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?\s*$/;

/** Parse a version; null when it is not a NuGet version. */
function parse(text) {
  const m = RE.exec(String(text == null ? '' : text));
  if (!m) return null;
  return {
    major: +m[1], minor: +(m[2] || 0), patch: +(m[3] || 0), revision: +(m[4] || 0),
    pre: m[5] ? m[5].split('.') : [], meta: m[6] || '', text: String(text).trim(),
  };
}

function isPrerelease(v) {
  const p = typeof v === 'string' ? parse(v) : v;
  return !!(p && p.pre.length);
}

function comparePre(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const x = a[i]; const y = b[i];
    const nx = /^\d+$/.test(x); const ny = /^\d+$/.test(y);
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d < 0 ? -1 : 1; continue; }
    if (nx) return -1;
    if (ny) return 1;
    const c = x.toLowerCase().localeCompare(y.toLowerCase(), 'en');
    if (c) return c < 0 ? -1 : 1;
  }
  return 0;
}

/** Compare two versions (strings or parsed). Unparsable versions sort first. */
function compare(a, b) {
  const x = typeof a === 'string' ? parse(a) : a;
  const y = typeof b === 'string' ? parse(b) : b;
  if (!x && !y) return 0;
  if (!x) return -1;
  if (!y) return 1;
  for (const k of ['major', 'minor', 'patch', 'revision']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  return comparePre(x.pre, y.pre);
}

/** Normalized text: 1.0 -> 1.0.0, 1.2.3.0 -> 1.2.3, metadata dropped. */
function normalize(v) {
  const p = typeof v === 'string' ? parse(v) : v;
  if (!p) return String(v);
  return `${p.major}.${p.minor}.${p.patch}${p.revision ? `.${p.revision}` : ''}${p.pre.length ? `-${p.pre.join('.')}` : ''}`;
}

/**
 * Parse a version range. Returns {min, minInclusive, max, maxInclusive, float, exact, text} or null.
 * float is {prefix: [numbers], pre: bool} for "1.*", "1.2.*-*", "*".
 */
function parseRange(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;
  if (/\*/.test(t)) {
    const m = /^(\d+(?:\.\d+)*\.)?\*(-\*|-[0-9A-Za-z.-]*\*)?$|^(\d+(?:\.\d+)*)-\*$|^(\d+(?:\.\d+)*)-([0-9A-Za-z.-]+)\*$/.exec(t);
    if (!m) return null;
    if (m[3] || m[4]) {
      const base = parse(m[3] || m[4]);
      return { min: base, minInclusive: true, max: null, maxInclusive: false, float: { prefix: null, pre: true, exactBase: base }, text: t };
    }
    const prefix = m[1] ? m[1].slice(0, -1).split('.').map(Number) : [];
    return { min: null, minInclusive: true, max: null, maxInclusive: false, float: { prefix, pre: !!m[2] }, text: t };
  }
  if (t[0] === '[' || t[0] === '(') {
    const last = t[t.length - 1];
    if (last !== ']' && last !== ')') return null;
    const inner = t.slice(1, -1);
    const parts = inner.split(',');
    if (parts.length === 1) {
      const v = parse(parts[0]);
      if (!v || t[0] !== '[' || last !== ']') return null;
      return { min: v, minInclusive: true, max: v, maxInclusive: true, exact: true, text: t };
    }
    if (parts.length !== 2) return null;
    const lo = parts[0].trim() ? parse(parts[0]) : null;
    const hi = parts[1].trim() ? parse(parts[1]) : null;
    if ((parts[0].trim() && !lo) || (parts[1].trim() && !hi)) return null;
    return { min: lo, minInclusive: t[0] === '[', max: hi, maxInclusive: last === ']', text: t };
  }
  const v = parse(t);
  if (!v) return null;
  return { min: v, minInclusive: true, max: null, maxInclusive: false, simple: true, text: t };
}

function satisfies(range, version) {
  const r = typeof range === 'string' ? parseRange(range) : range;
  const v = typeof version === 'string' ? parse(version) : version;
  if (!r || !v) return false;
  if (r.float) {
    if (r.float.exactBase) return compare(v, r.float.exactBase) >= 0 && v.major === r.float.exactBase.major && v.minor === r.float.exactBase.minor && v.patch === r.float.exactBase.patch;
    const nums = [v.major, v.minor, v.patch, v.revision];
    for (let i = 0; i < r.float.prefix.length; i++) if (nums[i] !== r.float.prefix[i]) return false;
    return r.float.pre || !v.pre.length;
  }
  if (r.min) { const c = compare(v, r.min); if (c < 0 || (c === 0 && !r.minInclusive)) return false; }
  if (r.max) { const c = compare(v, r.max); if (c > 0 || (c === 0 && !r.maxInclusive)) return false; }
  return true;
}

/** The version a project resolves today for a declared range (lowest that satisfies, NuGet's rule; floats take the highest). */
function resolve(range, versions) {
  const r = typeof range === 'string' ? parseRange(range) : range;
  if (!r) return null;
  const ok = versions.filter((v) => satisfies(r, v)).sort(compare);
  if (!ok.length) return null;
  return r.float ? ok[ok.length - 1] : ok[0];
}

/**
 * What an update would pick.
 * versions: all listed versions on the feed. includePre: show prereleases (also on when the current one is a prerelease).
 * Returns {latest, latestInRange, kind} where kind is 'simple' (a plain version, update to latest), 'range' (the range
 * has an upper bound: latestInRange stays inside it), 'float' (floats already) or 'exact'.
 */
function updateTarget(declared, versions, includePre) {
  const r = parseRange(declared);
  const current = r && r.min ? r.min : null;
  const pre = includePre || (current && current.pre.length > 0);
  const pool = versions.filter((v) => { const p = parse(v); return p && (pre || !p.pre.length); }).sort(compare);
  const latest = pool.length ? pool[pool.length - 1] : null;
  if (!r) return { latest, latestInRange: null, kind: 'unknown' };
  if (r.float) return { latest, latestInRange: null, kind: 'float' };
  const inRange = pool.filter((v) => satisfies(r, v));
  const latestInRange = inRange.length ? inRange[inRange.length - 1] : null;
  if (r.exact) return { latest, latestInRange, kind: 'exact' };
  if (r.simple) return { latest, latestInRange: latest, kind: 'simple' };
  return { latest, latestInRange, kind: r.max ? 'range' : 'simple' };
}

/** True when `candidate` is newer than what `declared` resolves to (its lower bound for a plain version). */
function isNewer(declared, candidate) {
  const r = parseRange(declared);
  if (!r || !candidate) return false;
  if (r.float) return false;
  const base = r.min || r.max;
  if (!base) return false;
  return compare(candidate, base) > 0;
}

/** How a version range reads to a person: "(, 5.8.4)" -> "below 5.8.4". */
function describeRange(text) {
  const r = parseRange(text);
  if (!r) return String(text);
  if (r.float) return `${text} (floating)`;
  if (r.exact) return `exactly ${normalize(r.min)}`;
  const lo = r.min ? `${r.minInclusive ? 'from' : 'above'} ${normalize(r.min)}` : '';
  const hi = r.max ? `${r.maxInclusive ? 'up to' : 'below'} ${normalize(r.max)}` : '';
  return [lo, hi].filter(Boolean).join(' ') || 'any version';
}

/**
 * The text to write when a declaration moves to `version`. A plain version becomes the new version. A range keeps its
 * form with a new lower bound ("[6.0.0, )" -> "[6.1.0, )", "[1.0,2.0)" -> "[1.5.0,2.0)"), unless the new version is
 * outside its upper bound, then the plain version is written. An exact range "[1.0]" becomes "[new]".
 */
function applyToDeclared(declared, version) {
  const t = String(declared || '').trim();
  const r = parseRange(t);
  if (!r || r.simple || r.float || !(t[0] === '[' || t[0] === '(')) return version;
  if (r.exact) return `[${version}]`;
  if (r.max && !satisfies({ ...r, min: null }, version)) return version;
  const m = /^([[(]\s*)([^,\s]*)(\s*,.*)$/.exec(t);
  if (!m) return version;
  return `${m[1].startsWith('(') ? '[' + m[1].slice(1) : m[1]}${version}${m[3]}`;
}

module.exports = { applyToDeclared, parse, compare, normalize, parseRange, satisfies, resolve, updateTarget, isNewer, isPrerelease, describeRange };
