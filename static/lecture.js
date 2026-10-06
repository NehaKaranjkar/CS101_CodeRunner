"use strict";
/* lecture.js - student page of the CS101 lecture system (see docs/lecture_support_system.md).

   Sign in with Google (iitgoa.ac.in), list the lectures (active / past / future), join the active
   lecture with its password, answer the questions. In the ACTIVE lecture every answer is reported to
   the backend: multiple choice, short answer, predict-the-output and ordering are graded by the server
   (their keys are not sent to the phone); code questions run here in Pyodide and only the result is
   reported. PAST lectures are practice: the keys come with the content and nothing is reported.

   Testing locally: ?backend=http://localhost:8787&dev=someone@iitgoa.ac.in (a localhost backend with
   DEV_FAKE_AUTH=1 only; the live backend refuses fake sign-ins). */

const PARAMS = new URLSearchParams(location.search);
const LOCAL_BACKEND = /^http:\/\/localhost(:\d+)?$/.test(PARAMS.get("backend") || "");
const CFG = {
  backend: LOCAL_BACKEND ? PARAMS.get("backend") : "https://cs101-lectures.nehak.workers.dev",
  clientId: "568904904266-88njj8057372ocm6mj12b57cji6q32dc.apps.googleusercontent.com",
  devEmail: LOCAL_BACKEND ? PARAMS.get("dev") : null,
};
const TEST_TIMEOUT = 3, PLOT_TIMEOUT = 10;          // seconds per test (same as the practice site)
const KEY = { token: "lec:token", outbox: "lec:outbox" };

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "html") e.innerHTML = v;               // only for text written by the instructor
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
};
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full or blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};
const fmt = (x) => String(Math.round(x * 100) / 100);

/* ------------------------------------------------------------------ backend */

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const RETRY = /^\/api\/(join|answer|check|lectures|bundle|me)\b/;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Retries (up to 2 more times) when the network or the server hiccups: answers are safe to resend.
async function api(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    try { return await apiOnce(method, path, body); }
    catch (e) {
      const transient = e.status === 0 || e.status >= 500;
      if (!transient || attempt >= 2 || !(method === "GET" || RETRY.test(path))) throw e;
      await pause(700 * (attempt + 1));
    }
  }
}

async function apiOnce(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  const tok = store.get(KEY.token);
  if (tok) headers.Authorization = "Bearer " + tok;
  let r;
  try {
    r = await fetch(CFG.backend + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new ApiError(0, "No connection to the server. Check your internet and try again.");
  }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { store.del(KEY.token); }
  if (!r.ok) throw new ApiError(r.status, data.error || "Request failed.");
  return data;
}

/* Code-question results that could not be sent (network down) are kept and re-sent. */
function queueResult(item) {
  const box = store.get(KEY.outbox, []);
  box.push(item);
  store.set(KEY.outbox, box);
}
async function flushOutbox() {
  const box = store.get(KEY.outbox, []);
  if (!box.length) return;
  const left = [];
  for (const item of box) {
    try { const r = await api("POST", "/api/check", item); if (state.lec && state.lec.session === item.session) applyServerResults(r); }
    catch (e) { if (e.status === 0) left.push(item); }      // keep only network failures
  }
  store.set(KEY.outbox, left);
}
setInterval(flushOutbox, 15000);

/* ------------------------------------------------------------------ Python (Pyodide worker, shared with the practice site) */

class PyRunner {
  constructor() { this.spawn(); }
  spawn() {
    this.pending = new Map();
    this.seq = 0;
    this.ready = new Promise((res, rej) => { this._ok = res; this._fail = rej; });
    this.ready.catch(() => {});
    this.worker = new Worker("../static/pyworker.js", { type: "module" });
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "ready") return this._ok();
      if (m.type === "failed") return this._fail(new Error("Python could not be loaded: " + m.error));
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); clearTimeout(p.timer); p.resolve(m); }
    };
    this.worker.onerror = (e) => { e.preventDefault(); this._fail(new Error("Python could not be started in this browser.")); this.dead = true; };
  }
  async call(msg, timeoutMs) {
    if (this.dead) { this.dead = false; this.spawn(); }
    await this.ready;
    return new Promise((resolve) => {
      const id = ++this.seq;
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id); this.worker.terminate(); this.spawn(); resolve({ timeout: true });
      }, timeoutMs) : null;
      this.pending.set(id, { resolve, timer });
      this.worker.postMessage({ ...msg, id });
    });
  }
}
let py = null;
const python = () => (py = py || new PyRunner());

