'use strict';
// NuGet Package Manager & NuGet Gallery for VS Code (Zovo).
// Activation reads nothing from the network. The first request goes out when the user opens the manager panel,
// and only to nuget.org and the feeds in the user's nuget.config files. No telemetry.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const P = require('./core/projects');
const ops = require('./core/ops');
const V = require('./core/versions');
const { analyze, consolidation } = require('./core/analysis');
const { unified } = require('./core/diff');
const { createFeeds } = require('./feeds');
const { advisoriesFor } = require('./core/feed');
const { buildHtml } = require('./html');
const { createPro, licenceReport, planCpm } = require('./pro');
const { createRatingPrompt } = require('./rate');
const { registerSupport, showLinks } = require('./support');

const EXT_ID = 'zovo.zovo-nuget-package-manager';
const S = 'zovoNuget';
const cfg = () => vscode.workspace.getConfiguration(S);

let rating = { success() {}, failure() {} };

function activate(context) {
  const t0 = Date.now();
  const out = vscode.window.createOutputChannel('NuGet');
  context.subscriptions.push(out);
  registerSupport({ vscode, context, prefix: S, selfId: EXT_ID });
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: S, name: 'NuGet Package Manager' });
  const pro = createPro(vscode, context);
  const app = new App(context, out, pro);
  const tree = new ProjectTree(app);
  context.subscriptions.push(vscode.window.createTreeView('zovoNuget.projects', { treeDataProvider: tree, showCollapseAll: true }));
  app.onChange = () => tree.refresh();

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(`${S}.${id}`, (...a) => Promise.resolve(fn(...a)).catch((e) => app.fail(e))));
  reg('open', () => app.panel({}));
  reg('openForProject', (arg) => app.panel({ project: projectArg(arg) }));
  reg('showUpdates', () => app.panel({ tab: 'updates' }));
  reg('showVulnerable', () => app.panel({ tab: 'vulnerable' }));
  reg('refresh', () => app.refresh(true));
  reg('restore', () => app.restoreCommand());
  reg('setCredentials', (key) => app.setCredentials(typeof key === 'string' ? key : null));
  reg('clearCredentials', () => app.clearCredentials());
  reg('showSources', () => app.showSources());
  reg('licenseReport', () => app.licenceReport());
  reg('migrateCpm', () => app.migrateCpm());
  reg('openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#start`, false));

  const watcher = vscode.workspace.createFileSystemWatcher('**/{*.csproj,*.fsproj,*.vbproj,Directory.Packages.props,Directory.Build.props,nuget.config,NuGet.config,NuGet.Config}');
  const soon = debounce(() => app.refresh(false), 800);
  watcher.onDidChange(soon); watcher.onDidCreate(soon); watcher.onDidDelete(soon);
  context.subscriptions.push(watcher, vscode.workspace.onDidChangeWorkspaceFolders(() => app.refresh(true)));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`${S}.includePrerelease`)) app.reanalyze(); }));
  app.log(`activated in ${Date.now() - t0} ms (no network until the manager opens)`);
  return { app };
}

function deactivate() {}

function projectArg(arg) {
  if (!arg) return null;
  if (arg instanceof vscode.Uri) return arg.fsPath;
  if (arg.file) return arg.file;
  if (arg.p && arg.p.file) return arg.p.file;
  if (arg.resourceUri) return arg.resourceUri.fsPath;
  return null;
}

