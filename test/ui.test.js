'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('manifest: name keeps the search phrases whole and first; engine floor; keywords', () => {
  assert.ok(pkg.displayName.startsWith('NuGet Package Manager & NuGet Gallery'));
  for (const p of ['NuGet Package Manager', 'NuGet Gallery', 'NuGet Packages']) assert.ok(pkg.displayName.includes(p), p);
  for (const k of ['nuget', 'nuget package manager', 'nuget gallery', 'nuget manager', 'nuget packages', 'central package management', 'Directory.Packages.props']) assert.ok(pkg.keywords.includes(k), k);
  assert.ok(pkg.keywords.length <= 30);
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.equal(pkg.name, 'zovo-nuget-package-manager');
  assert.equal(pkg.publisher, 'zovo');
});

test('manifest: every command in a menu is declared; license and support commands are declared', () => {
  const declared = new Set(pkg.contributes.commands.map((c) => c.command));
  for (const list of Object.values(pkg.contributes.menus)) for (const m of list) assert.ok(declared.has(m.command), m.command);
  for (const c of ['enterLicenseKey', 'getPro', 'unlockWithSponsors', 'removeLicense', 'payWithPayPal', 'moreViewers', 'supportDeveloper']) assert.ok(declared.has(`zovoNuget.${c}`), c);
  const src = fs.readFileSync(path.join(ROOT, 'src', 'extension.js'), 'utf8');
  for (const c of declared) {
    const short = c.split('.')[1];
    if (['enterLicenseKey', 'getPro', 'unlockWithSponsors', 'removeLicense', 'payWithPayPal', 'moreViewers', 'supportDeveloper'].includes(short)) continue;
    assert.ok(src.includes(`reg('${short}'`), `registered: ${c}`);
  }
  for (const f of [pkg.icon, 'media/nuget.svg', 'walkthrough/updates.md', 'walkthrough/feeds.md', 'media/panel.js', 'media/panel.css']) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

test('webview: strict CSP with nonce scripts; the script parses', () => {
  const { buildHtml } = require('../src/html');
  const html = buildHtml({ cspSource: 'vscode-resource:', scriptUri: 'vscode-resource:/p.js', styleUri: 'vscode-resource:/p.css', title: 'x' });
  const csp = /content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /^default-src 'none'; /);
  assert.match(csp, /script-src 'nonce-[\w-]+'/);
  assert.match(csp, /img-src vscode-resource: blob: data:/);
  assert.doesNotMatch(csp, /https?:/);
  const n = /nonce-([\w-]+)/.exec(csp)[1];
  for (const m of html.matchAll(/<script([^>]*)>/g)) assert.ok(m[1].includes(`nonce="${n}"`));
  new vm.Script(fs.readFileSync(path.join(ROOT, 'media', 'panel.js'), 'utf8'));
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'media', 'panel.js'), 'utf8'), /fetch\(|XMLHttpRequest|style=/);
});

test('activation: no network, no dotnet; the tree lists projects from local files', async () => {
  const calls = { fetch: 0, commands: [] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls.fetch++; throw new Error('network'); };
  class EventEmitter { constructor() { this.l = []; this.event = (f) => { this.l.push(f); return { dispose() {} }; }; } fire(x) { this.l.forEach((f) => f(x)); } }
  class TreeItem { constructor(label, state) { this.label = label; this.collapsibleState = state; } }
  const Uri = { file: (p) => ({ fsPath: p, scheme: 'file', path: p }), joinPath: (u, ...a) => ({ fsPath: path.join(u.fsPath, ...a) }), parse: (s) => ({ toString: () => s }) };
  const folder = path.join(__dirname, 'fixtures');
  const state = new Map();
  const vscode = {
    EventEmitter, TreeItem, Uri, ThemeIcon: class { constructor(id) { this.id = id; } }, TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
    ViewColumn: { Active: -1 }, ConfigurationTarget: { Global: 1 }, ProgressLocation: { Notification: 15 },
    env: { uriScheme: 'vscode', appName: 'Visual Studio Code', openExternal: async () => true },
    window: { createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }), createTreeView: (id, o) => { calls.tree = o.treeDataProvider; return { dispose() {} }; }, showInformationMessage: async () => undefined, showErrorMessage: async () => undefined, setStatusBarMessage: () => ({ dispose() {} }), onDidChangeWindowState: () => ({ dispose() {} }), state: { focused: true } },
    commands: { registerCommand: (id) => { calls.commands.push(id); return { dispose() {} }; }, executeCommand: async () => undefined },
    workspace: { workspaceFolders: [{ uri: Uri.file(folder) }], getConfiguration: () => ({ get: (k, d) => d, update: async () => {} }), createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }), onDidChangeWorkspaceFolders: () => ({ dispose() {} }), onDidChangeConfiguration: () => ({ dispose() {} }), textDocuments: [], isTrusted: true },
    extensions: { getExtension: () => null },
    authentication: { getSession: async () => null, onDidChangeSessions: () => ({ dispose() {} }) },
  };
  const context = { subscriptions: [], extensionUri: Uri.file(ROOT), globalStorageUri: Uri.file('/tmp/nb5-gs'), extension: { packageJSON: pkg },
    globalState: { get: (k, d) => (state.has(k) ? state.get(k) : d), update: async (k, v) => state.set(k, v), setKeysForSync() {} },
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) } };
  const origLoad = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : origLoad.call(this, req, ...rest); };
  try {
    const t0 = process.hrtime.bigint();
    const ext = require('../src/extension');
    const api = ext.activate(context);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 300, `activate took ${ms} ms`);
    for (const c of ['zovoNuget.open', 'zovoNuget.showUpdates', 'zovoNuget.migrateCpm', 'zovoNuget.licenseReport', 'zovoNuget.getPro', 'zovoNuget.moreViewers']) assert.ok(calls.commands.includes(c), c);
    const top = await calls.tree.getChildren();
    const names = top.map((x) => calls.tree.getTreeItem(x).label);
    for (const n of ['App', 'Lib', 'Plain', 'Legacy', 'Broken', 'Weird']) assert.ok(names.includes(n), n);
    const broken = calls.tree.getTreeItem(top.find((x) => x.p && x.p.name === 'Broken'));
    assert.equal(broken.description, 'could not be read');
    const legacy = calls.tree.getTreeItem(top.find((x) => x.p && x.p.name === 'Legacy'));
    assert.equal(legacy.description, 'packages.config (not supported)');
    const kids = await calls.tree.getChildren(top.find((x) => x.p && x.p.name === 'App'));
    assert.ok(kids.map((k) => calls.tree.getTreeItem(k).label).includes('Newtonsoft.Json'));
    assert.equal(calls.fetch, 0, 'no network before the panel opens');
    assert.ok(api.app);
  } finally { Module._load = origLoad; globalThis.fetch = realFetch; }
});