const normalise = (t) => String(t).replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").replace(/\n+$/, "");
const usesMatplotlib = (code) => /^[ \t]*(?:import|from)[ \t]+matplotlib/m.test(code);

function buildProgram(code, testcode, template) {          // same rule as runner.build_program
  if (template && template.trim()) {
    return template.replace(/\{\{\s*STUDENT_ANSWER\s*\}\}/g, () => code.replace(/\n+$/, ""))
                   .replace(/\{\{\s*TEST\.testcode\s*\}\}/g, () => testcode);
  }
  return testcode.trim() ? code.replace(/\n+$/, "") + "\n\n" + testcode + "\n" : code;
}

// Runs the tests of a code question; mode "examples" runs only the visible ones.
async function runCodeTests(q, code, mode) {
  const tests = (q.tests || []).filter((t) => mode === "all" || t.kind !== "hid");
  const res = { syntax: null, tests: [], passed: false };
  const syn = await python().call({ kind: "syntax", code }, 20000);
  if (syn.timeout) throw new Error("Python did not respond. Please try again.");
  if (syn.ok && syn.result) { res.syntax = syn.result; return res; }
  if (usesMatplotlib(code)) await python().call({ kind: "prepare", packages: ["matplotlib"] }, 180000);
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    const program = buildProgram(code, t.code || "", q.template || "");
    const limit = (usesMatplotlib(program) ? PLOT_TIMEOUT : TEST_TIMEOUT) * 1000;
    const r = await python().call({ kind: "run", code: program, stdin: t.stdin || "", capture: i === 0 }, limit);
    let got, status;
    if (r.timeout) { got = `***Time limit exceeded (${limit / 1000} s); infinite loop?***`; status = "timeout"; }
    else if (!r.ok) { got = "***The program crashed: " + r.error + "***"; status = "error"; }
    else { [got, status] = r.result; if (i === 0 && r.result[2] && r.result[2].length) res.figures = r.result[2]; }
    const passed = status === "ok" && normalise(got) === normalise(t.expected);
    res.tests.push({ n: i + 1, hidden: t.kind === "hid", code: t.code || "", stdin: t.stdin || "", expected: t.expected, got, passed });
    if (status !== "ok") break;                              // like the labs: stop at the first error
  }
  res.passed = res.tests.length === tests.length && res.tests.every((t) => t.passed);
  return res;
}

/* ------------------------------------------------------------------ local grading (past lectures only; same rules as the server) */

const squash = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
function gradeLocal(q, answer) {
  switch (q.type) {
    case "mcq": return Number(answer) === Number(q.answer);
    case "short": return (Array.isArray(q.answer) ? q.answer : [q.answer]).some((a) => squash(a) === squash(answer));
    case "predict": return normalise(answer) === normalise(q.answer);
    case "order": return JSON.stringify((answer || []).map(Number)) === JSON.stringify(q.answer.map(Number));
    default: return false;
  }
}

/* ------------------------------------------------------------------ state and top bar */

const state = { me: null, lec: null };      // lec: the open lecture (active or practice)

