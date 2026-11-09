'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../src/core/projects');
const pro = require('../src/pro');

const FIX = path.join(__dirname, 'fixtures');
const ROOT = process.env.NUGET_REPOS || path.join(os.homedir(), 'nuget-work', 'repos');

test('pro: shipped switched on, 3 free tries, USD 19 in the text', () => {
  assert.equal(pro.PRO_ENABLED, true);
  assert.equal(pro.FREE_TRIES, 3);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pro.js'), 'utf8');
  assert.match(src, /USD 19 once/);
  assert.doesNotMatch(src, /USD 15|USD 5\b/);
});

test('pro: tries are counted only after a file is written; the 4th start shows the modal', async () => {
  const state = new Map();
  const calls = [];
  const vscode = { window: { setStatusBarMessage: (t) => calls.push(t) } };
  const context = { globalState: { get: (k, d) => (state.has(k) ? state.get(k) : d), update: async (k, v) => { state.set(k, v); } } };
  const license = { ready: Promise.resolve(), isPro: () => false, refresh: async () => {}, requirePro: async (f, d) => { calls.push(`modal:${f}:${d}`); return false; } };
  const createPro = (vs, ctx) => pro.createPro(vs, ctx, { createLicense: () => license });
  const x = createPro(vscode, context);
  let g = await x.check('Licence report', 'detail');
  assert.deepEqual(g, { ok: true, trial: 1 });
  await x.consume('Licence report', g.trial);
  g = await x.check('Licence report', 'detail');
  assert.deepEqual(g, { ok: true, trial: 2 }); // cancelled at the save dialog: no try used
  g = await x.check('Licence report', 'detail');
  assert.deepEqual(g, { ok: true, trial: 2 });
  await x.consume('Licence report', g.trial);
  g = await x.check('Licence report', 'detail');
  assert.deepEqual(g, { ok: true, trial: 3 });
  await x.consume('Licence report', g.trial);
  assert.ok(calls.includes('NuGet: Licence report is a Zovo Pro tool. Free try 3 of 3, the last one.'));
  assert.equal(state.get('zovoNuget.proTries')['Licence report'], 3);
  const g4 = await x.check('Licence report', 'detail');
  assert.equal(g4.ok, false);
  assert.ok(calls.some((c) => c.startsWith('modal:Licence report:') && /USD 19 once/.test(c) && /stay free/.test(c)));
  assert.equal((await x.check('Migrate to central package management', 'd')).trial, 1, 'each tool has its own tries');
});

test('pro: licence report CSV escapes cells and sums licences', () => {
  const rows = [
    { projectName: 'App', ref: { id: 'Serilog', declared: '3.1.1' }, current: '3.1.1' },
    { projectName: 'Lib', ref: { id: 'Serilog', declared: '3.1.1' }, current: '3.1.1' },
    { projectName: 'App', ref: { id: 'Evil', declared: '1.0.0' }, current: '1.0.0' },
    { projectName: 'App', ref: { id: 'Gone', declared: '1.0.0' }, current: '1.0.0' },
  ];
  const meta = new Map([
    ['serilog', { versions: [{ version: '3.1.1', licenseExpression: 'Apache-2.0', projectUrl: 'https://serilog.net', authors: 'Serilog Contributors' }] }],
    ['evil', { versions: [{ version: '1.0.0', licenseExpression: '', licenseUrl: 'https://x/l', authors: '=HYPERLINK("x"), "q"' }] }],
  ]);
  const r = pro.licenceReport(rows, meta);
  const lines = r.csv.trim().split('\r\n');
  assert.equal(lines[0], 'Package,Version,Licence,Licence URL,Project,Project URL,Authors,Requires acceptance');
  assert.equal(lines.length, 5);
  assert.ok(r.csv.includes('Serilog,3.1.1,Apache-2.0,https://licenses.nuget.org/Apache-2.0,App,https://serilog.net,Serilog Contributors,'));
  assert.ok(r.csv.includes(`"'=HYPERLINK(""x""), ""q"""`), 'formula cells are defused and quoted');
  assert.deepEqual(r.summary.find((s) => s.license === 'Apache-2.0'), { license: 'Apache-2.0', packages: 1 });
  assert.equal(r.unknown, 1);
});

