'use strict';
// Install, update and remove, as text edits on the project files. Edits for one file are chained, then each file
// is read once and written once. Nothing here touches the network or runs dotnet.

const fs = require('fs');
const path = require('path');
const msbuild = require('./msbuild');

function friendly(message) { return Object.assign(new Error(message), { friendly: true }); }

class Changes {
  constructor() { this.byFile = new Map(); this.notes = []; }
  edit(file, fn) {
    if (!this.byFile.has(file)) this.byFile.set(file, []);
    this.byFile.get(file).push(fn);
    return this;
  }
  /** Run the edits in memory. Returns [{file, before, after}] for the files that change. */
  preview(readFile = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null)) {
    const out = [];
    for (const [file, fns] of this.byFile) {
      const before = readFile(file);
      let after;
      if (before == null) after = fns.reduce((t, fn) => fn(t), null);
      else after = msbuild.withBom(before, (t) => fns.reduce((acc, fn) => fn(acc), t));
      if (after != null && after !== before) out.push({ file, before, after });
    }
    return out;
  }
  /** Write the files. Returns the list from preview(). */
  commit(readFile, writeFile = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t, 'utf8'); }) {
    const res = this.preview(readFile);
    for (const r of res) writeFile(r.file, r.after);
    return res;
  }
  files() { return [...this.byFile.keys()]; }
}

/** Change the version a reference resolves to, wherever it is declared. */
function update(changes, project, ref, version) {
  if (ref.property) {
    const { file, name } = ref.property;
    changes.edit(file, (t) => {
      const out = msbuild.setProperty(t, name, version);
      if (out == null) throw friendly(`The property $(${name}) is not in ${path.basename(file)} any more.`);
      return out;
    });
    changes.notes.push(`${ref.id}: $(${name}) in ${path.basename(file)} set to ${version}`);
    return changes;
  }
  if (ref.unresolvedProperty) throw friendly(`${ref.id} takes its version from $(${ref.unresolvedProperty}), which is defined outside the project files this extension reads. Change it where it is defined.`);
  if (ref.source === 'global' && !ref.raw) throw friendly(`${ref.id} has no version to change.`);
  changes.edit(ref.file, (t) => {
    const r = msbuild.setVersion(t, ref.ref, version, ref.which);
    if (r.needsProperty) throw friendly(`${ref.id} takes its version from $(${r.needsProperty}); it is not defined in ${path.basename(ref.file)}.`);
    return r.text;
  });
  if (ref.source === 'central') changes.notes.push(`${ref.id}: Directory.Packages.props set to ${version} (every project that uses it)`);
  return changes;
}

/** Remove a package from a project. For central package management the PackageVersion line stays. */
function remove(changes, project, ref) {
  if (ref.inherited) throw friendly(`${ref.id} comes from ${path.basename(ref.inherited)}, which applies to every project under ${path.dirname(ref.inherited)}. Remove it there.`);
  changes.edit(ref.itemFile, (t) => msbuild.removeItem(t, ref.itemRef));
  return changes;
}

/** Add a package to a project, or update it when the project already has it. */
function install(changes, project, id, version) {
  const existing = project.refs.find((r) => r.id.toLowerCase() === id.toLowerCase() && !r.inherited && !r.condition);
  if (existing) return update(changes, project, existing, version);
  if (project.cpm && project.cpm.enabled) {
    const props = project.cpm.propsFile;
    changes.edit(props, (t) => {
      const model = msbuild.read(t);
      const pv = model.items.find((x) => x.kind === 'PackageVersion' && x.id.toLowerCase() === id.toLowerCase() && !x.condition);
      if (pv) return msbuild.setVersion(t, { kind: 'PackageVersion', id: pv.id, index: pv.index }, version).text;
      return msbuild.addItem(t, 'PackageVersion', id, version);
    });
    changes.edit(project.file, (t) => msbuild.addItem(t, 'PackageReference', id, null));
    return changes;
  }
  changes.edit(project.file, (t) => msbuild.addItem(t, 'PackageReference', id, version));
  return changes;
}

module.exports = { Changes, update, remove, install };