function setBar() {
  const me = state.me, lec = state.lec;
  $("bar-user").hidden = !me;
  if (me) $("bar-email").textContent = me.email;
  $("bar-instructor").hidden = !(me && me.instructor);
  $("bar-lec").hidden = !lec;
  $("bar-score").hidden = !lec;
  if (lec) {
    $("bar-title").textContent = (lec.active ? `Lec ${lec.lec_no}: ` : "") + lec.title;
    $("bar-date").textContent = lec.active ? `${lec.day} ${lec.date}` : "Practice (not recorded)";
    const qs = questions(lec.content);
    const solved = qs.filter((q) => (lec.status[q.qid] || {}).correct).length;
    const score = qs.length ? 10 * solved / qs.length : 0;
    $("bar-score").textContent = `${fmt(score)} / 10`;
    $("bar-score").title = `${solved} of ${qs.length} questions solved`;
  }
  const notOnRoster = me && !me.on_roster && !me.instructor;
  $("banner").hidden = !notOnRoster;
  $("banner").textContent = "Your login account is not among the registered students for CS101. Please contact the instructor. "
    + "You can still join and solve the questions, but your attendance is not recorded.";
}
$("btn-signout").addEventListener("click", () => {
  store.del(KEY.token);
  try { if (window.google) google.accounts.id.disableAutoSelect(); } catch (e) { /* ignore */ }
  state.me = null; state.lec = null;
  location.hash = "#/";
  route();
});

const questions = (content) => (content.items || []).filter((it) => it.kind === "question");

/* ------------------------------------------------------------------ sign-in */

function showSignIn(message) {
  state.me = null; state.lec = null; setBar();
  const box = el("div", { class: "gsi" });
  const view = $("view");
  view.replaceChildren(el("section", { class: "card center" },
    el("h1", { text: "CS101 Lectures" }),
    el("p", { text: "Sign in with your iitgoa.ac.in Google account to follow today's lecture and practise past ones." }),
    box,
    message ? el("p", { class: "err", text: message }) : null));
  if (CFG.devEmail) {
    box.append(el("button", { class: "primary", text: "Sign in (local test) as " + CFG.devEmail, onclick: async () => {
      const r = await api("POST", "/api/auth/dev", { email: CFG.devEmail, name: CFG.devEmail.split("@")[0] });
      store.set(KEY.token, r.token); route();
    } }));
    return;
  }
  const render = () => {
    if (!window.google || !google.accounts) return setTimeout(render, 200);
    google.accounts.id.initialize({ client_id: CFG.clientId, callback: onGoogle, ux_mode: "popup" });
    google.accounts.id.renderButton(box, { theme: "outline", size: "large", text: "signin_with", shape: "pill" });
  };
  render();
}

async function onGoogle(resp) {
  try {
    const r = await api("POST", "/api/auth/google", { credential: resp.credential });
    store.set(KEY.token, r.token);
    route();
  } catch (e) { showSignIn(e.message); }
}

/* ------------------------------------------------------------------ lecture list */

async function showList() {
  state.lec = null;
  const r = await api("GET", "/api/lectures");
  setBar();
  const lecs = r.lectures;
  const latest = (l) => Math.max(0, ...l.held.map((h) => h.started_at));
  const active = lecs.filter((l) => l.state === "active");
  const past = lecs.filter((l) => l.state === "past").sort((a, b) => latest(b) - latest(a));
  const future = lecs.filter((l) => l.state === "future");
  const card = (l) => {
    const recent = l.held.slice(-3).reverse().map((h) => `Lec ${h.lec_no} (${h.day} ${h.date})`).join(", ");
    const meta = l.state === "future" ? "coming up"
      : l.state === "active" ? `Lec ${l.active.lec_no}, now · ${l.questions} questions`
      : recent + (l.held.length > 3 ? ` and ${l.held.length - 3} earlier` : "") + ` · ${l.questions} questions`;
    const inner = [el("span", { class: "lt", text: l.title }), el("span", { class: "lm", text: meta })];
    if (l.state === "future") return el("li", { class: "lcard future" }, ...inner);
    return el("li", {}, el("a", { class: "lcard " + l.state, href: "#/lec/" + encodeURIComponent(l.id) }, ...inner,
      l.state === "active" ? el("span", { class: "badge", text: "Now" }) : null));
  };
  const parts = [   // (replaceChildren would print a null as the text "null", so filter them out)
    active.length ? el("section", {}, el("h2", { text: "Today" }), el("ul", { class: "llist" }, active.map(card))) : null,
    !active.length && !past.length && !future.length
      ? el("p", { class: "muted", text: "No lectures yet. They will appear here once the course starts using this page." }) : null,
    past.length ? el("section", {}, el("h2", { text: "Past lectures (practice)" }), el("ul", { class: "llist" }, past.map(card))) : null,
    future.length ? el("section", {}, el("h2", { text: "Coming up" }), el("ul", { class: "llist" }, future.map(card))) : null,
  ];
  $("view").replaceChildren(...parts.filter(Boolean));
}

