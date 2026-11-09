'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../src/core/versions');
const X = require('../src/core/msbuild');
const P = require('../src/core/projects');
const C = require('../src/core/nugetconfig');
const ops = require('../src/core/ops');
const { analyze, consolidation, currentVersion } = require('../src/core/analysis');
const { unified } = require('../src/core/diff');

const FIX = path.join(__dirname, 'fixtures');
const copyFix = (name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb5-'));
  fs.cpSync(path.join(FIX, name), dir, { recursive: true });
  return dir;
};

// ---------- versions ----------
test('versions: compare follows NuGet rules', () => {
  const sorted = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.0.1', '1.0.1', '1.10.0', '2.0.0'];
  const shuffled = sorted.slice().reverse();
  assert.deepEqual(shuffled.sort(V.compare), sorted);
  assert.equal(V.compare('1.0', '1.0.0'), 0);
  assert.equal(V.compare('1.0.0+build', '1.0.0'), 0);
  assert.equal(V.compare('1.0.0-RC', '1.0.0-rc'), 0);
  assert.equal(V.normalize('1.2.3.0'), '1.2.3');
  assert.equal(V.normalize('1.0'), '1.0.0');
  assert.equal(V.parse('not.a.version'), null);
});

test('versions: ranges, floats and what an update picks', () => {
  assert.ok(V.satisfies('1.0', '5.0.0'));
  assert.ok(!V.satisfies('1.0', '0.9.0'));
  assert.ok(V.satisfies('[1.0,2.0)', '1.9.9'));
  assert.ok(!V.satisfies('[1.0,2.0)', '2.0.0'));
  assert.ok(V.satisfies('(, 5.8.4)', '5.8.3'));
  assert.ok(!V.satisfies('(, 5.8.4)', '5.8.4'));
  assert.ok(V.satisfies('[2.2.0, 2.2.0]', '2.2.0'));
  assert.ok(V.satisfies('1.*', '1.9.0') && !V.satisfies('1.*', '2.0.0') && !V.satisfies('1.*', '1.9.1-beta'));
  assert.ok(V.satisfies('1.*-*', '1.9.1-beta'));
  const vs = ['1.0.0', '1.5.0', '2.0.0-beta', '2.0.0', '2.1.0'];
  assert.deepEqual(V.updateTarget('1.0.0', vs, false), { latest: '2.1.0', latestInRange: '2.1.0', kind: 'simple' });
  assert.equal(V.updateTarget('[1.0,2.0)', vs, false).latestInRange, '1.5.0');
  assert.equal(V.updateTarget('[1.0,2.0)', vs, false).kind, 'range');
  assert.equal(V.updateTarget('2.0.0-alpha', ['2.0.0-alpha', '2.0.0-beta'], false).latest, '2.0.0-beta', 'a prerelease user sees prereleases');
  assert.equal(V.updateTarget('1.*', vs, false).kind, 'float');
  assert.equal(V.resolve('[1.2,)', vs), '1.5.0');
  assert.equal(V.describeRange('(, 5.8.4)'), 'below 5.8.4');
});

// ---------- msbuild editor ----------
test('msbuild: hostile files fail with a line number, comments are not items', () => {
  assert.throws(() => X.read(fs.readFileSync(path.join(FIX, 'hostile/Broken.csproj'), 'utf8')), (e) => e.friendly && /line \d/.test(e.message));
  const weird = X.read(fs.readFileSync(path.join(FIX, 'hostile/Weird.fsproj'), 'utf8'));
  const ids = weird.items.map((x) => x.id);
  assert.deepEqual(ids, ['FSharp.Core', 'Argu', 'Expecto', 'Floaty', 'Odd & Name']);
  assert.ok(!ids.includes('Commented.Out'));
  for (const bad of ['', 'plain text', '<Project><ItemGroup></Project>', '<Project a=1></Project>', '<!-- open', '<Project></Other>']) assert.throws(() => X.read(bad));
});

