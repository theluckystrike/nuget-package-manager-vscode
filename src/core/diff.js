'use strict';
// A small unified diff (line based) for the preview of multi-file changes.

function lines(t) { return t == null ? [] : t.replace(/\r\n/g, '\n').split('\n'); }

/** LCS table on the middle part (after the common head and tail are cut), so big files with small edits stay cheap. */
function ops(a, b) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail); const B = b.slice(head, b.length - tail);
  const out = [];
  for (let i = 0; i < head; i++) out.push([' ', a[i]]);
  if (A.length * B.length > 4e6) {
    for (const x of A) out.push(['-', x]);
    for (const x of B) out.push(['+', x]);
  } else {
    const n = A.length; const m = B.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0; let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { out.push([' ', A[i]]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(['-', A[i]]); i++; } else { out.push(['+', B[j]]); j++; }
    }
    while (i < n) out.push(['-', A[i++]]);
    while (j < m) out.push(['+', B[j++]]);
  }
  for (let i = a.length - tail; i < a.length; i++) out.push([' ', a[i]]);
  return out;
}

/** Unified diff text with 3 lines of context. */
function unified(before, after, nameA, nameB, context = 3) {
  const o = ops(lines(before), lines(after));
  const res = [`--- ${before == null ? '/dev/null' : nameA}`, `+++ ${nameB}`];
  let k = 0;
  let la = 1; let lb = 1;
  const pos = o.map((x) => { const p = [la, lb]; if (x[0] !== '+') la++; if (x[0] !== '-') lb++; return p; });
  while (k < o.length) {
    if (o[k][0] === ' ') { k++; continue; }
    let s = Math.max(0, k - context);
    let e = k;
    for (;;) {
      while (e < o.length && o[e][0] !== ' ') e++;
      let run = e;
      while (run < o.length && o[run][0] === ' ' && run - e < context * 2) run++;
      if (run < o.length && o[run][0] !== ' ') { e = run; continue; }
      e = Math.min(o.length, e + context);
      break;
    }
    const chunk = o.slice(s, e);
    const ca = chunk.filter((x) => x[0] !== '+').length; const cb = chunk.filter((x) => x[0] !== '-').length;
    res.push(`@@ -${pos[s][0]},${ca} +${pos[s][1]},${cb} @@`);
    for (const [t, l] of chunk) res.push(t + l);
    k = e;
  }
  return res.join('\n');
}

module.exports = { unified, ops };