/* ------------------------------------------------------------------ opening a lecture */

async function openLecture(bundleId) {
  const r = await api("GET", "/api/lectures");
  const l = r.lectures.find((x) => x.id === bundleId);
  if (!l || l.state === "future") { location.hash = "#/"; return; }
  if (l.state === "past") {
    const b = await api("GET", "/api/bundle?id=" + encodeURIComponent(bundleId));
    const key = `lec:prog:${bundleId}:practice`;
    const saved = store.get(key, { answers: {}, status: {} });
    state.lec = { active: false, bundle: bundleId, title: l.title, content: b.content, answers: saved.answers, status: saved.status, key };
    return renderLecture();
  }
  const joinKey = "lec:join:" + bundleId;
  const remembered = store.get(joinKey);
  if (remembered && remembered.session === l.active.session) {
    try { return await enterActive(bundleId, remembered.password, joinKey); } catch (e) { /* fall through to the password form */ }
  }
  showPasswordForm(l, joinKey);
}

function showPasswordForm(l, joinKey, message) {
  setBar();
  const input = el("input", { type: "text", autocomplete: "off", autocapitalize: "none", spellcheck: "false", placeholder: "lecture password" });
  const go = async () => {
    btn.disabled = true;
    try { await enterActive(l.id, input.value, joinKey); }
    catch (e) { btn.disabled = false; err.textContent = e.message; }
  };
  const btn = el("button", { class: "primary", text: "Join", onclick: go });
  const err = el("p", { class: "err", text: message || "" });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  $("view").replaceChildren(el("section", { class: "card center" },
    el("h1", { text: `Lec ${l.active.lec_no}: ${l.title}` }),
    el("p", { text: "Enter the password announced in class." }),
    el("div", { class: "row" }, input, btn), err));
  input.focus();
}

async function enterActive(bundleId, password, joinKey) {
  const r = await api("POST", "/api/join", { bundle: bundleId, password });
  store.set(joinKey, { session: r.session, password });
  const key = `lec:prog:${bundleId}:s${r.session}`;
  const saved = store.get(key, { answers: {} });
  state.me.on_roster = r.on_roster;
  state.lec = { active: true, bundle: bundleId, session: r.session, lec_no: r.lec_no, title: r.title, date: r.date, day: r.day,
    content: r.content, answers: saved.answers, status: r.results || {}, key };
  await renderLecture();
}

function saveProgress() {
  const lec = state.lec;
  store.set(lec.key, lec.active ? { answers: lec.answers } : { answers: lec.answers, status: lec.status });
}

function applyServerResults(r) {
  if (!state.lec || !r.results) return;
  state.lec.status = r.results;
  setBar();
}

/* ------------------------------------------------------------------ the lecture page */

async function renderLecture() {
  const lec = state.lec;
  if (state.me.instructor && !lec.full) {       // answer keys and solutions, for "Show answer" (instructor only)
    try { lec.full = (await api("GET", "/api/admin/bundle?id=" + encodeURIComponent(lec.bundle))).content; } catch (e) { lec.full = null; }
  }
  setBar();
  const view = $("view");
  view.replaceChildren();
  let qn = 0;
  for (const it of lec.content.items || []) {
    if (it.kind === "text") view.append(el("section", { class: "teach", html: it.html }));
    else if (it.kind === "question") view.append(questionCard(it, ++qn));
  }
  view.append(el("p", { class: "muted endnote", text: lec.active
    ? "Your answers are recorded for this lecture. Keep going at your own pace."
    : "This is a past lecture: practise freely; nothing is recorded." }));
  window.scrollTo(0, 0);
}

