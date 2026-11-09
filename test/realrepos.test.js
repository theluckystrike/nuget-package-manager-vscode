'use strict';
// Install, update and remove on real .NET repositories (shallow clones in $NUGET_REPOS, default ~/nuget-work/repos).
// Every edit is checked with a line diff: only the intended lines change, and the file still parses.
// Skipped when the folder is missing (the clones are deleted after the gate).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../src/core/projects');
const ops = require('../src/core/ops');
const msbuild = require('../src/core/msbuild');
const { ops: diffOps } = require('../src/core/diff');

const ROOT = process.env.NUGET_REPOS || path.join(os.homedir(), 'nuget-work', 'repos');
const has = fs.existsSync(ROOT);

function changed(before, after) {
  const o = diffOps(before.replace(/\r\n/g, '\n').split('\n'), after.replace(/\r\n/g, '\n').split('\n'));
  return { minus: o.filter((x) => x[0] === '-').map((x) => x[1]), plus: o.filter((x) => x[0] === '+').map((x) => x[1]) };
}

test('real repositories: update, remove and install change only the intended lines', { skip: !has && 'no clones' }, async () => {
  let projects = 0; let updates = 0; let removes = 0; let installs = 0;
  for (const repo of fs.readdirSync(ROOT)) {
    const scan = await P.scanWorkspace([path.join(ROOT, repo)]);
    for (const p of scan.projects) {
      if (p.error || p.isProps) continue;
      projects++;
      const own = p.refs.filter((r) => !r.inherited && r.declared);
      // update every reference (one at a time)
      for (const r of own) {
        const res = ops.update(new ops.Changes(), p, r, '99.0.0-zovo').preview();
        assert.equal(res.length, 1, `${p.file} ${r.id}: one file changes`);
        const d = changed(res[0].before, res[0].after);
        assert.equal(d.minus.length, 1, `${r.id}: one line removed in ${res[0].file}`);
        assert.equal(d.plus.length, 1, `${r.id}: one line added`);
        assert.match(d.plus[0], /99\.0\.0-zovo/);
        // the line is the same except for the version text
        assert.equal(d.plus[0].replace('99.0.0-zovo', 'V'), d.minus[0].replace(r.raw && !r.property ? r.raw : (r.declared || ''), 'V'), `${r.id}: only the version text differs`);
        msbuild.read(res[0].after.replace(/^﻿/, ''));
        // the re-read model sees the new version
        const tmp = new Map([[res[0].file, res[0].after]]);
        const reread = msbuild.read(tmp.get(res[0].file).replace(/^﻿/, ''));
        if (!r.property) assert.ok(reread.items.some((x) => x.id.toLowerCase() === r.id.toLowerCase() && (x.version === '99.0.0-zovo' || x.versionOverride === '99.0.0-zovo')), `${r.id} re-read`);
        updates++;
      }
      // remove each reference: only removals
      for (const r of p.refs.filter((x) => !x.inherited)) {
        const res = ops.remove(new ops.Changes(), p, r).preview();
        assert.equal(res.length, 1);
        const d = changed(res[0].before, res[0].after);
        assert.equal(d.plus.length, 0, `${r.id}: removal adds nothing`);
        assert.ok(d.minus.length >= 1 && d.minus.length <= 8, `${r.id}: ${d.minus.length} lines removed`);
        assert.ok(d.minus.some((l) => l.toLowerCase().includes(r.id.toLowerCase())), `${r.id}: the removed lines hold the package`);
        msbuild.read(res[0].after.replace(/^﻿/, ''));
        removes++;
      }
      // install a new package
      const res = ops.install(new ops.Changes(), p, 'Zovo.Gate.Package', '1.2.3').preview();
      assert.equal(res.length, p.cpm.enabled ? 2 : 1);
      for (const f of res) {
        const d = changed(f.before, f.after);
        assert.equal(d.minus.length, 0, `install removes nothing in ${f.file}`);
        assert.ok(d.plus.length === 1 || (d.plus.length >= 3 && d.plus.length <= 5), `install adds ${d.plus.length} lines in ${f.file}`);
        assert.ok(d.plus.some((l) => l.includes('Zovo.Gate.Package')));
        const m = msbuild.read(f.after.replace(/^﻿/, ''));
        const it = m.items.find((x) => x.id === 'Zovo.Gate.Package');
        assert.ok(it, 'the new item is there');
        if (f.file === p.file) assert.equal(it.version, p.cpm.enabled ? null : '1.2.3');
      }
      installs++;
    }
  }
  console.log(`real repos: ${projects} projects, ${updates} updates, ${removes} removals, ${installs} installs checked`);
  assert.ok(projects >= 10);
});