function debounce(fn, ms) { let t = null; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

function roots() { return (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath); }

function findDotnet() {
  const set = String(cfg().get('dotnetPath', '') || '').trim();
  if (set) return fs.existsSync(set) ? set : null;
  const exe = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
  for (const d of String(process.env.PATH || '').split(path.delimiter)) { if (d && fs.existsSync(path.join(d, exe))) return path.join(d, exe); }
  for (const c of [path.join(os.homedir(), '.dotnet', exe), '/usr/local/share/dotnet/dotnet', '/usr/share/dotnet/dotnet', '/usr/local/bin/dotnet', 'C:\\Program Files\\dotnet\\dotnet.exe']) if (fs.existsSync(c)) return c;
  return null;
}

class App {
  constructor(context, out, pro) {
    this.context = context; this.out = out; this.pro = pro;
    this.scan = null; this.scanP = null; this.analysis = null; this.analysisP = null; this.view = null; this.feeds = null; this.onChange = () => {};
    this.restoreSkipNoted = false;
  }

  log(s) { this.out.appendLine(`[${new Date().toLocaleTimeString()}] ${s}`); }

  fail(e) {
    const msg = e && e.friendly ? e.message : `NuGet: ${e && e.message ? e.message : e}`;
    this.log(`error: ${e && e.stack ? e.stack : e}`);
    vscode.window.showErrorMessage(msg);
  }

  async ensureScan(force) {
    if (this.scan && !force) return this.scan;
    if (!this.scanP || force) {
      this.scanP = P.scanWorkspace(roots()).then((s) => { this.scan = s; this.scanP = null; return s; });
    }
    return this.scanP;
  }

  ensureFeeds() {
    if (!this.feeds) this.feeds = createFeeds({ vscode, context: this.context, root: roots()[0] || os.homedir(), userAgent: `NuGet-Package-Manager-VSCode/${this.context.extension ? this.context.extension.packageJSON.version : '0'}` });
    return this.feeds;
  }

  async refresh(force) {
    await this.ensureScan(true);
    this.onChange();
    if (this.view) {
      if (force && this.feeds) { await this.feeds.load(); }
      this.postInit();
      this.postInstalled();
      this.reanalyze();
    }
  }

  /** Outdated, vulnerable and deprecated, over all projects. Network: registration per package + vulnerability data. */
  async reanalyze() {
    if (!this.view) return null;
    const feeds = this.ensureFeeds();
    const scan = await this.ensureScan();
    const run = (async () => {
      this.post({ type: 'analysis', state: 'running' });
      let vulns = null;
      let vulnError = null;
      try { vulns = await feeds.vulnerabilities(); } catch (e) { vulnError = e; }
      const res = await analyze(scan.projects, (id) => feeds.meta(id), { prerelease: !!cfg().get('includePrerelease', false), vulns });
      res.vulnError = vulnError;
      return res;
    })();
    this.analysisP = run;
    try {
      const res = await run;
      if (this.analysisP !== run) return res;
      this.analysis = res;
      this.postAnalysis();
      this.onChange();
      if (!res.errors.length && scan.projects.length) rating.success(vscode.Uri.file(scan.projects[0].file));
      return res;
    } catch (e) {
      this.post({ type: 'analysis', state: 'error', error: errInfo(e) });
      return null;
    }
  }

  // ---------- panel ----------

  async panel(opts) {
    await this.ensureScan();
    const feeds = this.ensureFeeds();
    if (this.view) {
      this.view.reveal(this.view.viewColumn || vscode.ViewColumn.Active);
      this.post({ type: 'focus', tab: opts.tab || null, project: opts.project || null });
      return this.view;
    }
    await feeds.load();
    const ctx = this.context;
    const view = vscode.window.createWebviewPanel('zovoNuget.manager', 'NuGet Package Manager', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, enableCommandUris: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    });
    view.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'nuget.svg');
    this.view = view;
    this.pending = opts;
    view.webview.html = buildHtml({
      cspSource: view.webview.cspSource,
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'panel.js')).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'panel.css')).toString(),
      title: 'NuGet Package Manager', showSupportLinks: showLinks(vscode, S),
    });
    view.onDidDispose(() => { this.view = null; this.analysis = null; this.analysisP = null; }, null, ctx.subscriptions);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => this.post({ type: 'error', op: m && m.type, error: errInfo(e) })), null, ctx.subscriptions);
    this.pro.license.onDidChange(() => this.postInit());
    return view;
  }

  post(m) { if (this.view) this.view.webview.postMessage(m); }

  postInit() {
    const scan = this.scan || { projects: [], solutions: [], packagesConfigs: [] };
    const pending = this.pending || {};
    this.pending = null;
    this.post({
      type: 'init',
      projects: scan.projects.map((p) => ({ file: p.file, name: p.isProps ? `${p.name} (pinned versions)` : p.name, isProps: !!p.isProps, rel: rel(p.file), kind: p.kind, cpm: p.cpm.enabled, propsFile: p.cpm.propsFile ? rel(p.cpm.propsFile) : '', tfms: p.tfms, error: p.error || '', packagesConfig: !!p.packagesConfig && !p.refs.length, count: p.refs.length })),
      legacy: (scan.packagesConfigs || []).map(rel),
      solutions: scan.solutions.map((s) => ({ name: s.name, file: s.file, projects: s.projects })),
      sources: this.feeds ? this.feeds.describe() : [],
      configErrors: this.feeds ? this.feeds.configErrors : [],
      prerelease: !!cfg().get('includePrerelease', false),
      pro: { ...this.pro.status(), show: cfg().get('showProFeatures', true) !== false },
      dotnet: !!findDotnet(), truncated: !!scan.truncated, folder: roots().length > 0,
      tab: pending.tab || null, project: pending.project || null, packageId: pending.packageId || null,
    });
  }

  postInstalled() {
    const scan = this.scan;
    if (!scan) return;
    const rows = [];
    for (const p of scan.projects) for (const r of p.refs) rows.push(refRow(p, r));
    this.post({ type: 'installed', rows, consolidation: consolidation(scan.projects) });
  }

  postAnalysis() {
    const a = this.analysis;
    if (!a) return;
    this.post({
      type: 'analysis', state: 'done',
      rows: a.rows.map((r) => ({ key: refKey(r.projectFile, r.ref), current: r.current, latest: r.latest, latestInRange: r.latestInRange, target: r.target, kind: r.kind, outdated: r.outdated, deprecation: r.deprecation, advisories: r.advisories, missing: r.missing, failed: r.failed, newerNeedsFramework: r.newerNeedsFramework || '' })),
      errors: a.errors.slice(0, 20), vulnError: a.vulnError ? errInfo(a.vulnError) : null,
    });
  }

  async onMessage(m) {
    if (!m || typeof m.type !== 'string') return;
    const feeds = this.ensureFeeds();
    switch (m.type) {
      case 'ready':
        this.postInit(); this.postInstalled(); this.reanalyze();
        return;
      case 'search': {
        const s = feeds.byKey(m.source) || feeds.usable()[0];
        if (!s) { this.post({ type: 'searchResults', seq: m.seq, error: { message: 'No package source can be searched. Check nuget.config (Show Package Sources).' } }); return; }
        try {
          const r = await feeds.feedFor(s).search(String(m.q || ''), { prerelease: !!m.prerelease, skip: Number(m.skip) || 0, take: 30 });
          this.post({ type: 'searchResults', seq: m.seq, q: m.q, skip: Number(m.skip) || 0, source: s.key, ...r });
        } catch (e) { this.post({ type: 'searchResults', seq: m.seq, error: errInfo(e, s) }); }
        return;
      }
      case 'details': {
        try {
          let reg = null;
          const s = m.source ? feeds.byKey(m.source) : null;
          if (s) { reg = await feeds.feedFor(s).registration(m.id); if (reg) reg = { ...reg, source: s.key }; }
          if (!reg) reg = await feeds.meta(m.id);
          if (!reg) { this.post({ type: 'details', seq: m.seq, id: m.id, error: { message: `${m.id} was not found on the package sources.` } }); return; }
          let vulns = null;
          try { vulns = await feeds.vulnerabilities(); } catch { /* registration data is used instead */ }
          const versions = reg.versions.map((v) => ({
            version: v.version, listed: v.listed !== false, published: v.published || '', deprecated: !!v.deprecation,
            advisories: vulns ? advisoriesFor(vulns, reg.id, v.version) : (v.vulnerabilities || []).map((a) => ({ url: a.url, severity: a.severity, severityText: ['Low', 'Moderate', 'High', 'Critical'][a.severity] || 'Unknown' })),
          }));
          this.post({ type: 'details', seq: m.seq, id: reg.id, source: reg.source, versions });
        } catch (e) { this.post({ type: 'details', seq: m.seq, id: m.id, error: errInfo(e) }); }
        return;
      }
      case 'leaf': {
        try {
          const s = m.source ? feeds.byKey(m.source) : null;
          const reg = (s && await feeds.feedFor(s).registration(m.id)) || await feeds.meta(m.id);
          const leaf = reg && reg.versions.find((v) => v.version === m.version);
          this.post({ type: 'leaf', id: m.id, version: m.version, leaf: leaf || null });
        } catch (e) { this.post({ type: 'leaf', id: m.id, version: m.version, error: errInfo(e) }); }
        return;
      }
      case 'readme': {
        let text = '';
        try {
          const s = feeds.byKey(m.source) || feeds.usable().find((x) => x.isNugetOrg);
          text = s ? await feeds.feedFor(s).readme(m.id, m.version) : '';
        } catch (e) { this.post({ type: 'readme', id: m.id, version: m.version, error: errInfo(e) }); return; }
        this.post({ type: 'readme', id: m.id, version: m.version, text: text.slice(0, 200000) });
        return;
      }
      case 'install': return this.change('install', m);
      case 'update': return this.change('update', m);
      case 'remove': return this.change('remove', m);
      case 'refresh': return this.refresh(true);
      case 'prerelease': await cfg().update('includePrerelease', !!m.value, vscode.ConfigurationTarget.Global); return;
      case 'openFile': { const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(m.file)); await vscode.window.showTextDocument(doc, { preview: true }); return; }
      case 'openUrl': if (/^https:\/\//.test(String(m.url))) await vscode.env.openExternal(vscode.Uri.parse(m.url)); return;
      case 'credentials': return this.setCredentials(m.source || null);
      case 'sources': return this.showSources();
      case 'restore': return this.restoreCommand();
      case 'pro': if (m.tool === 'licence') return this.licenceReport(); if (m.tool === 'cpm') return this.migrateCpm(); return;
      default:
    }
  }

  findRef(key) {
    const [file] = key.split('|');
    const p = this.scan.projects.find((x) => x.file === file);
    if (!p) return null;
    const r = p.refs.find((x) => refKey(p.file, x) === key);
    return r ? { project: p, ref: r } : null;
  }

  /** Install, update or remove; then save, rescan, restore. */
  async change(kind, m) {
    const scan = await this.ensureScan(true);
    const changes = new ops.Changes();
    const touched = new Set();
    const changedIds = new Set();
    let summary = '';
    if (kind === 'install') {
      const id = String(m.id || ''); const version = String(m.version || '');
      if (!id || !V.parse(version)) throw Object.assign(new Error('Pick a version first.'), { friendly: true });
      const targets = scan.projects.filter((p) => !p.isProps && (m.projects || []).includes(p.file));
      if (!targets.length) throw Object.assign(new Error('Tick at least one project.'), { friendly: true });
      for (const p of targets) {
        if (p.error) throw Object.assign(new Error(p.error), { friendly: true });
        if (p.packagesConfig && !p.refs.length) throw Object.assign(new Error(`${p.name} uses packages.config, which this extension does not edit. Migrate it to PackageReference first (Visual Studio: right-click packages.config, Migrate packages.config to PackageReference).`), { friendly: true });
        ops.install(changes, p, id, version); touched.add(p.file); changedIds.add(id.toLowerCase());
      }
      summary = `${id} ${version} in ${targets.map((p) => p.name).join(', ')}`;
    } else {
      const keys = Array.isArray(m.keys) ? m.keys : [];
      const items = keys.map((k) => this.findRef(k)).filter(Boolean);
      if (!items.length) throw Object.assign(new Error('Nothing selected.'), { friendly: true });
      const done = new Set();
      const names = [];
      for (const { project, ref } of items) {
        changedIds.add(ref.id.toLowerCase());
        if (kind === 'remove') { ops.remove(changes, project, ref); names.push(`${ref.id} from ${project.name}`); touched.add(project.file); continue; }
        let version = m.version || null;
        if (!version) {
          const row = this.analysis && this.analysis.rows.find((r) => r.projectFile === project.file && refKey(project.file, r.ref) === refKey(project.file, ref));
          version = row && row.target;
        }
        if (!version) continue;
        const declKey = ref.property ? `${ref.property.file}|$${ref.property.name}` : `${ref.file}|${ref.ref.kind}|${ref.ref.id.toLowerCase()}|${ref.ref.index}`;
        touched.add(project.file);
        if (done.has(declKey)) continue;
        done.add(declKey);
        const text = V.applyToDeclared(ref.declared, version);
        ops.update(changes, project, ref, text);
        names.push(`${ref.id} ${ref.declared} → ${text}`);
      }
      if (!names.length) throw Object.assign(new Error('Everything selected is already up to date.'), { friendly: true });
      summary = names.length > 4 ? `${names.length} packages` : names.join(', ');
    }
    // Unsaved edits in an open editor would be overwritten: ask the user to save first.
    const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && changes.files().some((f) => samePath(f, d.uri.fsPath)));
    if (dirty.length) throw Object.assign(new Error(`Save ${dirty.map((d) => path.basename(d.uri.fsPath)).join(', ')} first; it has unsaved changes.`), { friendly: true });
    let written;
    try { written = changes.commit(); } catch (e) { rating.failure(); throw e; }
    this.log(`${kind}: ${summary}`);
    for (const w of written) this.log(`  saved ${w.file}`);
    for (const n of changes.notes) this.log(`  ${n}`);
    await this.ensureScan(true);
    this.onChange();
    this.postInit();
    this.postInstalled();
    this.post({ type: 'changed', kind, summary, files: written.map((w) => rel(w.file)) });
    rating.success(vscode.Uri.file(written.length ? written[0].file : [...touched][0]));
    this.reanalyze();
    const affected = this.affectedProjects(written.map((w) => w.file), touched, changedIds);
    await this.restore(affected);
  }

  /** Projects to restore: the ones changed directly, and those that use a changed package through a shared file. */
  affectedProjects(files, touched, ids) {
    const set = new Set(touched);
    // A pinned central version (no project references it directly) can matter to any project of that props file.
    const pinIds = new Set([...ids].filter((id) => !this.scan.projects.some((p) => !p.isProps && p.refs.some((r) => r.id.toLowerCase() === id))));
    for (const p of this.scan.projects) {
      if (p.isProps) { set.delete(p.file); continue; }
      if (pinIds.size && files.some((f) => samePath(f, p.cpm.propsFile || ''))) { set.add(p.file); continue; }
      const shared = files.some((f) => samePath(f, p.cpm.propsFile || '') || samePath(f, p.buildPropsFile || '') || p.refs.some((r) => r.property && samePath(f, r.property.file)));
      if (files.some((f) => samePath(f, p.file))) set.add(p.file);
      else if (shared && p.refs.some((r) => ids.has(r.id.toLowerCase()))) set.add(p.file);
    }
    return [...set].filter((f) => !this.scan.projects.some((p) => p.isProps && p.file === f));
  }

  // ---------- dotnet restore ----------

  async restore(projectFiles) {
    if (!cfg().get('restoreAfterChange', true) || !projectFiles.length) { this.post({ type: 'restore', state: 'off' }); return; }
    const dotnet = findDotnet();
    if (!dotnet) {
      const msg = 'Saved. Restore skipped: the .NET SDK (dotnet) was not found on PATH. Run dotnet restore yourself, or set NuGet: Dotnet Path.';
      this.post({ type: 'restore', state: 'skipped', message: msg });
      this.log(msg);
      if (!this.restoreSkipNoted) { this.restoreSkipNoted = true; vscode.window.setStatusBarMessage('NuGet: saved; restore skipped (dotnet not found)', 8000); }
      return;
    }
    if (!vscode.workspace.isTrusted) { this.post({ type: 'restore', state: 'skipped', message: 'Saved. Restore skipped: this folder is not trusted.' }); return; }
    let targets = projectFiles;
    // One solution restore when the changed projects are exactly that solution's projects; else one per project
    // (a solution can hold projects that need workloads the change has nothing to do with).
    const sln = this.scan.solutions.find((s) => targets.length > 3 && s.projects.length === targets.length && targets.every((t) => s.projects.includes(t)));
    if (sln) targets = [sln.file];
    this.post({ type: 'restore', state: 'running', message: `dotnet restore: ${targets.map((t) => path.basename(t)).join(', ')}` });
    let ok = true;
    for (const t of targets) {
      const code = await this.run(dotnet, ['restore', t], path.dirname(t));
      if (code !== 0) ok = false;
    }
    const message = ok ? `Saved and restored (${targets.map((t) => path.basename(t)).join(', ')}).` : 'Saved, but dotnet restore failed. See the NuGet output for the reason.';
    this.post({ type: 'restore', state: ok ? 'ok' : 'failed', message });
    if (!ok) vscode.window.showWarningMessage(message, 'Show Output').then((b) => { if (b) this.out.show(true); });
  }

  run(cmd, args, cwd) {
    return new Promise((resolve) => {
      this.log(`> ${path.basename(cmd)} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
      const child = cp.spawn(cmd, args, { cwd, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' } });
      const pipe = (d) => this.out.append(String(d));
      child.stdout.on('data', pipe); child.stderr.on('data', pipe);
      child.on('error', (e) => { this.log(`could not run dotnet: ${e.message}`); resolve(-1); });
      child.on('close', (code) => { this.log(`dotnet exited with code ${code}`); resolve(code); });
    });
  }

  async restoreCommand() {
    const scan = await this.ensureScan();
    const items = [...scan.solutions.map((s) => ({ label: s.name, description: rel(s.file), file: s.file })), ...scan.projects.map((p) => ({ label: p.name, description: rel(p.file), file: p.file }))];
    if (!items.length) { vscode.window.showInformationMessage('No .NET project in this folder.'); return; }
    const pick = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { placeHolder: 'Restore which solution or project?' });
    if (!pick) return;
    const dotnet = findDotnet();
    if (!dotnet) { vscode.window.showWarningMessage('The .NET SDK (dotnet) was not found on PATH. Install it from https://dot.net, or set NuGet: Dotnet Path.'); return; }
    this.out.show(true);
    const code = await this.run(dotnet, ['restore', pick.file], path.dirname(pick.file));
    if (code === 0) vscode.window.setStatusBarMessage(`NuGet: restored ${pick.label}`, 6000);
    else vscode.window.showWarningMessage('dotnet restore failed. See the NuGet output.');
  }

  // ---------- feeds ----------

  async pickSource(key, placeHolder) {
    const feeds = this.ensureFeeds();
    if (!feeds.sources.length) await feeds.load();
    const list = feeds.describe().filter((s) => !s.local);
    if (key) return list.find((s) => s.key === key) || null;
    const pick = await vscode.window.showQuickPick(list.map((s) => ({ label: s.key, description: s.url, detail: s.auth || (s.isNugetOrg ? 'public, no sign-in' : 'no credentials yet'), s })), { placeHolder });
    return pick ? pick.s : null;
  }

  async setCredentials(key) {
    const s = await this.pickSource(key, 'Which feed needs a user name and token?');
    if (!s) return;
    const github = /nuget\.pkg\.github\.com/i.test(s.url);
    const azure = /pkgs\.dev\.azure\.com|\.pkgs\.visualstudio\.com/i.test(s.url);
    const username = await vscode.window.showInputBox({ title: `Feed ${s.key}`, prompt: github ? 'Your GitHub user name' : azure ? 'Any user name (Azure Artifacts only checks the token)' : 'User name', value: azure ? 'token' : '', ignoreFocusOut: true });
    if (username === undefined) return;
    const password = await vscode.window.showInputBox({ title: `Feed ${s.key}`, prompt: github ? 'A personal access token with read:packages' : azure ? 'A personal access token with Packaging (Read)' : 'Password or token', password: true, ignoreFocusOut: true });
    if (password === undefined) return;
    const feeds = this.ensureFeeds();
    const src = feeds.sources.find((x) => x.key === s.key);
    await feeds.setCredential(src, { username, password });
    vscode.window.setStatusBarMessage(`NuGet: token for ${s.key} saved in VS Code's secret storage`, 6000);
    if (this.view) { this.postInit(); this.reanalyze(); }
  }

  async clearCredentials() {
    const s = await this.pickSource(null, 'Forget the saved token of which feed?');
    if (!s) return;
    const feeds = this.ensureFeeds();
    await feeds.clearCredential(feeds.sources.find((x) => x.key === s.key));
    vscode.window.setStatusBarMessage(`NuGet: token for ${s.key} removed`, 6000);
    if (this.view) this.postInit();
  }

  async showSources() {
    const feeds = this.ensureFeeds();
    await feeds.load();
    const list = feeds.describe();
    const items = list.map((s) => ({
      label: `${s.enabled ? '$(check)' : '$(circle-slash)'} ${s.key}`, description: s.url,
      detail: [!s.enabled ? 'disabled in nuget.config' : '', s.local ? 'local folder: not browsed here' : '', s.v2 ? 'NuGet v2 feed: not supported, use its v3 index.json URL' : '', s.auth, s.file ? `from ${s.file}` : 'default'].filter(Boolean).join(' · '), s,
    }));
    if (feeds.configErrors.length) items.push({ label: '$(warning) nuget.config could not be read', detail: feeds.configErrors.join(' · ') });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `Package sources from ${feeds.configFiles.length} nuget.config file(s). Pick one to set its token.` });
    if (pick && pick.s && pick.s.usable && !pick.s.isNugetOrg) await this.setCredentials(pick.s.key);
  }

  // ---------- Zovo Pro ----------

  async licenceReport() {
    const feature = 'Licence report';
    const gate = await this.pro.check(feature, 'The licence report lists the licence of every package in the solution and saves it as CSV, for a licence review or a customer.');
    if (!gate.ok) return;
    const scan = await this.ensureScan();
    if (!scan.projects.some((p) => p.refs.length)) { vscode.window.showInformationMessage('No package references found in this folder.'); return; }
    const feeds = this.ensureFeeds();
    if (!feeds.sources.length) await feeds.load();
    const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'NuGet: reading package licences' }, async () => analyze(scan.projects, (id) => feeds.meta(id), {}));
    const rep = licenceReport(res.rows, res.metaById);
    const root = roots()[0] || os.homedir();
    const target = await vscode.window.showSaveDialog({ title: 'Save the licence report', defaultUri: vscode.Uri.file(path.join(root, 'nuget-licences.csv')), filters: { CSV: ['csv'] } });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(rep.csv, 'utf8'));
    await this.pro.consume(feature, gate.trial);
    const top = rep.summary.slice(0, 4).map((x) => `${x.license} ${x.packages}`).join(', ');
    this.log(`licence report: ${rep.rows.length} rows to ${target.fsPath}; ${top}`);
    const b = await vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}: ${rep.rows.length} rows. ${top}${rep.unknown ? `; ${rep.unknown} without a stated licence` : ''}.`, 'Open');
    if (b) await vscode.window.showTextDocument(target);
  }

  async migrateCpm() {
    const feature = 'Migrate to central package management';
    const gate = await this.pro.check(feature, 'Moves every package version of the solution into one Directory.Packages.props, with a preview of every change first.');
    if (!gate.ok) return;
    const scan = await this.ensureScan(true);
    const rs = roots();
    if (!rs.length) { vscode.window.showInformationMessage('Open a folder first.'); return; }
    const plan = planCpm(scan.projects, rs[0]);
    const files = plan.changes.preview();
    if (!files.length) { vscode.window.showInformationMessage(plan.skipped.length ? `Nothing to move: ${plan.skipped.slice(0, 3).map((s) => `${s.project} ${s.reason}`).join('; ')}.` : 'Nothing to move: no project has a versioned PackageReference.'); return; }
    const text = [
      `# Migrate to central package management: ${plan.projects} projects, ${plan.central.length} packages`,
      `# New or changed: ${rel(plan.propsFile)}`,
      ...plan.raised.map((x) => `# ${x.id} in ${x.project}: ${x.from} -> ${x.to} (one version for the solution)`),
      ...plan.overrides.map((x) => `# ${x.id} in ${x.project}: keeps ${x.version} as VersionOverride (conditional reference)`),
      ...plan.skipped.map((x) => `# skipped ${x.project}: ${x.reason}`),
      '',
      ...files.map((f) => unified(f.before, f.after, `a/${rel(f.file)}`, `b/${rel(f.file)}`)),
    ].join('\n');
    const doc = await vscode.workspace.openTextDocument({ language: 'diff', content: text });
    await vscode.window.showTextDocument(doc, { preview: true });
    const pick = await vscode.window.showInformationMessage(`Apply these changes to ${files.length} files? ${plan.central.length} package versions move to Directory.Packages.props${plan.raised.length ? `; ${plan.raised.length} references are raised to the highest version in use` : ''}.`, { modal: true }, 'Apply');
    if (pick !== 'Apply') return;
    const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && files.some((f) => samePath(f.file, d.uri.fsPath)));
    if (dirty.length) { vscode.window.showErrorMessage(`Save ${dirty.map((d) => path.basename(d.uri.fsPath)).join(', ')} first.`); return; }
    const written = plan.changes.commit();
    await this.pro.consume(feature, gate.trial);
    this.log(`migrated to central package management: ${written.map((w) => rel(w.file)).join(', ')}`);
    await this.refresh(false);
    vscode.window.setStatusBarMessage(`NuGet: ${written.length} files changed; versions are now in Directory.Packages.props`, 8000);
    await this.restore(scan.projects.filter((p) => written.some((w) => samePath(w.file, p.file))).map((p) => p.file));
  }
}