const TYPE_LABEL = { mcq: "Choose one", short: "Short answer", predict: "What does it print?", order: "Put in order", code: "Code" };

function questionCard(q, n) {
  const lec = state.lec;
  const badge = el("span", { class: "qbadge" });
  const feedback = el("div", { class: "feedback", "aria-live": "polite" });
  const showStatus = () => {
    const s = lec.status[q.qid];
    badge.className = "qbadge " + (s ? (s.correct ? "right" : "wrong") : "");
    badge.textContent = s ? (s.correct ? "✓ solved" : "✗ try again") : "";
  };
  showStatus();
  const card = el("section", { class: "qcard", id: "q-" + q.qid },
    el("div", { class: "qhead" }, el("span", { class: "qno", text: `Q${n}` }), el("span", { class: "qtype", text: TYPE_LABEL[q.type] || q.type }), badge),
    el("div", { class: "qtext", html: q.html || "" }));

  const report = async (answerOrCorrect, isCode, checkBtn) => {
    checkBtn.disabled = true;
    try {
      let correct;
      if (!lec.active) {
        correct = isCode ? answerOrCorrect : gradeLocal(q, answerOrCorrect);
        const prev = lec.status[q.qid] || { attempts: 0, correct: false };
        lec.status[q.qid] = { attempts: prev.attempts + 1, correct: prev.correct || correct };
        saveProgress();
      } else if (isCode) {
        correct = answerOrCorrect;
        const item = { session: lec.session, qid: q.qid, correct };
        try { applyServerResults(await api("POST", "/api/check", item)); }
        catch (e) {
          if (e.status !== 0) throw e;
          queueResult(item);
          const prev = lec.status[q.qid] || { attempts: 0, correct: false };
          lec.status[q.qid] = { attempts: prev.attempts + 1, correct: prev.correct || correct };
          feedback.append(el("p", { class: "muted", text: "No connection: your result is saved and will be sent automatically." }));
        }
      } else {
        const r = await api("POST", "/api/answer", { session: lec.session, qid: q.qid, answer: answerOrCorrect });
        correct = r.correct;
        applyServerResults(r);
      }
      showStatus();
      setBar();
      return correct;
    } finally { checkBtn.disabled = false; }
  };
  const verdict = (ok) => el("p", { class: ok ? "ok" : "bad", text: ok ? "Correct! Well done." : "Not quite. Have another look and try again." });
  const fail = (e) => feedback.replaceChildren(el("p", { class: "bad", text: e.message }));

  if (q.type === "mcq") {
    const name = "mcq-" + q.qid;
    const opts = (q.options || []).map((o, i) => el("label", { class: "opt" },
      el("input", { type: "radio", name, value: String(i), checked: String(lec.answers[q.qid]) === String(i),
        onchange: () => { lec.answers[q.qid] = i; saveProgress(); } }),
      el("span", { html: o })));
    const btn = el("button", { class: "primary", text: "Check" });
    btn.onclick = async () => {
      if (lec.answers[q.qid] === undefined) return feedback.replaceChildren(el("p", { class: "bad", text: "Choose an answer first." }));
      try { feedback.replaceChildren(verdict(await report(lec.answers[q.qid], false, btn))); } catch (e) { fail(e); }
    };
    card.append(el("div", { class: "opts" }, opts), el("div", { class: "actions" }, btn), feedback);
  } else if (q.type === "short" || q.type === "predict") {
    if (q.type === "predict" && q.code) card.append(el("pre", { class: "code", text: q.code }));
    const input = q.type === "predict"
      ? el("textarea", { rows: String(Math.max(2, (q.lines_hint || 2))), spellcheck: "false", autocapitalize: "none", placeholder: "Type the exact output" })
      : el("input", { type: "text", spellcheck: "false", autocapitalize: "none", placeholder: "Your answer" });
    input.value = lec.answers[q.qid] || "";
    input.addEventListener("input", () => { lec.answers[q.qid] = input.value; saveProgress(); });
    const btn = el("button", { class: "primary", text: "Check" });
    btn.onclick = async () => {
      if (!input.value.trim()) return feedback.replaceChildren(el("p", { class: "bad", text: "Type an answer first." }));
      try { feedback.replaceChildren(verdict(await report(input.value, false, btn))); } catch (e) { fail(e); }
    };
    card.append(el("div", { class: "answer" }, input), el("div", { class: "actions" }, btn), feedback);
  } else if (q.type === "order") {
    const lines = q.lines || [];
    let order = Array.isArray(lec.answers[q.qid]) ? lec.answers[q.qid] : lines.map((_, i) => i);
    const list = el("ol", { class: "order" });
    const draw = () => {
      list.replaceChildren(...order.map((idx, pos) => el("li", {},
        el("code", { text: lines[idx] }),
        el("span", { class: "mv" },
          el("button", { class: "small", "aria-label": "move up", text: "↑", disabled: pos === 0, onclick: () => move(pos, -1) }),
          el("button", { class: "small", "aria-label": "move down", text: "↓", disabled: pos === order.length - 1, onclick: () => move(pos, 1) })))));
    };
    const move = (pos, d) => {
      order = order.slice();
      [order[pos], order[pos + d]] = [order[pos + d], order[pos]];
      lec.answers[q.qid] = order; saveProgress(); draw();
    };
    draw();
    const btn = el("button", { class: "primary", text: "Check" });
    btn.onclick = async () => { try { feedback.replaceChildren(verdict(await report(order, false, btn))); } catch (e) { fail(e); } };
    card.append(list, el("div", { class: "actions" }, btn), feedback);
  } else if (q.type === "code") {
    card.append(codeArea(q, feedback, report, showStatus));
    card.append(feedback);
  }
  if (lec.full) card.append(answerBox(q, card));
  return card;
}

