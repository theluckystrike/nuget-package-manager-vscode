'use strict';
// A small XML scanner and editor for MSBuild files (.csproj, .fsproj, .vbproj, Directory.Packages.props,
// Directory.Build.props). It never rebuilds the document: every edit replaces one exact range of the original
// text, so formatting, comments, attribute order, the BOM and line endings stay as they were.

class XmlError extends Error {
  constructor(message, offset, text) {
    const line = text ? text.slice(0, offset).split('\n').length : 0;
    super(line ? `${message} (line ${line})` : message);
    this.line = line;
    this.friendly = true;
  }
}

const NAME = /[A-Za-z_:][-A-Za-z0-9_.:]*/y;

/** Scan text into elements. Throws XmlError on a malformed document. */
function scan(text) {
  const els = [];
  const stack = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      if (e < 0) throw new XmlError('A comment is not closed', lt, text);
      i = e + 3; continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt);
      if (e < 0) throw new XmlError('A CDATA section is not closed', lt, text);
      i = e + 3; continue;
    }
    if (text.startsWith('<?', lt)) {
      const e = text.indexOf('?>', lt);
      if (e < 0) throw new XmlError('A processing instruction is not closed', lt, text);
      i = e + 2; continue;
    }
    if (text.startsWith('<!', lt)) {
      const e = text.indexOf('>', lt);
      if (e < 0) throw new XmlError('A declaration is not closed', lt, text);
      i = e + 1; continue;
    }
    if (text[lt + 1] === '/') {
      NAME.lastIndex = lt + 2;
      const m = NAME.exec(text);
      if (!m) throw new XmlError('A closing tag has no name', lt, text);
      const gt = text.indexOf('>', NAME.lastIndex);
      if (gt < 0 || text.slice(NAME.lastIndex, gt).trim()) throw new XmlError(`The closing tag </${m[0]}> is not closed`, lt, text);
      const top = stack.pop();
      if (top === undefined) throw new XmlError(`</${m[0]}> has no opening tag`, lt, text);
      const el = els[top];
      if (el.name !== m[0]) throw new XmlError(`<${el.name}> is closed by </${m[0]}>`, lt, text);
      el.closeStart = lt; el.end = gt + 1;
      i = gt + 1; continue;
    }
    NAME.lastIndex = lt + 1;
    const m = NAME.exec(text);
    if (!m) throw new XmlError('A "<" that does not start a tag', lt, text);
    const el = { name: m[0], start: lt, attrs: [], parent: stack.length ? stack[stack.length - 1] : -1, children: [], selfClosing: false };
    let j = NAME.lastIndex;
    for (;;) {
      while (j < n && /\s/.test(text[j])) j++;
      if (j >= n) throw new XmlError(`<${el.name}> is not closed`, lt, text);
      if (text[j] === '>') { j++; break; }
      if (text[j] === '/' && text[j + 1] === '>') { el.selfClosing = true; j += 2; break; }
      NAME.lastIndex = j;
      const a = NAME.exec(text);
      if (!a) throw new XmlError(`Unexpected "${text[j]}" in <${el.name}>`, j, text);
      j = NAME.lastIndex;
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] !== '=') throw new XmlError(`The attribute ${a[0]} of <${el.name}> has no value`, j, text);
      j++;
      while (j < n && /\s/.test(text[j])) j++;
      const q = text[j];
      if (q !== '"' && q !== "'") throw new XmlError(`The attribute ${a[0]} of <${el.name}> is not quoted`, j, text);
      const e = text.indexOf(q, j + 1);
      if (e < 0) throw new XmlError(`The attribute ${a[0]} of <${el.name}> is not closed`, j, text);
      el.attrs.push({ name: a[0], value: decode(text.slice(j + 1, e)), valueStart: j + 1, valueEnd: e, quote: q });
      j = e + 1;
    }
    el.openEnd = j;
    const idx = els.length;
    els.push(el);
    if (el.parent >= 0) els[el.parent].children.push(idx);
    if (el.selfClosing) el.end = j; else stack.push(idx);
    i = j;
  }
  if (stack.length) {
    const el = els[stack[stack.length - 1]];
    throw new XmlError(`<${el.name}> is never closed`, el.start, text);
  }
  if (!els.length) throw new XmlError('The file has no XML element', 0, text);
  return els;
}