function samePath(a, b) { return !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }

function rel(f) {
  if (!f) return '';
  for (const r of roots()) if (f.startsWith(r + path.sep)) return path.relative(r, f);
  return f;
}

function refKey(projectFile, r) { return `${projectFile}|${r.itemRef.kind}|${r.id.toLowerCase()}|${r.itemRef.index}|${r.inherited || ''}`; }

function refRow(p, r) {
  return {
    key: refKey(p.file, r), projectFile: p.file, projectName: p.name, id: r.id, declared: r.declared, raw: r.raw, source: r.source, condition: r.condition,
    inherited: r.inherited ? rel(r.inherited) : '', property: r.property ? `$(${r.property.name}) in ${path.basename(r.property.file)}` : '', file: rel(r.file),
    missingCentral: !!r.missingCentral, unresolved: r.unresolvedProperty || '', privateAssets: r.privateAssets || '',
  };
}

function errInfo(e, source) {
  return { message: e && e.message ? e.message : String(e), kind: (e && e.kind) || 'error', status: (e && e.status) || 0, source: source ? source.key : (e && typeof e.source === 'string' ? e.source : '') };
}

// ---------- tree ----------

class ProjectTree {
  constructor(app) { this.app = app; this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event; }
  refresh() { this.emitter.fire(); }
  async getChildren(el) {
    const scan = await this.app.ensureScan();
    if (!el) {
      const items = scan.projects.map((p) => ({ type: 'project', p }));
      for (const f of scan.packagesConfigs) items.push({ type: 'legacy', file: f });
      return items;
    }
    if (el.type === 'project') return el.p.refs.map((r) => ({ type: 'package', p: el.p, r }));
    return [];
  }
  getTreeItem(el) {
    if (el.type === 'legacy') {
      const t = new vscode.TreeItem(path.basename(path.dirname(el.file)), vscode.TreeItemCollapsibleState.None);
      t.description = 'packages.config (not supported)';
      t.tooltip = `${el.file}\npackages.config projects are not edited here. Migrate to PackageReference first.`;
      t.iconPath = new vscode.ThemeIcon('circle-slash');
      t.contextValue = 'legacy';
      return t;
    }
    if (el.type === 'project') {
      const p = el.p;
      const t = new vscode.TreeItem(p.name, p.refs.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      if (p.isProps) {
        t.description = `${p.refs.length} pinned version${p.refs.length === 1 ? '' : 's'}`;
        t.tooltip = `${p.file}\nPackageVersion lines no project references directly (pins for transitive packages).`;
        t.iconPath = new vscode.ThemeIcon('settings');
        t.contextValue = 'props';
        t.id = `p:${p.file}`;
        return t;
      }
      t.description = p.error ? 'could not be read' : p.packagesConfig && !p.refs.length ? 'packages.config (not supported)' : `${p.refs.length} package${p.refs.length === 1 ? '' : 's'}${p.cpm.enabled ? ' · central' : ''}`;
      t.tooltip = p.error ? `${p.file}\n${p.error}` : `${p.file}${p.tfms.length ? `\n${p.tfms.join(', ')}` : ''}${p.cpm.enabled ? `\nVersions from ${p.cpm.propsFile}` : ''}`;
      t.iconPath = new vscode.ThemeIcon(p.error ? 'error' : 'project');
      t.contextValue = 'project';
      t.file = p.file;
      t.resourceUri = vscode.Uri.file(p.file);
      t.id = `p:${p.file}`;
      return t;
    }
    const { p, r } = el;
    const row = this.app.analysis && this.app.analysis.rows.find((x) => x.projectFile === p.file && refKey(p.file, x.ref) === refKey(p.file, r));
    const t = new vscode.TreeItem(r.id, vscode.TreeItemCollapsibleState.None);
    let desc = r.declared || (r.missingCentral ? 'no version in Directory.Packages.props' : 'no version');
    if (row && row.outdated) desc += ` → ${row.target}`;
    if (r.source === 'central') desc += ' · central';
    if (r.inherited) desc += ` · ${path.basename(r.inherited)}`;
    t.description = desc;
    const adv = row && row.advisories && row.advisories.length;
    t.iconPath = new vscode.ThemeIcon(adv ? 'warning' : row && row.deprecation ? 'circle-slash' : row && row.outdated ? 'arrow-up' : 'package');
    t.tooltip = `${r.id} ${r.declared || ''}${r.condition ? `\nCondition: ${r.condition}` : ''}${adv ? `\n${row.advisories.length} known vulnerabilit${row.advisories.length === 1 ? 'y' : 'ies'}` : ''}${row && row.deprecation ? '\nDeprecated' : ''}`;
    t.contextValue = 'package';
    t.id = `r:${refKey(p.file, r)}`;
    t.command = { command: 'zovoNuget.openForProject', title: 'Manage', arguments: [{ file: p.file }] };
    return t;
  }
}

module.exports = { activate, deactivate };