/* ------------------------------------------------------------------ instructor: show the answer */

function answerBox(q, card) {
  const full = questions(state.lec.full).find((x) => x.qid === q.qid) || {};
  let shown;
  if (q.type === "mcq") shown = el("p", { html: "Answer: " + (full.options || [])[full.answer] });
  else if (q.type === "short") shown = el("p", { text: "Accepted: " + [].concat(full.answer).join("  /  ") });
  else if (q.type === "predict") shown = el("pre", { class: "code", text: full.answer });
  else if (q.type === "order") shown = el("pre", { class: "code", text: (full.answer || []).map((i) => (full.lines || [])[i]).join("\n") });
  else shown = el("div", {}, el("pre", { class: "code", text: full.solution || "(no solution in the bundle)" }),
    full.solution ? el("button", { class: "small", text: "Put it in the editor", onclick: () => {
      const cmEl = card.querySelector(".CodeMirror"); if (cmEl) cmEl.CodeMirror.setValue(full.solution);
    } }) : null);
  const box = el("div", { class: "answerbox", hidden: true }, shown);
  const btn = el("button", { class: "small reveal", text: "Show answer", onclick: () => {
    box.hidden = !box.hidden; btn.textContent = box.hidden ? "Show answer" : "Hide answer";
  } });
  return el("div", { class: "instr" }, btn, box);
}

/* ------------------------------------------------------------------ code questions */

const KEYS = [["Tab", "    "], [":", ":"], ["(", "("], [")", ")"], ["[", "["], ["]", "]"], ['"', '"'], ["'", "'"], ["=", "="], ["#", "# "]];