function mirror(src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb5-cpm-'));
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!['.git', 'bin', 'obj', 'node_modules'].includes(e.name)) walk(p); continue; }
      if (/\.(csproj|fsproj|vbproj|props|sln|slnx)$/i.test(e.name) || /^packages\.config$/i.test(e.name)) {
        const t = path.join(dir, path.relative(src, p));
        fs.mkdirSync(path.dirname(t), { recursive: true });
        fs.copyFileSync(p, t);
      }
    }
  };
  walk(src);
  return dir;
}

async function migrateAndCheck(src) {
  const dir = mirror(src);
  try {
    const before = await P.scanWorkspace([dir]);
    const plan = pro.planCpm(before.projects, dir);
    plan.changes.commit();
    const after = await P.scanWorkspace([dir]);
    let checked = 0;
    for (const p of after.projects) {
      if (p.error) continue;
      const old = before.projects.find((x) => x.file === p.file);
      if (!old || old.cpm.enabled || (old.packagesConfig && !old.refs.length) || !old.refs.some((r) => r.declared)) continue;
      assert.ok(p.cpm.enabled, `${p.name} uses central package management now`);
      for (const r of old.refs.filter((x) => x.declared && x.source !== 'global')) {
        const n = p.refs.find((x) => x.id.toLowerCase() === r.id.toLowerCase() && x.condition === r.condition && !!x.inherited === !!r.inherited);
        assert.ok(n, `${p.name} keeps ${r.id}`);
        const raised = plan.raised.find((x) => x.id === r.id && x.project === old.name && x.from === r.declared);
        assert.equal(n.declared, raised ? raised.to : r.declared, `${p.name} ${r.id}: ${r.declared} -> ${n.declared}`);
        checked++;
      }
    }
    return { plan, checked };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('pro: migrate to central package management keeps every resolved version (fixture)', async () => {
  const { plan, checked } = await migrateAndCheck(path.join(FIX, 'plain'));
  assert.ok(checked >= 4);
  assert.deepEqual(plan.central.map((c) => `${c.id} ${c.version}`), ['Dapper 2.0.123', 'Serilog 2.10.0', 'System.Text.Json 8.0.0']);
  assert.deepEqual(plan.overrides, [{ id: 'System.Text.Json', project: 'Plain', version: '6.0.0' }]);
});

test('pro: migrate real non-CPM repositories (Ocelot, Giraffe, serilog, FluentValidation, Vazor)', { skip: !fs.existsSync(ROOT) && 'no clones' }, async () => {
  let total = 0;
  for (const r of ['Ocelot', 'Giraffe', 'serilog', 'FluentValidation', 'Vazor']) {
    if (!fs.existsSync(path.join(ROOT, r))) continue;
    const { plan, checked } = await migrateAndCheck(path.join(ROOT, r));
    assert.ok(plan.central.length > 0, r);
    total += checked;
  }
  console.log(`cpm migration: ${total} references checked`);
  assert.ok(total > 50);
});

test('pro: migration turns on floating versions when a project floats (NU1011)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb5-float-'));
  try {
    fs.writeFileSync(path.join(dir, 'A.fsproj'), '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <PackageReference Include="Lib" Version="8.0.*" />\n    <PackageReference Include="Other" Version="1.2.3" />\n  </ItemGroup>\n</Project>\n');
    {
      const s = await P.scanWorkspace([dir]);
      const plan = pro.planCpm(s.projects, dir);
      assert.equal(plan.floating, true);
      plan.changes.commit();
      const props = fs.readFileSync(path.join(dir, 'Directory.Packages.props'), 'utf8');
      assert.match(props, /<CentralPackageFloatingVersionsEnabled>true<\/CentralPackageFloatingVersionsEnabled>/);
      assert.match(props, /<PackageVersion Include="Lib" Version="8\.0\.\*" \/>/);
      assert.equal(fs.readFileSync(path.join(dir, 'A.fsproj'), 'utf8'), '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <PackageReference Include="Lib" />\n    <PackageReference Include="Other" />\n  </ItemGroup>\n</Project>\n');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
