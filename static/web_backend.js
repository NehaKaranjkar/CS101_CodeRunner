"use strict";
/* web_backend.js - practice-site backend. Implements the same requests as
   exam.py (/api/state, /api/bank, /api/exam, /api/save, /api/precheck,
   /api/check, /api/submit, /api/reset) entirely in the browser:
     - student code runs in Pyodide inside a Web Worker (pyworker.js),
     - progress is kept in the browser's localStorage, and can be downloaded
       to / opened from a file.
   The marking rules mirror exam.py and runner.py; keep them in step. */

const WEB_TIMEOUT_SECONDS = 3;   // per test; Pyodide is a little slower than native Python

const WebBackend = (() => {
  /* ---------------- helpers ---------------- */
  const nowIso = () => {
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const codeHash = (s) => {           // cyrb53: equality check only
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  };
  const normalise = (t) => t.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").replace(/\n+$/, "");
  const round2 = (x) => Math.round(x * 100) / 100;

  function penaltyPct(regime, failedBefore) {     // same as common.penalty_pct
    const steps = (regime && regime.steps) || [];
    if (failedBefore <= 0 || !steps.length) return 0;
    const i = failedBefore - 1;
    let p;
    if (i < steps.length) p = steps[i];
    else if (regime.extend) {
      const inc = steps.length > 1 ? steps[steps.length - 1] - steps[steps.length - 2] : steps[0];
      p = steps[steps.length - 1] + (i - steps.length + 1) * inc;
    } else p = steps[steps.length - 1];
    return Math.min(Math.max(p, 0), 100);
  }

  /* ---------------- Python in a worker ---------------- */
  class PyRunner {
    constructor() { this.spawn(); }
    spawn() {
      this.pending = new Map();
      this.seq = 0;
      this.ready = new Promise((res, rej) => { this._ok = res; this._fail = rej; });
      this.ready.catch(() => {});
      this.worker = new Worker("static/pyworker.js", { type: "module" });
      this.worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === "ready") return this._ok();
        if (m.type === "failed") return this._fail(new Error("Python could not be loaded in this browser: " + m.error));
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); clearTimeout(p.timer); p.resolve(m); }
      };
      this.worker.onerror = (e) => {
        e.preventDefault();
        this._fail(new Error("Python could not be started in this browser. Use an up-to-date Firefox or Chrome."));
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, error: "The Python engine crashed." }); }
        this.pending.clear();
        this.dead = true;
      };
    }
    async call(msg, timeoutMs) {
      if (this.dead) { this.dead = false; this.spawn(); }
      try { await this.ready; }
      catch (e) { this.dead = true; throw e; }
      return new Promise((resolve) => {
        const id = ++this.seq;
        const timer = timeoutMs ? setTimeout(() => {
          this.pending.delete(id);
          this.worker.terminate();      // the only way to stop an infinite loop
          this.spawn();
          resolve({ timeout: true });
        }, timeoutMs) : null;
        this.pending.set(id, { resolve, timer });
        this.worker.postMessage({ ...msg, id });
      });
    }
  }
  let py = null;
  const python = () => (py = py || new PyRunner());

  async function runProgram(program, stdin) {
    const r = await python().call({ kind: "run", code: program, stdin }, WEB_TIMEOUT_SECONDS * 1000);
    if (r.timeout) return [`\n***Time limit exceeded (${WEB_TIMEOUT_SECONDS} s); infinite loop?***`, "timeout"];
    if (!r.ok) {
      const deep = /call stack|too much recursion/i.test(r.error || "");
      return [deep ? "RecursionError: maximum recursion depth exceeded (browser limit; the lab computers allow deeper recursion)"
                   : "***The program crashed: " + r.error + "***", "error"];
    }
    return r.result;
  }

  async function runTests(code, tests, mode, maxMark) {   // same as runner.run_tests
    const selected = tests.filter((t) => (mode === "precheck" ? t.in_precheck : t.in_check));
    const result = { mode, syntax_error: null, tests: [], aborted: false, passed_all: false, mark: 0, max_mark: maxMark };
    const syn = await python().call({ kind: "syntax", code }, 10000);
    if (syn.timeout) throw new Error("Python did not respond. Please try again.");
    if (syn.ok && syn.result) { result.syntax_error = syn.result; return result; }
    for (let n = 1; n <= selected.length; n++) {
      const t = selected[n - 1];
      const program = t.testcode.trim() ? code.replace(/\n+$/, "") + "\n\n" + t.testcode + "\n" : code;
      const [got, status] = await runProgram(program, t.stdin);
      const passed = status === "ok" && normalise(got) === normalise(t.expected);
      result.tests.push({ n, show: t.show, testcode: t.testcode, stdin: t.stdin, expected: t.expected, got, status, passed });
      if (status !== "ok") { result.aborted = selected.length > n; break; }
    }
    const nPass = result.tests.filter((r) => r.passed).length;
    result.passed_all = nPass === selected.length && !result.aborted;
    if (mode === "check") result.mark = result.passed_all ? maxMark : 0;   // all-or-nothing
    return result;
  }

  /* ---------------- practice session ---------------- */
  let bank = null, sol = null;
  // progress survives republishing as long as the questions/settings are unchanged
  const storeKey = () => `crpractice:${bank.bank_name}:${bank.content_hash || bank.built_at}`;
  const persist = () => { sol.last_saved_at = nowIso(); try { localStorage.setItem(storeKey(), JSON.stringify(sol)); } catch (e) { /* storage full or disabled */ } };

  function newSol() {
    const start = Date.now() / 1000, st = bank.settings;
    return {
      format: "qsol-2", bank_name: bank.bank_name, bank_built_at: bank.built_at, title: st.title,
      roll: "PRACTICE", name: "", started_at: nowIso(), started_epoch: start,
      deadline_epoch: st.time_limit ? start + st.duration_seconds : null,   // own start in practice
      last_saved_at: null, submitted: false, submitted_at: null, submit_reason: null,
      questions: bank.questions.map((q, i) => ({
        display_no: i + 1, xml_index: q.xml_index, xml_name: q.xml_name, max_marks: q.mark,
        code: q.answerpreload, state: "not_attempted", marks: 0, modified: false, checked_hash: null,
        tests_passed: null, tests_total: null, failed_checks: 0, penalty_pct: 0,
        prechecks: 0, checks: 0, saves: 0, last_action: null, last_action_at: null,
      })),
    };
  }

  function summary() {
    const qs = sol.questions;
    return {
      marks: round2(qs.reduce((a, q) => a + q.marks, 0)), max_marks: round2(qs.reduce((a, q) => a + q.max_marks, 0)),
      correct: qs.filter((q) => q.state === "correct").length, wrong: qs.filter((q) => q.state === "wrong").length,
      not_attempted: qs.filter((q) => q.state === "not_attempted").length, total_questions: qs.length,
    };
  }

  function status() {
    const regime = bank.settings.penalty;
    return {
      summary: summary(),
      questions: sol.questions.map((q) => ({
        no: q.display_no, state: q.state, marks: q.marks, max_marks: q.max_marks, modified: q.modified,
        code: q.code, tests_passed: q.tests_passed, tests_total: q.tests_total, failed_checks: q.failed_checks,
        next_worth_pct: 100 - penaltyPct(regime, q.failed_checks),
      })),
      submitted: sol.submitted, submit_reason: sol.submit_reason, submitted_at: sol.submitted_at, last_saved_at: sol.last_saved_at,
    };
  }

  const timeUp = () => sol.deadline_epoch != null && Date.now() / 1000 > sol.deadline_epoch + 20;

  function question(no) {
    no = Number(no);
    if (!(no >= 1 && no <= sol.questions.length)) throw new Error("Unknown question.");
    return [bank.questions[no - 1], sol.questions[no - 1]];
  }

  function storeCode(bq, sq, code, action) {
    sq.code = code;
    sq.modified = sq.checked_hash == null ? code.trim() !== bq.answerpreload.trim() : sq.checked_hash !== codeHash(code);
    sq.last_action = action; sq.last_action_at = nowIso();
  }

  async function applyCheck(bq, sq, code) {          // same rules as exam.py _apply_check
    const full = await runTests(code, bq.tests, "check", bq.mark);
    const h = codeHash(code);
    if (h === sq.checked_hash) { full.repeat = true; full.mark = sq.marks; full.penalty_pct = sq.penalty_pct; return full; }
    const pen = penaltyPct(bank.settings.penalty, sq.failed_checks);
    sq.checks += 1; sq.penalty_pct = pen;
    sq.marks = round2(full.mark * (1 - pen / 100));
    if (full.passed_all) sq.state = "correct";
    else { sq.state = "wrong"; sq.failed_checks += 1; }
    sq.checked_hash = h; sq.modified = false;
    sq.tests_passed = full.tests.filter((t) => t.passed).length;
    sq.tests_total = bq.tests.filter((t) => t.in_check).length;
    full.mark = sq.marks; full.penalty_pct = pen;
    return full;
  }

  async function finalize(reason) {
    for (let i = 0; i < sol.questions.length; i++) {
      const sq = sol.questions[i], bq = bank.questions[i];
      if (sq.modified) { await applyCheck(bq, sq, sq.code); sq.last_action = "graded_at_submit"; sq.last_action_at = nowIso(); }
    }
    sol.submitted = true; sol.submitted_at = nowIso(); sol.submit_reason = reason;
    persist();
  }

  function loadBank(buf, name) {
    const bytes = new Uint8Array(buf);
    if (String.fromCharCode(...bytes.slice(0, 8)) === "Salted__") {
      throw new Error("This is an encrypted exam file. It can only be opened with the exam program on the lab computers.");
    }
    let b;
    try { b = JSON.parse(new TextDecoder().decode(bytes)); }
    catch (e) { throw new Error(`${name} is not a question set file.`); }
    if (b.format !== "qbank-1" || !b.settings || !Array.isArray(b.questions)) throw new Error(`${name} is not a supported question set file.`);
    bank = b;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(storeKey()) || "null"); } catch (e) { saved = null; }
    sol = saved && saved.questions && saved.questions.length === bank.questions.length ? saved : newSol();
    python();                                  // start loading Python in the background
  }

  function view() {
    const st = bank.settings;
    return {
      mode: "practice", title: st.title, bank_name: bank.bank_name, roll: sol.roll, name: sol.name,
      started_at: sol.started_at, started_epoch: sol.started_epoch, deadline_epoch: sol.deadline_epoch,
      server_now: Date.now() / 1000, penalty_text: st.penalty_text, penalty_on: !!(st.penalty.steps || []).length,
      sections: st.sections || [], submitted: sol.submitted, sol_path: null,
      questions: bank.questions.map((q, i) => ({
        no: i + 1, title: q.display_name, html: q.questiontext_html, mark: q.mark, preload: q.answerpreload,
        examples: q.tests.filter((t) => t.example).map((t) => ({ testcode: t.testcode, stdin: t.stdin, expected: t.expected })),
      })),
      status: status(),
    };
  }

  /* ---------------- request dispatcher (same paths as exam.py) ---------------- */
  async function request(path, body, rawName) {
    switch (path) {
      case "/api/state":
        if (!bank) return { phase: "choose_bank", mode: "practice" };
        return { phase: sol.submitted ? "done" : "exam", mode: "practice", title: bank.settings.title };
      case "/api/bank":
        loadBank(body, rawName);
        return request("/api/state");
      case "/api/reset":
        bank = sol = null;
        return { phase: "choose_bank" };
      case "/api/exam":
        if (!bank) throw new Error("No question set is open.");
        return view();
      case "/api/save": case "/api/precheck": case "/api/check": {
        if (sol.submitted || timeUp()) {
          if (!sol.submitted) await finalize("time_up");
          return { time_up: true, status: status() };
        }
        const [bq, sq] = question(body.no);
        const kind = path.split("/").pop();
        storeCode(bq, sq, body.code, kind);
        let result = null;
        if (kind === "save") sq.saves += 1;
        else if (kind === "precheck") { sq.prechecks += 1; result = await runTests(body.code, bq.tests, "precheck", bq.mark); }
        else result = await applyCheck(bq, sq, body.code);
        persist();
        return { result, status: status() };
      }
      case "/api/submit":
        if (!sol.submitted) {
          if (!timeUp()) for (const [no, code] of Object.entries(body.codes || {})) {
            const [bq, sq] = question(no);
            if (code !== sq.code) storeCode(bq, sq, code, "save");
          }
          await finalize(body.reason === "time_up" ? "time_up" : "student");
        }
        return { status: status() };
      default:
        throw new Error("Unknown request.");
    }
  }

  /* ---------------- progress files ---------------- */
  function exportProgress(docs) {
    for (const [no, doc] of Object.entries(docs)) {
      const [bq, sq] = question(no);
      if (!sol.submitted && doc.getValue() !== sq.code) storeCode(bq, sq, doc.getValue(), "save");
    }
    persist();
    return { name: `${bank.bank_name}_progress.json`, text: JSON.stringify(sol, null, 1) };
  }

  function importProgress(text) {
    let s;
    try { s = JSON.parse(text); } catch (e) { throw new Error("That is not a progress file."); }
    if (!s || s.bank_name !== bank.bank_name || !Array.isArray(s.questions)) {
      throw new Error("That progress file belongs to a different question set.");
    }
    const same = s.questions.length === bank.questions.length &&
      s.questions.every((q, i) => q.xml_name === bank.questions[i].xml_name);
    if (!same) throw new Error("That progress file is for a different version of this question set.");
    sol = s;
    persist();
  }

  function restart() { sol = newSol(); persist(); }

  return { request, exportProgress, importProgress, restart };
})();