test('msbuild: update keeps quotes, BOM, CRLF and tabs; property versions change the property', () => {
  const raw = fs.readFileSync(path.join(FIX, 'plain/Plain.csproj'), 'utf8');
  assert.equal(raw.charCodeAt(0), 0xfeff);
  const out = X.withBom(raw, (t) => X.setVersion(t, { kind: 'PackageReference', id: 'Serilog', index: 0 }, '3.1.1').text);
  assert.equal(out.charCodeAt(0), 0xfeff);
  assert.equal(out, raw.replace('<Version>2.10.0</Version>', '<Version>3.1.1</Version>'));
  const prop = X.setVersion(raw.slice(1), { kind: 'PackageReference', id: 'dapper', index: 0 }, '2.1.35');
  assert.equal(prop.property, 'DapperVersion');
  assert.equal(prop.text, raw.slice(1).replace('<DapperVersion>2.0.123</DapperVersion>', '<DapperVersion>2.1.35</DapperVersion>'));
  const weird = fs.readFileSync(path.join(FIX, 'hostile/Weird.fsproj'), 'utf8');
  const w2 = X.setVersion(weird, { kind: 'PackageReference', id: 'FSharp.Core', index: 0 }, '9.0.100').text;
  assert.equal(w2, weird.replace("Version='8.0.100'", "Version='9.0.100'"));
  const w3 = X.setVersion(weird, { kind: 'PackageReference', id: 'Odd & Name', index: 0 }, '2.0.0').text;
  assert.ok(w3.includes('Include="Odd &amp; Name" Version="2.0.0"'));
});

test('msbuild: conditional item groups keep separate versions', () => {
  const raw = fs.readFileSync(path.join(FIX, 'plain/Plain.csproj'), 'utf8').slice(1);
  const m = X.read(raw);
  const stj = m.items.filter((x) => x.id === 'System.Text.Json');
  assert.equal(stj.length, 2);
  assert.match(stj[0].condition, /net48/);
  const out = X.setVersion(raw, { kind: 'PackageReference', id: 'System.Text.Json', index: 1 }, '8.0.5').text;
  assert.ok(out.includes('Version="6.0.0"') && out.includes('Version="8.0.5"'));
});

test('msbuild: add goes in sorted place with the same indentation; remove drops the line, and an empty group', () => {
  const raw = fs.readFileSync(path.join(FIX, 'plain/Plain.csproj'), 'utf8').slice(1);
  const added = X.addItem(raw, 'PackageReference', 'Polly', '8.4.0');
  assert.ok(added.includes('\t\t<PackageReference Include="Dapper" Version="$(DapperVersion)" />\r\n\t\t<PackageReference Include="Polly" Version="8.4.0" />\r\n\t\t<PackageReference Include="Serilog">'), 'sorted, tabs, CRLF');
  const removed = X.removeItem(raw, { kind: 'PackageReference', id: 'System.Text.Json', index: 0 });
  assert.ok(!removed.includes('net48\' ">'), 'the empty conditional group is gone');
  assert.equal(X.read(removed).items.filter((x) => x.id === 'System.Text.Json').length, 1);
  assert.ok(!removed.includes('\r\n\r\n\r\n'), 'no double blank line left');
  const bare = '<Project Sdk="Microsoft.NET.Sdk">\n    <PropertyGroup>\n        <OutputType>Exe</OutputType>\n    </PropertyGroup>\n</Project>\n';
  const b2 = X.addItem(bare, 'PackageReference', 'Humanizer', '2.14.1');
  assert.equal(b2, '<Project Sdk="Microsoft.NET.Sdk">\n    <PropertyGroup>\n        <OutputType>Exe</OutputType>\n    </PropertyGroup>\n\n    <ItemGroup>\n        <PackageReference Include="Humanizer" Version="2.14.1" />\n    </ItemGroup>\n</Project>\n');
  assert.equal(X.removeItem(b2, { kind: 'PackageReference', id: 'Humanizer', index: 0 }), bare);
});

