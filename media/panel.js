// NuGet Package Manager webview. No network of its own: every request goes through the extension host.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (s, r) => (r || document).querySelector(s);

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }

  const SEV = ['Low', 'Moderate', 'High', 'Critical'];
  const st = {
    tab: 'installed', project: '', projects: [], solutions: [], sources: [], source: '', prerelease: false, pro: {}, dotnet: false, legacy: [],
    rows: [], consolidation: [], analysis: new Map(), analysisState: 'idle', analysisErrors: [], vulnError: null,
    search: { q: '', items: [], total: 0, skip: 0, loading: false, error: null }, seq: 0,
    sel: null, details: null, leaf: null, readme: null, checked: new Set(), filter: '', notice: null, busy: false,
  };
  const send = (m) => vscode.postMessage(m);

  // ---------- helpers ----------
  const lower = (s) => String(s || '').toLowerCase();
  const fmtNum = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n || 0));
  const projName = (file) => (st.projects.find((p) => p.file === file) || {}).name || file;
  const inScope = (r) => !st.project || r.projectFile === st.project;
  const an = (r) => st.analysis.get(r.key) || null;
  function cmpVer(a, b) {
    const pa = String(a).split(/[-+]/)[0].split('.').map(Number); const pb = String(b).split(/[-+]/)[0].split('.').map(Number);
    for (let i = 0; i < 4; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
    const ra = String(a).includes('-'); const rb = String(b).includes('-');
    if (ra !== rb) return ra ? -1 : 1;
    return String(a).localeCompare(String(b), 'en', { numeric: true });
  }
  function badge(text, cls, title) { return h('span', { class: `badge ${cls || ''}`, title }, text); }
  function sourceTag(r) {
    if (r.source === 'central') return badge('central', 'muted', `Version from ${r.file}`);
    if (r.source === 'override') return badge('override', 'muted', 'VersionOverride in the project');
    if (r.inherited) return badge('inherited', 'muted', `From ${r.inherited}`);
    if (r.source === 'global') return badge('global', 'muted', 'GlobalPackageReference');
    if (r.source === 'pin') return badge('pinned', 'muted', 'PackageVersion in Directory.Packages.props that no project references directly');
    return null;
  }
  function advBadge(list) {
    if (!list || !list.length) return null;
    const max = Math.max(...list.map((a) => a.severity));
    return badge(`${SEV[max] || 'Vulnerable'}`, `sev sev${max}`, `${list.length} known vulnerabilit${list.length === 1 ? 'y' : 'ies'}`);
  }

  // ---------- derived lists ----------
  function installedGroups() {
    const map = new Map();
    for (const r of st.rows) {
      if (!inScope(r)) continue;
      const k = lower(r.id);
      if (!map.has(k)) map.set(k, { id: r.id, rows: [] });
      map.get(k).rows.push(r);
    }
    let list = [...map.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { sensitivity: 'base' }));
    if (st.filter) list = list.filter((g) => lower(g.id).includes(lower(st.filter)));
    return list;
  }
  const updateRows = () => st.rows.filter((r) => inScope(r) && an(r) && an(r).outdated);
  const vulnRows = () => st.rows.filter((r) => inScope(r) && an(r) && ((an(r).advisories || []).length || an(r).deprecation));
  const consolidationRows = () => st.consolidation.filter((c) => !st.project || c.versions.some((v) => v.projects.includes(projName(st.project))));

  // ---------- render ----------
  function render() {
    const app = $('#app');
    // Keep scroll positions and the focused field across re-renders (messages arrive while the user works).
    const keep = { list: ($('.list') || {}).scrollTop || 0, details: ($('.details') || {}).scrollTop || 0, sameTab: st.renderedTab === st.tab, sameSel: st.renderedSel === (st.sel && st.sel.id) };
    const a = document.activeElement;
    const focusId = a && a.id && a !== document.body ? a.id : null;
    const sel = a && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
    app.replaceChildren(header(), notice(), h('main', { class: 'split' }, h('section', { class: 'list', 'aria-label': 'Packages' }, listPane()), h('section', { class: 'details', id: 'details', 'aria-label': 'Package details' }, detailsPane())));
    if (keep.sameTab) $('.list').scrollTop = keep.list;
    if (keep.sameSel) $('.details').scrollTop = keep.details;
    st.renderedTab = st.tab; st.renderedSel = st.sel && st.sel.id;
    if (focusId) { const f = document.getElementById(focusId); if (f) { f.focus(); if (sel && typeof f.setSelectionRange === 'function') { try { f.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not a text field */ } } } }
  }

  function header() {
    const ups = updateRows().length; const vul = vulnRows().length; const con = consolidationRows().length;
    const tabs = [['browse', 'Browse'], ['installed', `Installed (${installedGroups().length})`], ['updates', `Updates${st.analysisState === 'done' ? ` (${ups})` : ''}`], ['vulnerable', `Vulnerable & deprecated${st.analysisState === 'done' ? ` (${vul})` : ''}`], ['consolidate', `Consolidate (${con})`]];
    const projSel = h('select', { id: 'project', 'aria-label': 'Project', onchange: (e) => { st.project = e.target.value; st.checked.clear(); render(); } },
      h('option', { value: '' }, `All projects (${st.projects.length})`),
      st.projects.map((p) => h('option', { value: p.file, selected: p.file === st.project }, `${p.name}${p.cpm ? ' · central' : ''}${p.error ? ' · cannot read' : ''}`)));
    const srcSel = h('select', { id: 'source', 'aria-label': 'Package source', onchange: (e) => { st.source = e.target.value; if (st.tab === 'browse') doSearch(0); } },
      st.sources.filter((s) => s.usable).map((s) => h('option', { value: s.key, selected: s.key === st.source }, s.key)));
    const pre = h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'prerelease', checked: st.prerelease, onchange: (e) => { st.prerelease = e.target.checked; send({ type: 'prerelease', value: st.prerelease }); if (st.tab === 'browse') doSearch(0); if (st.sel) openDetails(st.sel.id); } }), 'Prerelease');
    const tools = [projSel, srcSel, pre, h('button', { class: 'icon', title: 'Reload projects and check again', id: 'refresh', onclick: () => send({ type: 'refresh' }) }, 'Refresh')];
    if (st.pro.show !== false) {
      const left = (n) => (st.pro.pro ? '' : ` (${Math.max(0, (st.pro.free || 3) - n)} free tries)`);
      tools.push(h('div', { class: 'menu' }, h('button', { class: 'secondary', id: 'pro-menu', 'aria-haspopup': 'true', onclick: (e) => { e.currentTarget.parentElement.classList.toggle('open'); } }, 'Pro tools ', badge('PRO', 'pro')),
        h('div', { class: 'menu-list', role: 'menu' },
          h('button', { role: 'menuitem', id: 'pro-licence', onclick: () => send({ type: 'pro', tool: 'licence' }) }, `Licence report (CSV)${left((st.pro.tries || {}).licence || 0)}`),
          h('button', { role: 'menuitem', id: 'pro-cpm', onclick: () => send({ type: 'pro', tool: 'cpm' }) }, `Migrate to central package management${left((st.pro.tries || {}).cpm || 0)}`))));
    }
    return h('header', { class: 'bar' },
      h('nav', { class: 'tabs', role: 'tablist' }, tabs.map(([k, label]) => h('button', { role: 'tab', class: `tab ${st.tab === k ? 'active' : ''}`, 'aria-selected': st.tab === k ? 'true' : 'false', 'data-tab': k, onclick: () => setTab(k) }, label))),
      h('div', { class: 'tools' }, tools));
  }

  function notice() {
    const parts = [];
    if (!st.folder) parts.push(h('div', { class: 'note' }, 'Open a folder with a .NET project to install packages. You can still browse nuget.org.'));
    else if (!st.projects.length) parts.push(h('div', { class: 'note' }, 'No .csproj, .fsproj or .vbproj file found in this folder.'));
    if (st.legacy.length) parts.push(h('div', { class: 'note warn' }, `${st.legacy.length} project(s) use packages.config, which this extension does not edit. Migrate them to PackageReference first.`));
    for (const p of st.projects.filter((x) => x.error)) parts.push(h('div', { class: 'note error' }, p.error));
    if (st.analysisState === 'running') parts.push(h('div', { class: 'note', id: 'checking' }, h('span', { class: 'spin' }), 'Checking versions, vulnerabilities and deprecation…'));
    if (st.analysisState === 'error' && st.analysisError) parts.push(errorNote(st.analysisError));
    if (st.analysisErrors.length) parts.push(errorNote(st.analysisErrors[0], st.analysisErrors.length > 1 ? ` (${st.analysisErrors.length} packages could not be checked)` : ''));
    if (st.notice) parts.push(h('div', { class: `note ${st.notice.cls || ''}`, id: 'notice-msg', role: 'status', 'data-restore': st.notice.restore || null }, st.notice.text));
    return h('div', { class: 'notices', 'aria-live': 'polite' }, parts);
  }

  function errorNote(e, extra) {
    const kids = [e.message + (extra || '')];
    if (e.kind === 'auth') kids.push(h('button', { class: 'link', id: 'set-token', onclick: () => send({ type: 'credentials', source: e.source || null }) }, 'Set user name and token'));
    if (e.kind === 'offline') kids.push(h('button', { class: 'link', onclick: () => send({ type: 'refresh' }) }, 'Try again'));
    return h('div', { class: `note error err-${e.kind || 'error'}`, role: 'alert' }, kids);
  }

  function setTab(k) {
    st.tab = k; st.checked.clear();
    render();
    if (k === 'browse') { const i = $('#q'); if (i) i.focus(); if (!st.search.items.length && !st.search.loading) doSearch(0); }
  }

  function listPane() {
    if (st.tab === 'browse') return browseList();
    if (st.tab === 'installed') return installedList();
    if (st.tab === 'updates') return updatesList();
    if (st.tab === 'vulnerable') return vulnList();
    return consolidateList();
  }

  function pkgItem(id, sub, badges, onclick, extra) {
    const active = st.sel && lower(st.sel.id) === lower(id);
    return h('div', { class: `item ${active ? 'active' : ''}`, role: 'option', tabindex: '0', 'data-id': id, 'aria-selected': active ? 'true' : 'false', onclick, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onclick(); } } },
      extra || null,
      h('div', { class: 'avatar', 'aria-hidden': 'true' }, id.slice(0, 1).toUpperCase()),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, h('span', { class: 'pkg' }, id), badges), sub ? h('div', { class: 'sub' }, sub) : null));
  }

  function browseList() {
    const s = st.search;
    const input = h('input', { id: 'q', type: 'search', placeholder: 'Search packages (for example serilog, dapper, owner:aspnet)', value: s.q, 'aria-label': 'Search packages', onkeydown: (e) => { if (e.key === 'Enter') { s.q = e.target.value; doSearch(0); } } });
    const kids = [h('div', { class: 'searchbar' }, input, h('button', { id: 'search-btn', onclick: () => { s.q = input.value; doSearch(0); } }, 'Search'))];
    if (s.error) kids.push(errorNote(s.error));
    if (s.loading) kids.push(h('div', { class: 'empty' }, h('span', { class: 'spin' }), 'Searching…'));
    const installedIds = new Set(st.rows.map((r) => lower(r.id)));
    const list = h('div', { class: 'items', role: 'listbox', id: 'results' }, s.items.map((x) => pkgItem(x.id, h('span', {}, `${x.version} · ${fmtNum(x.totalDownloads)} downloads${x.authors ? ` · ${x.authors}` : ''}`, h('div', { class: 'desc' }, x.description)), [x.verified ? badge('✓', 'ok', 'Verified owner prefix on nuget.org') : null, installedIds.has(lower(x.id)) ? badge('installed', 'muted') : null, x.deprecated ? badge('deprecated', 'warn') : null, x.vulnerable ? badge('vulnerable', 'sev sev2') : null], () => openDetails(x.id, { latest: x.version }))));
    kids.push(list);
    if (!s.loading && !s.error && s.items.length < s.total) kids.push(h('button', { class: 'secondary more', onclick: () => doSearch(s.items.length) }, `Load more (${s.items.length} of ${fmtNum(s.total)})`));
    if (!s.loading && !s.error && !s.items.length && s.done) kids.push(h('div', { class: 'empty' }, 'No packages found.'));
    return kids;
  }

  function installedList() {
    const groups = installedGroups();
    const kids = [h('div', { class: 'searchbar' }, h('input', { type: 'search', id: 'filter', placeholder: 'Filter installed packages', value: st.filter, 'aria-label': 'Filter installed packages', oninput: (e) => { st.filter = e.target.value; render(); } }))];
    if (!groups.length) kids.push(h('div', { class: 'empty' }, st.projects.length ? 'No package references.' : 'No projects.'));
    kids.push(h('div', { class: 'items', role: 'listbox', id: 'installed' }, groups.map((g) => {
      const versions = [...new Set(g.rows.map((r) => r.declared || '?'))];
      const anyOut = g.rows.map(an).find((a) => a && a.outdated);
      const adv = g.rows.map(an).filter(Boolean).flatMap((a) => a.advisories || []);
      const dep = g.rows.map(an).some((a) => a && a.deprecation);
      const sub = `${versions.join(', ')}${anyOut ? ` → ${anyOut.target}` : ''} · ${g.rows.length === 1 ? g.rows[0].projectName : `${new Set(g.rows.map((r) => r.projectFile)).size} projects`}`;
      return pkgItem(g.id, sub, [anyOut ? badge('update', 'up') : null, advBadge(adv), dep ? badge('deprecated', 'warn') : null, versions.length > 1 ? badge(`${versions.length} versions`, 'muted') : null, sourceTag(g.rows[0])], () => openDetails(g.id));
    })));
    return kids;
  }

  function updatesList() {
    if (st.analysisState !== 'done') return h('div', { class: 'empty' }, h('span', { class: 'spin' }), 'Checking for updates…');
    const rows = updateRows();
    if (!rows.length) return h('div', { class: 'empty', id: 'no-updates' }, 'Every package is up to date.');
    const allKeys = rows.map((r) => r.key);
    const all = h('input', { type: 'checkbox', id: 'check-all', 'aria-label': 'Select all', checked: allKeys.every((k) => st.checked.has(k)), onchange: (e) => { allKeys.forEach((k) => (e.target.checked ? st.checked.add(k) : st.checked.delete(k))); render(); } });
    const n = allKeys.filter((k) => st.checked.has(k)).length;
    return [
      h('div', { class: 'actions' }, h('label', { class: 'check' }, all, 'Select all'),
        h('button', { id: 'update-selected', disabled: !n || st.busy, onclick: () => doUpdate([...st.checked].filter((k) => allKeys.includes(k))) }, `Update selected (${n})`),
        h('button', { class: 'secondary', id: 'update-all', disabled: st.busy, onclick: () => doUpdate(allKeys) }, `Update all (${rows.length})`)),
      h('div', { class: 'items', role: 'listbox', id: 'updates' }, rows.map((r) => {
        const a = an(r);
        const cb = h('input', { type: 'checkbox', class: 'rowcheck', 'aria-label': `Select ${r.id} in ${r.projectName}`, checked: st.checked.has(r.key), onclick: (e) => e.stopPropagation(), onchange: (e) => { if (e.target.checked) st.checked.add(r.key); else st.checked.delete(r.key); render(); } });
        const note = (a.kind === 'range' && a.latest && a.latest !== a.target ? ` (newest ${a.latest} is outside ${r.declared})` : '') + (a.newerNeedsFramework ? ` (${a.newerNeedsFramework} needs a newer target framework)` : '');
        return pkgItem(r.id, `${r.projectName}: ${r.declared} → ${a.target}${note}${r.condition ? ` · if ${r.condition}` : ''}`, [advBadge(a.advisories), a.deprecation ? badge('deprecated', 'warn') : null, sourceTag(r)], () => openDetails(r.id, { prefer: a.target }), cb);
      })),
    ];
  }

  function vulnList() {
    if (st.analysisState !== 'done') return h('div', { class: 'empty' }, h('span', { class: 'spin' }), 'Checking…');
    const rows = vulnRows();
    const kids = [];
    if (st.vulnError) kids.push(errorNote(st.vulnError, ' The vulnerability list could not be loaded; flags come from package metadata only.'));
    if (!rows.length) { kids.push(h('div', { class: 'empty', id: 'no-vulns' }, 'No known vulnerable or deprecated packages among the direct references.')); return kids; }
    kids.push(h('div', { class: 'items', role: 'listbox', id: 'vulns' }, rows.map((r) => {
      const a = an(r);
      const sub = h('div', {}, `${r.projectName}: ${a.current || r.declared}`, (a.advisories || []).map((x) => h('div', { class: 'adv' }, badge(x.severityText || SEV[x.severity] || '?', `sev sev${x.severity}`), ' ', h('a', { href: x.url, onclick: (e) => { e.preventDefault(); e.stopPropagation(); send({ type: 'openUrl', url: x.url }); } }, x.url.replace(/^https:\/\/github\.com\/advisories\//, ''))) ),
        a.deprecation ? h('div', { class: 'adv' }, badge('deprecated', 'warn'), ` ${(a.deprecation.reasons || []).join(', ')}${a.deprecation.alternate ? `; use ${a.deprecation.alternate.id} instead` : ''}`) : null,
        a.target ? h('div', { class: 'adv' }, `Update available: ${a.target}`) : null);
      return pkgItem(r.id, sub, [advBadge(a.advisories)], () => openDetails(r.id, { prefer: a.target }));
    })));
    return kids;
  }

  function consolidateList() {
    const rows = consolidationRows();
    if (!rows.length) return h('div', { class: 'empty', id: 'no-consolidate' }, 'Every package uses one version across the projects.');
    return h('div', { class: 'items', role: 'listbox', id: 'consolidate' }, rows.map((c) => pkgItem(c.id, c.versions.map((v) => `${v.version}: ${v.projects.join(', ')}`).join(' · '), [badge(`${c.versions.length} versions`, 'warn')], () => openDetails(c.id, { prefer: c.versions[c.versions.length - 1].version }))));
  }

  // ---------- details ----------
  function openDetails(id, opts = {}) {
    st.sel = { id, ...opts }; st.details = null; st.leaf = null; st.readme = null;
    const seq = ++st.seq;
    st.detailsSeq = seq;
    send({ type: 'details', id, seq, source: st.tab === 'browse' ? st.source : null });
    render();
  }

  function visibleVersions() {
    const d = st.details;
    if (!d) return [];
    const installed = new Set(st.rows.filter((r) => lower(r.id) === lower(d.id)).map((r) => r.declared));
    return d.versions.filter((v) => (v.listed || installed.has(v.version)) && (st.prerelease || !v.version.includes('-') || installed.has(v.version) || (st.sel && st.sel.prefer === v.version))).slice().reverse();
  }

  function chooseVersion() {
    const vs = visibleVersions();
    if (!vs.length) return null;
    if (st.sel.prefer && vs.some((v) => v.version === st.sel.prefer)) return st.sel.prefer;
    return vs[0].version;
  }

  function detailsPane() {
    if (!st.sel) return h('div', { class: 'empty' }, st.tab === 'browse' ? 'Search, then pick a package to see its details.' : 'Pick a package to see its versions and projects.');
    const d = st.details;
    if (!d) return h('div', { class: 'empty' }, h('span', { class: 'spin' }), `Loading ${st.sel.id}…`);
    if (d.error) return [h('h2', {}, st.sel.id), errorNote(d.error)];
    const vs = visibleVersions();
    const version = st.sel.version || chooseVersion();
    st.sel.version = version;
    const vInfo = d.versions.find((v) => v.version === version) || {};
    const leaf = st.leaf && st.leaf.version === version ? st.leaf.leaf : null;
    const sel = h('select', { id: 'version', 'aria-label': 'Version', onchange: (e) => { st.sel.version = e.target.value; st.leaf = null; st.readme = null; send({ type: 'leaf', id: d.id, version: e.target.value, source: d.source }); render(); } },
      vs.map((v) => h('option', { value: v.version, selected: v.version === version }, `${v.version}${v === vs[0] ? (v.version.includes('-') ? ' (latest prerelease)' : ' (latest)') : ''}${v.deprecated ? ' · deprecated' : ''}${v.advisories && v.advisories.length ? ' · vulnerable' : ''}${!v.listed ? ' · unlisted' : ''}`)));
    const head = h('div', { class: 'dhead' }, h('h2', { id: 'd-title' }, d.id), h('span', { class: 'muted' }, ` from ${d.source || 'feed'}`));
    const warn = [];
    if (vInfo.advisories && vInfo.advisories.length) warn.push(h('div', { class: 'note error', id: 'd-vuln' }, `${version} has ${vInfo.advisories.length} known vulnerabilit${vInfo.advisories.length === 1 ? 'y' : 'ies'}: `, vInfo.advisories.map((a) => h('a', { href: a.url, onclick: (e) => { e.preventDefault(); send({ type: 'openUrl', url: a.url }); } }, `${a.severityText || SEV[a.severity]} `))));
    if (leaf && leaf.deprecation) warn.push(h('div', { class: 'note warn', id: 'd-deprecated' }, `Deprecated (${(leaf.deprecation.reasons || []).join(', ')}). ${leaf.deprecation.message || ''}${leaf.deprecation.alternate ? ` Use ${leaf.deprecation.alternate.id} instead.` : ''}`));
    // projects
    const scope = st.projects.filter((p) => (!st.project || p.file === st.project) && !p.error);
    const uses = st.rows.filter((r) => lower(r.id) === lower(d.id));
    const prow = scope.map((p) => {
      const mine = uses.filter((r) => r.projectFile === p.file);
      if (p.isProps && !mine.length) return null;
      const acts = [];
      if (!mine.length) {
        if (p.packagesConfig) acts.push(h('span', { class: 'muted' }, 'packages.config: not supported'));
        else acts.push(h('button', { class: 'small', 'data-act': 'install', 'data-project': p.name, disabled: st.busy || !version, onclick: () => doInstall(d.id, version, [p.file]) }, 'Install'));
      }
      for (const r of mine) {
        if (r.declared !== version && !r.inherited) acts.push(h('button', { class: 'small', 'data-act': 'update', 'data-project': p.name, disabled: st.busy, onclick: () => doUpdate([r.key], version) }, cmpVer(version, r.declared || '0') > 0 ? `Update to ${version}` : `Change to ${version}`));
        if (!r.inherited) acts.push(h('button', { class: 'small secondary', 'data-act': 'remove', 'data-project': p.name, disabled: st.busy, onclick: () => doRemove([r.key], `${d.id} from ${p.name}`) }, 'Remove'));
      }
      return h('tr', { 'data-project': p.name }, h('td', {}, p.name, p.cpm ? badge('central', 'muted', `Versions in ${p.propsFile}`) : null),
        h('td', {}, mine.length ? mine.map((r) => h('div', {}, r.declared || '(no version)', r.condition ? h('span', { class: 'muted' }, ` if ${r.condition}`) : null, ' ', sourceTag(r), r.property ? h('span', { class: 'muted' }, ` ${r.property}`) : null)) : h('span', { class: 'muted' }, '—')),
        h('td', { class: 'acts' }, acts));
    });
    const notInstalled = scope.filter((p) => !p.isProps && !p.packagesConfig && !uses.some((r) => r.projectFile === p.file));
    const meta = [];
    if (leaf) {
      if (leaf.description) meta.push(h('p', { class: 'desc', id: 'd-desc' }, leaf.description));
      const dl = h('dl', { class: 'meta' });
      const row = (k, v) => { if (v) dl.append(h('dt', {}, k), h('dd', {}, v)); };
      row('Authors', leaf.authors);
      row('Licence', leaf.licenseExpression || (leaf.licenseUrl ? h('a', { href: leaf.licenseUrl, onclick: (e) => { e.preventDefault(); send({ type: 'openUrl', url: leaf.licenseUrl }); } }, 'licence URL') : ''));
      row('Project', leaf.projectUrl ? h('a', { href: leaf.projectUrl, onclick: (e) => { e.preventDefault(); send({ type: 'openUrl', url: leaf.projectUrl }); } }, leaf.projectUrl) : '');
      row('Published', leaf.published && !/^1900/.test(leaf.published) ? leaf.published.slice(0, 10) : '');
      row('Tags', (leaf.tags || []).slice(0, 12).join(', '));
      meta.push(dl);
      if (leaf.dependencyGroups && leaf.dependencyGroups.length) {
        meta.push(h('details', { class: 'deps', id: 'd-deps' }, h('summary', {}, `Dependencies (${leaf.dependencyGroups.length} target framework${leaf.dependencyGroups.length === 1 ? '' : 's'})`),
          leaf.dependencyGroups.map((g) => h('div', { class: 'dep' }, h('strong', {}, g.framework), g.dependencies.length ? h('ul', {}, g.dependencies.map((x) => h('li', {}, `${x.id} ${x.range || ''}`))) : h('div', { class: 'muted' }, 'No dependencies')))));
      }
      meta.push(h('div', { class: 'readme' }, st.readme && st.readme.version === version
        ? (st.readme.error ? errorNote(st.readme.error) : st.readme.text ? h('pre', { id: 'd-readme' }, st.readme.text) : h('div', { class: 'muted' }, 'This version has no README on the feed.'))
        : h('button', { class: 'secondary', id: 'show-readme', onclick: () => { st.readme = { version, loading: true, text: '' }; send({ type: 'readme', id: d.id, version, source: d.source }); render(); } }, 'Show README')));
    } else meta.push(h('div', { class: 'muted' }, h('span', { class: 'spin' }), 'Loading version details…'));
    return [head,
      h('div', { class: 'vrow' }, h('label', { for: 'version' }, 'Version'), sel,
        notInstalled.length > 1 ? h('button', { id: 'install-all', disabled: st.busy || !version, onclick: () => doInstall(d.id, version, notInstalled.map((p) => p.file)) }, `Install in ${notInstalled.length} projects`) : null),
      warn,
      scope.length ? h('table', { class: 'projects', id: 'd-projects' }, h('thead', {}, h('tr', {}, h('th', {}, 'Project'), h('th', {}, 'Installed'), h('th', {}, ''))), h('tbody', {}, prow)) : h('div', { class: 'muted' }, 'Open a folder with a project to install this package.'),
      meta];
  }

  // ---------- actions ----------
  function doSearch(skip) {
    const s = st.search;
    s.loading = true; s.error = null; if (!skip) { s.items = []; s.total = 0; }
    s.seq = ++st.seq;
    send({ type: 'search', q: s.q, prerelease: st.prerelease, source: st.source, skip, seq: s.seq });
    render();
  }
  function busy(text) { st.busy = true; st.notice = { text, cls: '' }; render(); }
  function doInstall(id, version, projects) { busy(`Installing ${id} ${version}…`); send({ type: 'install', id, version, projects }); }
  function doUpdate(keys, version) { busy(`Updating ${keys.length} reference${keys.length === 1 ? '' : 's'}…`); send({ type: 'update', keys, version: version || null }); }
  function doRemove(keys, what) { busy(`Removing ${what}…`); send({ type: 'remove', keys }); }

  // ---------- messages ----------
  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    switch (m.type) {
      case 'init':
        Object.assign(st, { projects: m.projects, solutions: m.solutions, sources: m.sources, prerelease: m.prerelease, pro: m.pro, dotnet: m.dotnet, legacy: m.legacy, folder: m.folder });
        if (!st.source || !m.sources.some((s) => s.key === st.source && s.usable)) st.source = ((m.sources.find((s) => s.usable && s.isNugetOrg) || m.sources.find((s) => s.usable)) || {}).key || '';
        if (m.project) st.project = m.projects.some((p) => p.file === m.project) ? m.project : '';
        if (m.tab) st.tab = m.tab;
        else if (!st.inited && !m.projects.length) st.tab = 'browse';
        if (!st.inited && st.tab === 'browse') { st.inited = true; render(); doSearch(0); return; }
        st.inited = true;
        render();
        return;
      case 'focus':
        if (m.project !== undefined && m.project !== null) st.project = st.projects.some((p) => p.file === m.project) ? m.project : '';
        if (m.tab) st.tab = m.tab;
        render();
        return;
      case 'installed':
        st.rows = m.rows; st.consolidation = m.consolidation;
        render();
        return;
      case 'analysis':
        if (m.state === 'running') { st.analysisState = st.analysisState === 'done' ? 'done' : 'running'; st.refreshing = true; render(); return; }
        if (m.state === 'error') { st.analysisState = 'error'; st.analysisError = m.error; render(); return; }
        st.analysisState = 'done'; st.analysis = new Map(m.rows.map((r) => [r.key, r])); st.analysisErrors = m.errors || []; st.vulnError = m.vulnError;
        render();
        return;
      case 'searchResults': {
        const s = st.search;
        if (m.seq !== s.seq) return;
        s.loading = false; s.done = true;
        if (m.error) { s.error = m.error; render(); return; }
        s.items = m.skip ? s.items.concat(m.items) : m.items; s.total = m.total;
        render();
        return;
      }
      case 'details':
        if (m.seq !== st.detailsSeq) return;
        st.details = m.error ? { error: m.error } : { id: m.id, source: m.source, versions: m.versions };
        if (!m.error) { const v = chooseVersion(); if (v) { st.sel.version = v; send({ type: 'leaf', id: m.id, version: v, source: m.source }); } }
        render();
        return;
      case 'leaf':
        if (!st.sel || lower(st.sel.id) !== lower(m.id)) return;
        st.leaf = { version: m.version, leaf: m.leaf || (m.error ? { description: m.error.message } : null) };
        render();
        return;
      case 'readme':
        if (!st.sel || lower(st.sel.id) !== lower(m.id)) return;
        st.readme = { version: m.version, text: m.text || '', error: m.error || null };
        render();
        return;
      case 'changed':
        st.changes = (st.changes || 0) + 1;
        document.body.dataset.changes = String(st.changes);
        document.body.dataset.restore = 'pending';
        st.busy = false; st.checked.clear();
        st.notice = { text: `Saved: ${m.summary}.`, cls: 'ok' };
        render();
        return;
      case 'restore': {
        if (m.state !== 'running') document.body.dataset.restore = m.state;
        if (m.state === 'off') return;
        const cls = { ok: 'ok', failed: 'error', skipped: 'warn', running: '' }[m.state] || '';
        st.notice = { text: m.message, cls, restore: m.state };
        render();
        return;
      }
      case 'error':
        st.busy = false;
        st.notice = { text: (m.error && m.error.message) || 'Something went wrong.', cls: 'error' };
        render();
        return;
      default:
    }
  });

  document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) document.querySelectorAll('.menu.open').forEach((x) => x.classList.remove('open')); });
  render();
  send({ type: 'ready' });
}());