function codeArea(q, feedback, report) {
  const lec = state.lec;
  const holder = el("div", { class: "editor" });
  const wrap = el("div", { class: "codearea" }, holder);
  const cm = CodeMirror(holder, {
    value: lec.answers[q.qid] !== undefined ? lec.answers[q.qid] : (q.preload || ""),
    mode: "python", lineNumbers: true, indentUnit: 4, tabSize: 4, matchBrackets: true, viewportMargin: Infinity,
    extraKeys: { Tab: (c) => c.replaceSelection("    ") },
  });
  cm.on("change", () => { lec.answers[q.qid] = cm.getValue(); saveProgress(); });
  setTimeout(() => cm.refresh(), 0);
  const keys = el("div", { class: "keys" }, KEYS.map(([label, text]) =>
    el("button", { class: "small key", text: label, onclick: () => { cm.replaceSelection(text); cm.focus(); } })));
  const run = async (mode, btn) => {
    btn.disabled = true;
    feedback.replaceChildren(el("p", { class: "muted", text: "Running your code..." }));
    try {
      const r = await runCodeTests(q, cm.getValue(), mode);
      const out = [];
      if (r.syntax) out.push(el("pre", { class: "err", text: r.syntax }));
      else out.push(resultsTable(r));
      if (mode === "all" && !r.syntax) {
        const ok = await report(r.passed, true, btn);
        out.unshift(el("p", { class: ok ? "ok" : "bad", text: ok ? "All tests passed. Well done!" : "Not all tests passed yet. Look at the table, fix your code and try again." }));
      } else if (mode === "all") {
        await report(false, true, btn);
        out.unshift(el("p", { class: "bad", text: "Your code has a syntax error (see below)." }));
      }
      if (r.figures) out.push(el("div", { class: "figs" }, r.figures.map((b) => el("img", { src: "data:image/png;base64," + b, alt: "your drawing" }))));
      feedback.replaceChildren(...out);
    } catch (e) { feedback.replaceChildren(el("p", { class: "bad", text: e.message })); }
    finally { btn.disabled = false; }
  };
  const tryBtn = el("button", { text: "Run examples" });
  tryBtn.onclick = () => run("examples", tryBtn);
  const checkBtn = el("button", { class: "primary", text: "Check" });
  checkBtn.onclick = () => run("all", checkBtn);
  const viz = el("button", { text: "Visualize", title: "Open your code in Python Tutor",
    onclick: () => window.open("https://pythontutor.com/visualize.html#code=" + encodeURIComponent(cm.getValue()) + "&py=3&cumulative=false&curInstr=0", "_blank", "noopener") });
  wrap.append(keys, el("div", { class: "actions" }, tryBtn, checkBtn, viz));
  return wrap;
}

function resultsTable(r) {
  const anyStdin = r.tests.some((t) => t.stdin.trim()), anyCode = r.tests.some((t) => t.code.trim());
  const body = r.tests.map((t) => t.hidden
    ? el("tr", { class: t.passed ? "pass" : "fail" }, el("td", { class: "mark", text: t.passed ? "✓" : "✗" }),
        el("td", { class: "hid", colspan: String(2 + anyCode + anyStdin), text: `Hidden test ${t.n}: ${t.passed ? "passed" : "failed"}` }))
    : el("tr", { class: t.passed ? "pass" : "fail" }, el("td", { class: "mark", text: t.passed ? "✓" : "✗" }),
        anyCode ? el("td", {}, el("pre", { text: t.code })) : null, anyStdin ? el("td", {}, el("pre", { text: t.stdin })) : null,
        el("td", {}, el("pre", { text: t.expected })), el("td", {}, el("pre", { text: t.got }))));
  return el("div", { class: "tablewrap" }, el("table", { class: "io" },
    el("thead", {}, el("tr", {}, el("th"), anyCode ? el("th", { text: "Test" }) : null, anyStdin ? el("th", { text: "Input" }) : null,
      el("th", { text: "Expected" }), el("th", { text: "Got" }))),
    el("tbody", {}, body)));
}

/* ------------------------------------------------------------------ routing */

async function route() {
  if (!store.get(KEY.token)) return showSignIn();
  try {
    if (!state.me) state.me = await api("GET", "/api/me");
    const m = location.hash.match(/^#\/lec\/(.+)$/);
    if (location.hash.startsWith("#/instructor") && state.me.instructor && window.Instructor) await window.Instructor.route();
    else if (m) await openLecture(decodeURIComponent(m[1]));
    else await showList();
  } catch (e) {
    if (e.status === 401) return showSignIn("Please sign in again.");
    $("view").replaceChildren(el("section", { class: "card center" }, el("p", { class: "err", text: e.message }),
      el("button", { text: "Try again", onclick: route })));
  }
}
window.addEventListener("hashchange", route);
route();
flushOutbox();