test('msbuild: removeAttribute moves a reference to central management cleanly', () => {
  const a = '<Project>\n  <ItemGroup>\n    <PackageReference Include="A" Version="1.0.0" PrivateAssets="all" />\n    <PackageReference Include="B">\n      <Version>2.0.0</Version>\n    </PackageReference>\n  </ItemGroup>\n</Project>\n';
  const o1 = X.removeAttribute(a, { kind: 'PackageReference', id: 'A', index: 0 }, 'Version');
  assert.ok(o1.includes('<PackageReference Include="A" PrivateAssets="all" />'));
  const o2 = X.removeAttribute(o1, { kind: 'PackageReference', id: 'B', index: 0 }, 'Version');
  assert.ok(o2.includes('<PackageReference Include="B" />'), o2);
});

// ---------- projects ----------
test('projects: central package management, VersionOverride, property in props, GlobalPackageReference', async () => {
  const s = await P.scanWorkspace([path.join(FIX, 'cpm')]);
  assert.equal(s.projects.filter((p) => !p.isProps).length, 2);
  const pins = s.projects.find((p) => p.isProps);
  assert.deepEqual(pins.refs.map((r) => `${r.id} ${r.declared} ${r.source}`), ['xunit 2.4.1 pin'], 'a PackageVersion no project uses is listed as a pin');
  const app = s.projects.find((p) => p.name === 'App');
  assert.ok(app.cpm.enabled);
  const nj = app.refs.find((r) => r.id === 'Newtonsoft.Json');
  assert.equal(nj.source, 'central'); assert.equal(nj.declared, '12.0.1');
  const se = app.refs.find((r) => r.id === 'Serilog');
  assert.equal(se.declared, '3.1.1'); assert.equal(se.property.name, 'SerilogVersion');
  assert.ok(app.refs.some((r) => r.id === 'Nerdbank.GitVersioning' && r.source === 'global'));
  const lib = s.projects.find((p) => p.name === 'Lib');
  assert.deepEqual(lib.tfms, ['net6.0', 'net8.0']);
  const o = lib.refs.find((r) => r.id === 'Newtonsoft.Json');
  assert.equal(o.source, 'override'); assert.equal(o.declared, '13.0.3');
  assert.equal(consolidation(s.projects).find((c) => c.id === 'Newtonsoft.Json').versions.length, 2);
});

test('projects: solutions, legacy packages.config and broken files', async () => {
  const s = await P.scanWorkspace([FIX]);
  const plain = s.solutions.find((x) => x.name === 'plain.sln');
  assert.equal(plain.projects.length, 1);
  const legacy = s.projects.find((p) => p.name === 'Legacy');
  assert.ok(legacy.packagesConfig && legacy.refs.length === 0);
  const broken = s.projects.find((p) => p.name === 'Broken');
  assert.match(broken.error, /Broken\.csproj could not be read: <PackageReference> is closed by <\/ItemGroup> \(line 4\)/);
  const slnx = P.solutionProjects('/x/a.slnx', '<Solution><Folder Name="/src/"><Project Path="src\\A\\A.csproj" /></Folder><Project Path="B.fsproj"/></Solution>');
  assert.deepEqual(slnx, ['/x/src/A/A.csproj', '/x/B.fsproj']);
});