function decode(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => {
    if (e === 'lt') return '<'; if (e === 'gt') return '>'; if (e === 'amp') return '&';
    if (e === 'quot') return '"'; if (e === 'apos') return "'";
    return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

function encodeAttr(s, q) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(q === "'" ? /'/g : /"/g, q === "'" ? '&apos;' : '&quot;');
}

function encodeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function attr(el, name) {
  const lower = name.toLowerCase();
  return el.attrs.find((a) => a.name.toLowerCase() === lower) || null;
}

function inner(text, el) {
  if (el.selfClosing) return { start: el.openEnd, end: el.openEnd, value: '' };
  return { start: el.openEnd, end: el.closeStart, value: text.slice(el.openEnd, el.closeStart) };
}

function childNamed(els, el, name) {
  const lower = name.toLowerCase();
  for (const c of el.children) if (els[c].name.toLowerCase() === lower) return els[c];
  return null;
}

const ITEM_KINDS = ['PackageReference', 'PackageVersion', 'GlobalPackageReference'];

/**
 * Read an MSBuild file. Returns {els, properties, items, root}.
 * items: [{kind, id, isUpdate, version, versionOverride, condition, itemCondition, index, start, end}]
 * properties: [{name, value, condition, start, end, valueStart, valueEnd}]
 */
function read(text) {
  const els = scan(text);
  const root = els[0];
  const properties = [];
  const items = [];
  const counts = new Map();
  for (const ci of root.children) {
    const g = els[ci];
    const gname = g.name.toLowerCase();
    const gcond = (attr(g, 'Condition') || {}).value || '';
    if (gname === 'propertygroup') {
      for (const pi of g.children) {
        const p = els[pi];
        const iv = inner(text, p);
        properties.push({ name: p.name, value: decode(iv.value.trim()), condition: [gcond, (attr(p, 'Condition') || {}).value || ''].filter(Boolean).join(' and '), start: p.start, end: p.end, valueStart: iv.start, valueEnd: iv.end });
      }
    } else if (gname === 'itemgroup') {
      for (const ii of g.children) {
        const it = els[ii];
        const kind = ITEM_KINDS.find((k) => k.toLowerCase() === it.name.toLowerCase());
        if (!kind) continue;
        const inc = attr(it, 'Include');
        const upd = attr(it, 'Update');
        const id = ((inc || upd || {}).value || '').trim();
        if (!id) continue;
        const v = attr(it, 'Version');
        const vChild = v ? null : childNamed(els, it, 'Version');
        const vo = attr(it, 'VersionOverride');
        const voChild = vo ? null : childNamed(els, it, 'VersionOverride');
        const itemCondition = (attr(it, 'Condition') || {}).value || '';
        const key = `${kind}|${id.toLowerCase()}`;
        const index = counts.get(key) || 0;
        counts.set(key, index + 1);
        items.push({
          kind, id, isUpdate: !inc && !!upd,
          version: v ? v.value.trim() : vChild ? decode(inner(text, vChild).value.trim()) : null,
          versionOverride: vo ? vo.value.trim() : voChild ? decode(inner(text, voChild).value.trim()) : null,
          condition: [gcond, itemCondition].filter(Boolean).join(' and '),
          groupCondition: gcond,
          privateAssets: ((attr(it, 'PrivateAssets') || {}).value) || (childNamed(els, it, 'PrivateAssets') ? decode(inner(text, childNamed(els, it, 'PrivateAssets')).value.trim()) : ''),
          index, start: it.start, end: it.end,
        });
      }
    }
  }
  return { els, root, properties, items, sdk: (attr(root, 'Sdk') || {}).value || '', rootName: root.name };
}

/** The value of a property, last definition wins (MSBuild order), conditions ignored. */
function property(model, name) {
  const lower = name.toLowerCase();
  let hit = null;
  for (const p of model.properties) if (p.name.toLowerCase() === lower) hit = p;
  return hit;
}

function detectEol(text) { return text.includes('\r\n') ? '\r\n' : '\n'; }

function lineStart(text, off) { const k = text.lastIndexOf('\n', off - 1); return k + 1; }

function indentAt(text, off) {
  const s = lineStart(text, off);
  const m = /^[ \t]*/.exec(text.slice(s, off));
  return m ? m[0] : '';
}

/** Find the element of an item again in fresh text: same kind, id and occurrence index. */
function locate(text, ref) {
  const model = read(text);
  const hits = model.items.filter((x) => x.kind === ref.kind && x.id.toLowerCase() === ref.id.toLowerCase());
  const item = hits[ref.index || 0] || null;
  if (!item) return { model, item: null, el: null };
  const el = model.els.find((e) => e.start === item.start);
  return { model, item, el };
}

function splice(text, start, end, value) { return text.slice(0, start) + value + text.slice(end); }

/**
 * Set the version of one item. which: 'Version' (default) or 'VersionOverride'.
 * When the current value is a property reference $(Name), the property is changed instead, if it is in this file
 * (returns {text, property: name}); when it is not, returns {text, needsProperty: name} and changes nothing.
 */
function setVersion(text, ref, newVersion, which = 'Version') {
  const { model, el } = locate(text, ref);
  if (!el) throw Object.assign(new Error(`${ref.id} is no longer in this file`), { friendly: true });
  const a = attr(el, which);
  const child = a ? null : childNamed(model.els, el, which);
  const current = a ? a.value.trim() : child ? decode(inner(text, child).value.trim()) : null;
  const pm = current && /^\$\(([A-Za-z_][\w.-]*)\)$/.exec(current);
  if (pm) {
    const p = property(model, pm[1]);
    if (!p) return { text, needsProperty: pm[1] };
    return { text: setPropertyValue(text, p, newVersion), property: pm[1] };
  }
  if (a) return { text: splice(text, a.valueStart, a.valueEnd, encodeAttr(newVersion, a.quote)) };
  if (child) { const iv = inner(text, child); return { text: splice(text, iv.start, iv.end, encodeText(newVersion)) }; }
  // No version yet: add the attribute after the last attribute of the start tag.
  const last = el.attrs[el.attrs.length - 1];
  const q = last ? last.quote : '"';
  const at = last ? last.valueEnd + 1 : el.start + 1 + el.name.length;
  return { text: splice(text, at, at, ` ${which}=${q}${encodeAttr(newVersion, q)}${q}`) };
}

function setPropertyValue(text, p, value) {
  const raw = text.slice(p.valueStart, p.valueEnd);
  const lead = /^\s*/.exec(raw)[0];
  const trail = /\s*$/.exec(raw)[0];
  return splice(text, p.valueStart, p.valueEnd, lead + encodeText(value) + trail);
}

/** Set a property by name in this file (the last definition). Returns null when it is not defined here. */
function setProperty(text, name, value) {
  const model = read(text);
  const p = property(model, name);
  if (!p) return null;
  return setPropertyValue(text, p, value);
}

/** The range that removes an element and, when it sits on its own lines, those lines. */
function removalRange(text, start, end) {
  const ls = lineStart(text, start);
  const before = text.slice(ls, start);
  let s = start; let e = end;
  if (/^[ \t]*$/.test(before)) {
    const nl = text.indexOf('\n', end);
    const after = text.slice(end, nl < 0 ? text.length : nl);
    // A comment that trails the element on its line belongs to it and goes with it.
    if (/^[ \t]*(<!--(?:(?!-->).)*-->[ \t]*)*\r?$/.test(after)) { s = ls; e = nl < 0 ? text.length : nl + 1; }
  }
  return [s, e];
}

/** Remove one item. When its ItemGroup holds nothing else (no element, no comment), the ItemGroup goes too. */
function removeItem(text, ref) {
  const { model, el } = locate(text, ref);
  if (!el) throw Object.assign(new Error(`${ref.id} is no longer in this file`), { friendly: true });
  const parent = model.els[el.parent];
  if (parent && parent.children.length === 1) {
    const rest = text.slice(parent.openEnd, el.start) + text.slice(el.end, parent.closeStart);
    if (!rest.trim()) {
      const [s, e] = removalRange(text, parent.start, parent.end);
      let out = splice(text, s, e, '');
      // Drop the blank line that separated the removed block from the one before, when nothing follows it but a
      // closing tag or another blank line.
      const eol = detectEol(text);
      const next = out.slice(s);
      if (out.slice(0, s).endsWith(eol + eol) && (next.startsWith(eol) || /^[ \t]*<\//.test(next))) out = splice(out, s - eol.length, s, '');
      return out;
    }
  }
  const [s, e] = removalRange(text, el.start, el.end);
  return splice(text, s, e, '');
}

/** Remove an attribute (for example Version, when a project moves to central package management). */
function removeAttribute(text, ref, name) {
  const { model, el } = locate(text, ref);
  if (!el) return text;
  const a = attr(el, name);
  if (a) {
    let s = a.valueStart - 1;
    // back over `Name=` and the white space before it
    s = text.lastIndexOf(a.name, s);
    while (s > 0 && /[ \t]/.test(text[s - 1])) s--;
    return splice(text, s, a.valueEnd + 1, '');
  }
  const child = childNamed(model.els, el, name);
  if (!child) return text;
  const [s, e] = removalRange(text, child.start, child.end);
  let out = splice(text, s, e, '');
  // <PackageReference Include="x">\n</PackageReference> with nothing left: make it self-closing.
  const again = locate(out, ref);
  if (again.el && !again.el.selfClosing && again.el.children.length === 0 && !out.slice(again.el.openEnd, again.el.closeStart).trim()) {
    const open = out.slice(again.el.start, again.el.openEnd - 1).replace(/\s+$/, '');
    out = splice(out, again.el.start, again.el.end, `${open} />`);
  }
  return out;
}

/**
 * Add an item (PackageReference or PackageVersion) with an optional Version.
 * It goes into the first unconditional ItemGroup that already holds that kind, in sorted position when that group
 * is sorted, with the same indentation and quote style. Without such a group, a new ItemGroup is added after the
 * last block of the Project.
 */
function addItem(text, kind, id, version, extra = {}) {
  const model = read(text);
  const eol = detectEol(text);
  const lower = kind.toLowerCase();
  const groups = model.root.children.map((i) => model.els[i]).filter((g) => g.name.toLowerCase() === 'itemgroup' && !attr(g, 'Condition'));
  const group = groups.find((g) => g.children.some((c) => model.els[c].name.toLowerCase() === lower));
  const attrsFor = (q) => {
    let s = ` Include=${q}${encodeAttr(id, q)}${q}`;
    if (version) s += ` ${extra.versionAttr || 'Version'}=${q}${encodeAttr(version, q)}${q}`;
    return s;
  };
  if (group) {
    const siblings = group.children.map((c) => model.els[c]).filter((e) => e.name.toLowerCase() === lower);
    const q = (siblings[0].attrs[0] || {}).quote || '"';
    const selfClose = /\s\/>$/.test(text.slice(siblings[0].start, siblings[0].end)) || !siblings[0].selfClosing ? ' />' : '/>';
    const ind = indentAt(text, siblings[0].start);
    const line = `${ind}<${siblings[0].name}${attrsFor(q)}${selfClose}`;
    const ids = siblings.map((e) => ((attr(e, 'Include') || attr(e, 'Update') || {}).value || '').toLowerCase());
    const sorted = ids.every((x, k) => k === 0 || ids[k - 1].localeCompare(x, 'en') <= 0);
    let anchor = null;
    if (sorted) anchor = siblings.find((e, k) => ids[k].localeCompare(id.toLowerCase(), 'en') > 0) || null;
    if (anchor) {
      const ls = lineStart(text, anchor.start);
      if (/^[ \t]*$/.test(text.slice(ls, anchor.start))) return splice(text, ls, ls, line + eol);
      return splice(text, anchor.start, anchor.start, line.trimStart() + eol + ind);
    }
    const last = siblings[siblings.length - 1];
    // After the last line of the sibling (past trailing spaces or a trailing comment), so that line stays as it is.
    let at = last.end;
    const nl = text.indexOf('\n', last.end);
    const rest = text.slice(last.end, nl < 0 ? text.length : nl);
    if (/^[ \t]*(<!--(?:(?!-->).)*-->[ \t]*)*\r?$/.test(rest)) at = (nl < 0 ? text.length : nl) - (rest.endsWith('\r') ? 1 : 0);
    return splice(text, at, at, eol + line);
  }
  const blocks = model.root.children.map((i) => model.els[i]);
  const unit = blocks.length ? indentAt(text, blocks[0].start) || '  ' : '  ';
  const q = '"';
  const block = `${unit}<ItemGroup>${eol}${unit}${unit}<${kind}${attrsFor(q)} />${eol}${unit}</ItemGroup>`;
  if (blocks.length) {
    const last = blocks[blocks.length - 1];
    return splice(text, last.end, last.end, eol + eol + block);
  }
  const close = model.root.closeStart;
  if (close == null) throw Object.assign(new Error('The Project element is empty and self-closing'), { friendly: true });
  return splice(text, close, close, eol + block + eol);
}

/** Add a property to the first unconditional PropertyGroup, or a new PropertyGroup at the top. */
function addProperty(text, name, value) {
  const model = read(text);
  const eol = detectEol(text);
  const groups = model.root.children.map((i) => model.els[i]).filter((g) => g.name.toLowerCase() === 'propertygroup' && !attr(g, 'Condition'));
  if (groups.length && groups[0].children.length) {
    const last = model.els[groups[0].children[groups[0].children.length - 1]];
    return splice(text, last.end, last.end, `${eol}${indentAt(text, last.start)}<${name}>${encodeText(value)}</${name}>`);
  }
  const unit = model.root.children.length ? indentAt(text, model.els[model.root.children[0]].start) || '  ' : '  ';
  const at = model.root.openEnd;
  return splice(text, at, at, `${eol}${unit}<PropertyGroup>${eol}${unit}${unit}<${name}>${encodeText(value)}</${name}>${eol}${unit}</PropertyGroup>`);
}

/** Split a BOM off and put it back, so edits never lose it. */
function withBom(raw, fn) {
  const bom = raw.charCodeAt(0) === 0xfeff ? '﻿' : '';
  return bom + fn(bom ? raw.slice(1) : raw);
}

module.exports = { scan, read, property, setVersion, setProperty, removeItem, removeAttribute, addItem, addProperty, withBom, detectEol, XmlError, attr };
