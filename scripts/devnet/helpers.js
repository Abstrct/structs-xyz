// UI helpers injected into the page (curl localhost:9555/eval --data-binary @scripts/devnet/helpers.js).
// They act through the DOM — real clicks on real buttons — so the client code paths under test
// are the ones a player hits.
window.e2e = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  /** Visible elements matching `sel` whose text matches `re`. */
  all(sel, re) {
    return [...document.querySelectorAll(sel)].filter((b) => (!re || re.test(b.textContent || '')) && b.offsetParent !== null);
  },
  btn(re, scope = document) { return [...scope.querySelectorAll('button, .btn, [role=button]')].find((b) => re.test(b.textContent || '') && b.offsetParent !== null); },
  click(re, scope) { const b = typeof re === 'string' ? document.querySelector(re) : this.btn(re, scope); if (!b) throw new Error('no button ' + re); b.click(); return (b.textContent || '').trim().slice(0, 60); },
  type(el, value) {
    const e = typeof el === 'string' ? document.querySelector(el) : el;
    if (!e) throw new Error('no input ' + el);
    const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : e.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, value);
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
  },
  /** Accept the open confirm dialog (confirmBox), if any. */
  async confirm(ms = 1500) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const c = document.querySelector('.confirm-back'); if (c) { [...c.querySelectorAll('button')].at(-1).click(); await this.sleep(50); return true; } await this.sleep(30); }
    return false;
  },
  /** Forge: queue the current form (accepting the confirm). */
  async forgeQueue() { const n = window.__structs.txq.jobs.length; this.click(/^Queue it$/, document.querySelector('.fg-actions')); await this.confirm(); await this.waitFor(() => window.__structs.txq.jobs.length > n, 3000, 20); return window.__structs.txq.jobs.at(-1).id; },
  async waitFor(fn, ms = 60000, every = 250) {
    const t0 = Date.now();
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + fn); await this.sleep(every); }
  },
  /** Compact view of the tx queue. */
  jobs(n = 12) {
    return window.__structs.txq.jobs.slice(-n).map((j) => ({ id: j.id, label: j.label, status: j.status, why: j.waitReason, err: j.error, hash: j.hash, h: j.height, att: j.attempts, src: j.source, acct: j.account }));
  },
  /** Records every status transition of every job (with block heights) into e2e.trace. */
  traceJobs() {
    if (this._tracing) return 'already';
    this._tracing = true; this.trace = [];
    const last = new Map();
    window.__structs.txq.onChange((jobs) => {
      for (const j of jobs) {
        const k = j.status + '|' + (j.waitReason || '');
        if (last.get(j.id) === k) continue;
        last.set(j.id, k);
        this.trace.push({ t: Date.now(), h: window.__structs.live.height, id: j.id, label: j.label, status: j.status, why: j.waitReason, hash: j.hash, err: j.error });
      }
    });
    return 'tracing';
  },
  powView() {
    const p = window.__structs.pow;
    return { rate: Math.round(p.rate), gpu: p.gpu, tasks: [...p.tasks.values()].map((t) => ({ id: t.id, status: t.status, best: t.best && t.best.zeros, req: p.required(t), hashes: t.hashes, workers: t.workers, err: t.error, job: t.jobId })) };
  },
};
'helpers ready';