// ---------- ops ----------
test('ops: install, update and remove with central package management write the right files', async () => {
  const dir = copyFix('cpm');
  try {
    let s = await P.scanWorkspace([dir]);
    const app = () => s.projects.find((p) => p.name === 'App');
    // install: version in Directory.Packages.props, PackageReference without Version in the project
    ops.install(new ops.Changes(), app(), 'Polly', '8.4.0').commit();
    const props = fs.readFileSync(path.join(dir, 'Directory.Packages.props'), 'utf8');
    assert.ok(props.includes('    <PackageVersion Include="Polly" Version="8.4.0" />'));
    assert.ok(fs.readFileSync(path.join(dir, 'src/App/App.csproj'), 'utf8').includes('    <PackageReference Include="Polly" />'));
    s = await P.scanWorkspace([dir]);
    // update a property-backed version: the property changes
    ops.update(new ops.Changes(), app(), app().refs.find((r) => r.id === 'Serilog'), '4.0.0').commit();
    assert.ok(fs.readFileSync(path.join(dir, 'Directory.Packages.props'), 'utf8').includes('<SerilogVersion>4.0.0</SerilogVersion>'));
    // update an override: only the project changes
    const lib = s.projects.find((p) => p.name === 'Lib');
    const res = ops.update(new ops.Changes(), lib, lib.refs[0], '13.0.4').commit();
    assert.deepEqual(res.map((r) => path.basename(r.file)), ['Lib.csproj']);
    // remove from App: PackageVersion stays for other projects
    s = await P.scanWorkspace([dir]);
    ops.remove(new ops.Changes(), app(), app().refs.find((r) => r.id === 'Newtonsoft.Json')).commit();
    assert.ok(!fs.readFileSync(path.join(dir, 'src/App/App.csproj'), 'utf8').includes('Newtonsoft'));
    assert.ok(fs.readFileSync(path.join(dir, 'Directory.Packages.props'), 'utf8').includes('Newtonsoft.Json'));
    // a reference that comes from a props file is not removed from a project
    s = await P.scanWorkspace([dir]);
    assert.throws(() => ops.remove(new ops.Changes(), app(), app().refs.find((r) => r.source === 'global')), /applies to every project/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- nuget.config ----------
test('nuget.config: clear, remove, disabled, v2 and local feeds, credentials with env vars', () => {
  const r = C.effectiveSources(path.join(FIX, 'feeds/sub'), { userConfig: null, files: [path.join(FIX, 'feeds/sub/NuGet.Config'), path.join(FIX, 'feeds/nuget.config')] });
  assert.deepEqual(r.sources.map((s) => s.key), ['Company Feed', 'old', 'local']);
  const co = r.sources[0];
  assert.ok(!co.v2 && co.enabled && co.credential.username === 'me');
  assert.equal(r.sources[1].v2, true); assert.equal(r.sources[1].enabled, false);
  assert.equal(r.sources[2].local, true);
  process.env.ACME_TOKEN = 'secret-1';
  const r2 = C.effectiveSources(path.join(FIX, 'feeds'), { userConfig: null, files: [path.join(FIX, 'feeds/nuget.config')] });
  assert.equal(r2.sources.find((s) => s.key === 'Company Feed').credential.password, 'secret-1');
  delete process.env.ACME_TOKEN;
  const none = C.effectiveSources(os.tmpdir(), { userConfig: null, files: [] });
  assert.deepEqual(none.sources.map((s) => s.url), [C.NUGET_ORG]);
  assert.equal(C.userConfigPath({}, 'linux', '/home/u'), '/home/u/.nuget/NuGet/NuGet.Config');
  assert.equal(C.userConfigPath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u').replace(/\\/g, '/'), 'C:/Users/u/AppData/Roaming/NuGet/NuGet.Config');
});

// ---------- analysis ----------
test('analysis: outdated respects ranges and floats; vulnerable and deprecated flags', async () => {
  const projects = [{ file: '/p/A.csproj', name: 'A', refs: [
    { id: 'Lib.Simple', declared: '1.0.0', itemRef: { kind: 'PackageReference', id: 'Lib.Simple', index: 0 } },
    { id: 'Lib.Range', declared: '[1.0,2.0)', itemRef: { kind: 'PackageReference', id: 'Lib.Range', index: 0 } },
    { id: 'Lib.Float', declared: '1.*', itemRef: { kind: 'PackageReference', id: 'Lib.Float', index: 0 } },
    { id: 'Gone', declared: '1.0.0', itemRef: { kind: 'PackageReference', id: 'Gone', index: 0 } },
  ] }];
  const leaves = (list) => ({ versions: list.map((v) => ({ version: v, listed: v !== '1.9.0', deprecation: v === '1.0.0' ? { reasons: ['Legacy'] } : null, vulnerabilities: [] })) });
  const meta = async (id) => (id === 'Gone' ? null : leaves(['1.0.0', '1.5.0', '1.9.0', '2.0.0']));
  const vulns = { byId: new Map([['lib.simple', [{ url: 'https://github.com/advisories/GHSA-x', severity: 2, versions: '(, 1.5.0)' }]]]) };
  const { rows } = await analyze(projects, meta, { vulns });
  const by = Object.fromEntries(rows.map((r) => [r.ref.id, r]));
  assert.equal(by['Lib.Simple'].target, '2.0.0');
  assert.equal(by['Lib.Simple'].advisories[0].severityText, 'High');
  assert.deepEqual(by['Lib.Simple'].deprecation.reasons, ['Legacy']);
  assert.equal(by['Lib.Range'].target, '1.5.0', 'stays in range; 1.9.0 is unlisted');
  assert.equal(by['Lib.Range'].latest, '2.0.0');
  assert.equal(by['Lib.Float'].outdated, false);
  assert.equal(by.Gone.missing, true);
  assert.equal(currentVersion('[1.0,2.0)', leaves(['0.9.0', '1.5.0']).versions), '1.5.0');
});

test('diff: unified output for a small change', () => {
  const d = unified('a\nb\nc\nd\n', 'a\nB\nc\nd\n', 'a/x', 'b/x');
  assert.ok(d.includes('@@ -1,') && d.includes('-b') && d.includes('+B'));
  assert.ok(unified(null, 'x\n', 'a/n', 'b/n').startsWith('--- /dev/null'));
});

test('versions: an update keeps the range form of a declaration', () => {
  assert.equal(V.applyToDeclared('1.0.0', '2.0.0'), '2.0.0');
  assert.equal(V.applyToDeclared('[6.0.0, )', '6.1.0'), '[6.1.0, )');
  assert.equal(V.applyToDeclared('[1.0,2.0)', '1.5.0'), '[1.5.0,2.0)');
  assert.equal(V.applyToDeclared('[1.0,2.0)', '2.1.0'), '2.1.0', 'outside the upper bound: plain version');
  assert.equal(V.applyToDeclared('[1.0]', '1.2.0'), '[1.2.0]');
  assert.equal(V.applyToDeclared('(1.0,)', '1.5.0'), '[1.5.0,)');
});

test('frameworks: a version that supports none of the project frameworks is not offered as the update', async () => {
  const F = require('../src/core/frameworks');
  assert.equal(F.compatible('net10.0', 'net8.0'), false);
  assert.equal(F.compatible('.NETStandard2.0', 'net8.0'), true);
  assert.equal(F.compatible('.NETStandard2.0', 'net472'), true);
  assert.equal(F.compatible('.NETStandard2.1', 'net48'), false);
  assert.equal(F.compatible('.NETFramework4.6.2', 'net8.0'), false);
  assert.equal(F.supports({ dependencyGroups: [] }, ['net8.0']), true, 'no groups: unknown, allowed');
  assert.deepEqual(F.refFrameworks(" '$(TargetFramework)' == 'net8.0' ", ['net8.0', 'net10.0']), ['net8.0']);
  assert.deepEqual(F.refFrameworks('', ['net8.0', 'net10.0']), ['net8.0', 'net10.0']);
  const projects = [{ file: '/p/A.csproj', name: 'A', tfms: ['net8.0', 'net10.0'], refs: [
    { id: 'M.Analysis', declared: '8.0.32', condition: " '$(TargetFramework)' == 'net8.0' ", itemRef: { kind: 'PackageReference', id: 'M.Analysis', index: 0 } },
    { id: 'M.Analysis', declared: '8.0.32', condition: " '$(TargetFramework)' == 'net10.0' ", itemRef: { kind: 'PackageReference', id: 'M.Analysis', index: 1 } },
  ] }];
  const g = (fw) => [{ framework: fw, dependencies: [] }];
  const meta = async () => ({ versions: [{ version: '8.0.32', dependencyGroups: g('net8.0') }, { version: '8.0.33', dependencyGroups: g('net8.0') }, { version: '10.0.14', dependencyGroups: g('net10.0') }] });
  const { rows } = await analyze(projects, meta, {});
  assert.equal(rows[0].target, '8.0.33', 'net8.0 group stays on 8.0.x');
  assert.equal(rows[0].newerNeedsFramework, '10.0.14');
  assert.equal(rows[1].target, '10.0.14');
});
