"use strict";
/* lecture.js - student page of the CS101 lecture system (see docs/lecture_support_system.md).

   Sign in with Google (iitgoa.ac.in), list the lectures (today's / past / future), join today's
   lecture with its password, answer the questions one per page. In the live lecture the instructor opens
   the questions one by one (the page polls for them) and finally opens Final submit; a lecture may cover
   more than one topic (bundle). Every question is checked here, in the browser
   (code runs in Pyodide); the answer keys come with the questions. Each Check of a changed answer is a
   try, and as in the labs every try after the first failed one costs a penalty (default "10, 20, ...").
   In the live lecture each Check is reported to the backend in the background (tries, solved or not);
   reports that cannot be sent are kept and re-sent. PAST lectures are practice: nothing is reported.

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
const DEFAULT_PENALTY = "10, 20, ...";              // same default as the backend
const KEY = { token: "lec:token", outbox: "lec:outbox", join: "lec:join" };

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
const fmt1 = (x) => (Math.round(x * 10) / 10).toFixed(1);

/* ------------------------------------------------------------------ backend */

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const RETRY = /^\/api\/(join|report|lectures|bundle|me|state|submit)\b/;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Retries (up to 2 more times) when the network or the server hiccups: reports are safe to resend.
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

/* Reports of Checks in the active lecture: queued, sent in the background, re-sent after network
   trouble. Only the latest report per question is kept (the server keeps the maximum of the tries). */
const sameReport = (a, b) => a.session === b.session && (a.bundle || "") === (b.bundle || "") && a.qid === b.qid;
function queueReport(item) {
  const box = store.get(KEY.outbox, []).filter((x) => !(sameReport(x, item)));
  box.push(item);
  store.set(KEY.outbox, box);
  flushOutbox();
}
let flushing = false;
async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  try {
    for (const item of store.get(KEY.outbox, [])) {
      let keep = false;
      try { await api("POST", "/api/report", item); }
      catch (e) { keep = e.status === 0 || e.status >= 500; }      // a closed lecture (409) is dropped
      const box = store.get(KEY.outbox, []);
      const i = box.findIndex((x) => sameReport(x, item));
      if (i >= 0 && !keep && box[i].tries === item.tries && box[i].correct === item.correct) { box.splice(i, 1); store.set(KEY.outbox, box); }
      if (keep) break;                                                   // still offline: try again later
    }
  } finally { flushing = false; }
  showPending();
}
setInterval(flushOutbox, 15000);
function showPending() {
  const n = store.get(KEY.outbox, []).filter((x) => state.lec && x.session === state.lec.session).length;
  const p = $("bar-pending");
  if (p) { p.hidden = !n; p.textContent = n ? `${n} result${n > 1 ? "s" : ""} waiting to be sent` : ""; }
}

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

// Runs the tests of a code question; mode "examples" (Pre-check) runs only the visible ones.
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

/* ------------------------------------------------------------------ grading and penalty (in the browser) */

const squash = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
function grade(q, answer) {
  switch (q.type) {
    case "mcq": return Number(answer) === Number(q.answer);
    case "short": return (Array.isArray(q.answer) ? q.answer : [q.answer]).some((a) => squash(a) === squash(answer));
    case "predict": return normalise(answer) === normalise(q.answer);
    case "order": return JSON.stringify((answer || []).map(Number)) === JSON.stringify(q.answer.map(Number));
    default: return false;
  }
}

function parsePenalty(text) {                       // same as common.parse_penalty_regime
  let t = String(text ?? DEFAULT_PENALTY).trim();
  const extend = t.endsWith("...");
  if (extend) t = t.slice(0, -3).trim().replace(/,$/, "");
  const steps = t ? t.replace(/%/g, "").split(",").filter((x) => x.trim()).map(Number) : [];
  return steps.some((x) => x > 0) ? { steps, extend } : { steps: [], extend: false };
}
function penaltyPct(regime, failedBefore) {         // same as common.penalty_pct
  const st = regime.steps;
  if (failedBefore <= 0 || !st.length) return 0;
  const i = failedBefore - 1;
  let p;
  if (i < st.length) p = st[i];
  else if (regime.extend) p = st[st.length - 1] + (i - st.length + 1) * (st.length > 1 ? st[st.length - 1] - st[st.length - 2] : st[0]);
  else p = st[st.length - 1];
  return Math.min(Math.max(p, 0), 100);
}


/* ------------------------------------------------------------------ state and top bar */

const state = { me: null, lec: null, gen: 0 };   // lec: the open lecture; gen: bumped on every page change
const fresh = (g) => g === state.gen;            // false once the user has moved to another page

const questions = (content) => (content.items || []).filter((it) => it.kind === "question");
const fullTitle = (x) => (x.number ? x.number + " " : "") + x.title;
const isInstr = () => !!(state.me && state.me.instructor);

/* The open lecture page:
     lec = { mode: "live" | "practice" | "preview", session, lec_no, day, date, title, password,
             parts: [{ id, number, title, content, regime, full }],   one per bundle (live: one or more)
             qs: [{ uid, part, bundle, qid, no, q, pre, post }],       every question, in order, with the
                                                                      teaching text before (and after the last) it
             open: Set of uids students may open (live: opened by the instructor; else all),
             submitOpen, submittedAt, closed, cur (uid shown), answers and status (by uid), key }
   A question is identified by "<bundle>/<qid>" (question ids repeat across bundles). */

function buildQuestions(parts) {
  const qs = [];
  parts.forEach((p, pi) => {
    let texts = [], seq = 0, last = null;
    for (const it of p.content.items || []) {
      if (it.kind !== "question") { texts.push(it); continue; }
      seq++;
      last = { uid: p.id + "/" + it.qid, part: pi, bundle: p.id, qid: it.qid, no: it.no || seq, q: it, pre: texts, post: [] };
      qs.push(last);
      texts = [];
    }
    if (last) last.post = texts;
  });
  return qs;
}

const entry = (uid) => state.lec.qs.find((e) => e.uid === uid);
const label = (e) => (state.lec.parts.length > 1 && state.lec.parts[e.part].number ? state.lec.parts[e.part].number + " " : "") + "Q" + e.no;
const openable = (e) => state.lec.mode !== "live" || state.lec.open.has(e.uid) || isInstr();
const counted = (lec) => lec.qs.filter((e) => lec.mode !== "live" || lec.open.has(e.uid));
const locked = (lec) => lec.mode === "live" && !isInstr() && !!(lec.submittedAt || lec.closed);

function lecScore(lec) {
  const qs = counted(lec);
  const sum = qs.reduce((a, e) => a + ((lec.status[e.uid] || {}).correct ? (lec.status[e.uid].score ?? 1) : 0), 0);
  return { score: sum, solved: qs.filter((e) => (lec.status[e.uid] || {}).correct).length, n: qs.length };
}

function setBar() {
  const me = state.me, lec = state.lec;
  $("bar-user").hidden = !me;
  if (me) $("bar-email").textContent = me.email;
  $("bar-instructor").hidden = !(me && me.instructor);
  $("bar-marks").hidden = !(me && me.on_roster);
  $("bar-guest").hidden = !(me && !me.instructor && !me.on_roster);
  $("bar-lec").hidden = !lec;
  $("bar-score").hidden = !lec;
  if (lec) {
    const live = lec.mode === "live";
    $("bar-title").textContent = live ? `Lec ${lec.lec_no} · ${lec.title}` : fullTitle(lec.parts[0]);
    $("bar-date").textContent = live ? `${lec.day} ${lec.date}` : lec.mode === "preview" ? "Preview (not recorded)" : "Practice (not recorded)";
    const s = lecScore(lec);
    $("bar-score").textContent = `${fmt(s.score)} / ${s.n}`;
    $("bar-score").title = `${s.solved} of ${s.n} questions solved (penalties applied)`;
  }
  showPending();
}
// The top bar's height (it wraps on phones), for the sticky question nav below it.
const barHeight = () => document.documentElement.style.setProperty("--barh", document.querySelector(".lbar").offsetHeight + "px");
if ("ResizeObserver" in window) new ResizeObserver(barHeight).observe(document.querySelector(".lbar"));
barHeight();
$("btn-signout").addEventListener("click", () => {
  store.del(KEY.token);
  try { if (window.google) google.accounts.id.disableAutoSelect(); } catch (e) { /* ignore */ }
  state.me = null; state.lec = null;
  location.hash = "#/";
  route();
});

function modal(...content) {
  const box = el("div", { class: "modal-back" }, el("div", { class: "modal", role: "dialog", "aria-modal": "true" }, ...content));
  document.body.append(box);
  return () => box.remove();
}

// Accounts that are not on the roster see this once (per browser) after signing in.
function guestNotice() {
  const me = state.me;
  if (!me || me.instructor || me.on_roster) return;
  const k = "lec:guestnote:" + me.email;
  if (store.get(k)) return;
  const close = modal(
    el("p", { text: "Your login account is not among the registered students for CS101. Please contact the instructor." }),
    el("p", { class: "muted", text: "You can still follow the lectures and solve the questions, but your attendance is not recorded." }),
    el("div", { class: "actions" }, el("button", { class: "primary", text: "OK", onclick: () => { store.set(k, true); close(); } })));
}

/* ------------------------------------------------------------------ sign-in */

function showSignIn(message) {
  state.me = null; state.lec = null; setBar();
  const box = el("div", { class: "gsi" });
  const view = $("view");
  view.className = "view";
  view.replaceChildren(el("section", { class: "card center" },
    el("h1", { text: "CS101 Lectures" }),
    el("p", { text: "Sign in with your iitgoa.ac.in Google account to follow today's lecture and practice with past ones." }),
    el("p", { class: "muted", text: "Use your institute account (name@iitgoa.ac.in), not a personal Gmail account." }),
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
    google.accounts.id.initialize({ client_id: CFG.clientId, callback: onGoogle, ux_mode: "popup", hd: "iitgoa.ac.in" });
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
  const g = state.gen;
  state.lec = null;
  const r = await api("GET", "/api/lectures");
  if (!fresh(g)) return;
  setBar();
  $("view").className = "view";
  const lecs = r.lectures;
  const past = lecs.filter((l) => l.state === "past");            // in topic order, like the others
  const future = lecs.filter((l) => l.state === "future");
  const card = (l) => {
    const recent = l.held.slice(-3).reverse().map((h) => `Lec ${h.lec_no} (${h.day} ${h.date})`).join(", ");
    const nq = l.practice_questions < l.questions ? `${l.practice_questions} of ${l.questions} questions so far` : `${l.questions} questions`;
    const meta = l.state === "future" ? "coming up"
      : (recent ? recent + (l.held.length > 3 ? ` and ${l.held.length - 3} earlier` : "") + " · " : "") + nq;
    const inner = [el("span", { class: "lt" }, l.number ? el("span", { class: "lnum", text: l.number }) : null, l.title),
      el("span", { class: "lm", text: meta })];
    if (l.state === "future") return el("li", { class: "lcard future" }, ...inner);
    return el("li", {}, el("a", { class: "lcard " + l.state, href: "#/lec/" + encodeURIComponent(l.id) }, ...inner));
  };
  const now = r.now ? el("li", {}, el("a", { class: "lcard active", href: "#/now" },
    el("span", { class: "lt", text: `Lec ${r.now.lec_no}: ${r.now.title}` }),
    el("span", { class: "lm", text: `${r.now.day} ${r.now.date} · now` }), el("span", { class: "badge", text: "Now" }))) : null;
  const parts = [   // (replaceChildren would print a null as the text "null", so filter them out)
    el("header", { class: "welcome" }, el("h1", { text: r.course || "CS101" }),
      el("p", { text: "Welcome to the class!" }),
      state.me.on_roster ? el("a", { class: "btn", href: "#/marks", text: "My marks and attendance" }) : null),
    now ? el("section", {}, el("h2", { text: "Today" }), el("ul", { class: "llist" }, now)) : null,
    !now && !past.length && !future.length
      ? el("p", { class: "muted", text: "No lectures yet. They will appear here once the course starts using this page." }) : null,
    past.length ? el("section", {}, el("h2", { text: "Past lectures (practice)" }), el("ul", { class: "llist" }, past.map(card))) : null,
    future.length ? el("section", {}, el("h2", { text: "Coming up" }), el("ul", { class: "llist" }, future.map(card))) : null,
  ];
  $("view").replaceChildren(...parts.filter(Boolean));
}

/* ------------------------------------------------------------------ opening a lecture */

// A past lecture (practice): only the questions already taught; graded here, nothing is sent.
async function openPractice(bundleId) {
  const g = state.gen;
  const r = await api("GET", "/api/lectures");
  if (!fresh(g)) return;
  const l = r.lectures.find((x) => x.id === bundleId);
  if (l && l.state === "active") { location.hash = "#/now"; return; }
  if (!l || l.state === "future") { location.hash = "#/"; return; }
  const b = await api("GET", "/api/bundle?id=" + encodeURIComponent(bundleId));
  if (!fresh(g)) return;
  const key = `lec:prog:${bundleId}:practice`;
  const saved = store.get(key, { answers: {}, status: {} });
  const byUid = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k.includes("/") ? k : bundleId + "/" + k, v]));  // (saved before 2026-10-10: by qid)
  const parts = [{ id: bundleId, number: l.number, title: l.title, content: b.content }];
  state.lec = { mode: "practice", parts, answers: byUid(saved.answers), status: byUid(saved.status), cur: saved.cur, key };
  await renderLecture(g);
}

// Today's lecture: the password once (remembered on this phone), then the live page.
async function openNow() {
  const g = state.gen;
  const r = await api("GET", "/api/lectures");
  if (!fresh(g)) return;
  if (!r.now) {
    setBar();
    $("view").className = "view";
    $("view").replaceChildren(el("section", { class: "card center" }, el("p", { text: "No lecture is running now." }),
      el("a", { class: "btn", href: "#/", text: "All lectures" })));
    return;
  }
  const remembered = store.get(KEY.join);
  if (remembered && remembered.session === r.now.session) {
    try { return await enterLive(remembered.password, g); } catch (e) { /* fall through to the password form */ }
  }
  if (!fresh(g)) return;
  showPasswordForm(r.now, g);
}

function showPasswordForm(now, g) {
  setBar();
  $("view").className = "view";
  const input = el("input", { type: "text", autocomplete: "off", autocapitalize: "none", spellcheck: "false", placeholder: "lecture password" });
  const go = async () => {
    btn.disabled = true;
    try { await enterLive(input.value, g); }
    catch (e) { btn.disabled = false; err.textContent = e.message; }
  };
  const btn = el("button", { class: "primary", text: "Join", onclick: go });
  const err = el("p", { class: "err", text: "" });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  $("view").replaceChildren(el("section", { class: "card center" },
    el("h1", { text: `Lec ${now.lec_no}: ${now.title}` }),
    el("p", { text: "Enter the password announced in class." }),
    el("div", { class: "row" }, input, btn), err));
  input.focus();
}

async function enterLive(password, g) {
  const r = await api("POST", "/api/join", { password });
  if (!fresh(g)) return;
  store.set(KEY.join, { session: r.session, password });
  const key = `lec:prog:s${r.session}`;
  const saved = store.get(key, { answers: {}, status: {} });
  // the server's record and this browser's are merged (a student may switch phones mid-lecture)
  const status = { ...(saved.status || {}) };
  for (const [uid, s] of Object.entries(r.results || {})) {
    const mine = status[uid] || { tries: 0, correct: false };
    if (s.correct && !mine.correct) status[uid] = { ...mine, tries: s.tries, correct: true, score: s.score };
    else if (!mine.correct && s.tries > mine.tries) status[uid] = { ...mine, tries: s.tries };
  }
  state.me.on_roster = r.on_roster;
  const old = state.lec && state.lec.mode === "live" && state.lec.session === r.session ? state.lec : null;
  state.lec = { mode: "live", session: r.session, lec_no: r.lec_no, title: r.title, date: r.date, day: r.day, password,
    parts: r.parts.map((p) => ({ id: p.id, number: p.number, title: p.title, content: p.content, full: old ? (old.parts.find((x) => x.id === p.id) || {}).full : undefined })),
    open: new Set(r.opened), submitOpen: r.submit_open, submittedAt: r.submitted_at,
    answers: saved.answers || {}, status, cur: old ? old.cur : saved.cur, key };
  saveProgress();
  await renderLecture(g);
  startPolling();
}

function saveProgress() {
  const lec = state.lec;
  if (lec) store.set(lec.key, { answers: lec.answers, status: lec.status, cur: lec.cur });
}

/* ------------------------------------------------------------------ polling the live lecture */

const POLL_MS = 10000;            // 160 phones every 10 s stays well inside the backend's free quota
let pollTimer = null;
const stopPolling = () => { clearInterval(pollTimer); pollTimer = null; };
const startPolling = () => { stopPolling(); pollTimer = setInterval(poll, POLL_MS); };
document.addEventListener("visibilitychange", () => { if (!document.hidden && pollTimer) poll(); });

async function poll() {
  const lec = state.lec;
  if (!lec || lec.mode !== "live" || document.hidden) return;
  let r;
  try { r = await api("GET", "/api/state?session=" + lec.session); }
  catch (e) { if (e.status !== 404) return; r = { active: false }; }      // 404: the lecture was deleted
  if (state.lec !== lec) return;
  if (!r.active) {
    lec.closed = true;
    stopPolling();
    return redraw();
  }
  if (r.bundles.join("|") !== lec.parts.map((p) => p.id).join("|")) {      // a topic was added: load it
    try { await enterLive(lec.password, state.gen); } catch (e) { /* next poll */ }
    return;
  }
  const newly = r.opened.filter((u) => !lec.open.has(u));
  lec.open = new Set(r.opened);
  lec.submitOpen = r.submit_open;
  if (r.submitted_at) lec.submittedAt = r.submitted_at;
  redraw();
  if (newly.length && !isInstr()) announce(newly[newly.length - 1]);
}

// A newly opened question: shown at once if the student is waiting, else a small notice with Go.
function announce(uid) {
  const lec = state.lec;
  const e = entry(uid);
  if (!e || locked(lec)) return;
  if (!lec.cur || !openable(entry(lec.cur) || {})) return showPage(uid);
  const old = document.querySelector(".toast");
  if (old) old.remove();
  const t = el("div", { class: "toast", role: "status" }, el("span", { text: `${label(e)} is open now.` }),
    el("button", { class: "small primary", text: "Go", onclick: () => { t.remove(); showPage(uid); } }),
    el("button", { class: "small", "aria-label": "dismiss", text: "✕", onclick: () => t.remove() }));
  document.body.append(t);
  setTimeout(() => t.remove(), 20000);
}

/* ------------------------------------------------------------------ the lecture page: one question per page */

async function renderLecture(g) {
  const lec = state.lec;
  if (isInstr()) {             // answer keys and solutions, for "Show answer" (instructor only)
    for (const p of lec.parts) {
      if (p.full === undefined) {
        try { p.full = (await api("GET", "/api/admin/bundle?id=" + encodeURIComponent(p.id))).content; } catch (e) { p.full = null; }
      }
    }
    if (!fresh(g)) return;
  }
  for (const p of lec.parts) p.regime = parsePenalty(p.content.penalty);
  lec.qs = buildQuestions(lec.parts);
  if (lec.mode !== "live") lec.open = new Set(lec.qs.map((e) => e.uid));
  lec.cards = {};
  setBar();
  const view = $("view");
  view.className = "view lecview";
  const nav = el("nav", { class: "lqnav", "aria-label": "Questions" });
  lec.navItems = {};
  nav.append(el("div", { class: "lqnav-head", text: "Questions" }));
  lec.parts.forEach((p, pi) => {
    if (lec.parts.length > 1) nav.append(el("div", { class: "lqnav-part", text: p.number || p.title }));
    for (const e of lec.qs.filter((x) => x.part === pi)) {
      const item = el("button", { class: "qn", text: String(e.no), onclick: () => showPage(e.uid) });
      lec.navItems[e.uid] = item;
      nav.append(item);
    }
  });
  nav.append(el("div", { class: "lqnav-key" },
    el("span", {}, el("i", { class: "k solved" }), "solved"), el("span", {}, el("i", { class: "k penalty" }), "solved with penalty"),
    el("span", {}, el("i", { class: "k wrong" }), "not yet right"), el("span", {}, el("i", { class: "k none" }), "not tried"),
    lec.mode === "live" ? el("span", {}, el("i", { class: "k off" }), "not open yet") : null));
  const one = lec.parts.length === 1 ? lec.parts[0] : null;
  const head = el("header", { class: "lhead" },
    lec.mode === "live" ? el("div", { class: "lh-num", text: `Lec ${lec.lec_no} · ${lec.day} ${lec.date}` })
      : one && one.number ? el("div", { class: "lh-num", text: "Topic " + one.number }) : null,
    el("h1", { text: one ? one.title : lec.title }),
    one && one.content.description ? el("div", { class: "lh-desc", html: one.content.description }) : null);
  lec.banner = el("div", { class: "lbanner" });
  lec.page = el("div", { class: "lpage" });
  lec.prev = el("button", { text: "← Previous", onclick: () => step(-1) });
  lec.next = el("button", { text: "Next →", onclick: () => step(1) });
  lec.submitBtn = el("button", { class: "submit", onclick: openSummary });
  const main = el("div", { class: "lecmain" }, head, lec.banner, lec.page, el("div", { class: "pager" }, lec.prev, lec.next, lec.submitBtn));
  lec.main = main;
  view.replaceChildren(el("div", { class: "lecgrid" }, nav, main));
  const start = lec.cur && entry(lec.cur) && openable(entry(lec.cur)) ? lec.cur : (lec.qs.find(openable) || {}).uid;
  if (start) showPage(start, true); else { lec.cur = null; redraw(); }
}

// Shows one question (with its teaching text) on the page.
function showPage(uid, quiet) {
  const lec = state.lec;
  const e = entry(uid);
  if (!e || !openable(e)) return;
  lec.cur = uid;
  saveProgress();
  if (!lec.cards[uid]) lec.cards[uid] = questionCard(e);
  lec.page.replaceChildren(...e.pre.map((t) => el("section", { class: "teach", html: t.html })), lec.cards[uid],
    ...e.post.map((t) => el("section", { class: "teach", html: t.html })));
  lec.page.querySelectorAll(".CodeMirror").forEach((c) => c.CodeMirror.refresh());
  const toast = document.querySelector(".toast");
  if (toast && toast.textContent.startsWith(label(e) + " ")) toast.remove();
  redraw();
  if (!quiet) window.scrollTo({ top: 0, behavior: "smooth" });
  const item = lec.navItems[uid];
  if (item && item.scrollIntoView && window.matchMedia("(max-width: 800px)").matches) item.scrollIntoView({ block: "nearest", inline: "center" });
}

function step(d) {
  const lec = state.lec;
  const list = lec.qs.filter(openable);
  const i = list.findIndex((e) => e.uid === lec.cur);
  const to = list[i + d];
  if (to) showPage(to.uid);
}

// Updates the nav, the pager, the banner and the Submit button after any change.
function redraw() {
  const lec = state.lec;
  if (!lec || !lec.main) return;
  for (const e of lec.qs) refreshQuestion(e.uid);
  const list = lec.qs.filter(openable);
  const i = list.findIndex((e) => e.uid === lec.cur);
  lec.prev.disabled = i <= 0;
  lec.next.disabled = i < 0 || i >= list.length - 1;
  lec.main.classList.toggle("locked", locked(lec));
  // Submit: practice and preview show the summary any time; live: Final submit once the instructor opens it
  const b = lec.submitBtn;
  if (lec.mode !== "live") { b.textContent = "Submit"; b.disabled = false; b.className = "submit"; b.title = "See a summary (practice: nothing is recorded)"; }
  else if (isInstr()) { b.hidden = true; }
  else {
    b.textContent = lec.submittedAt ? "Submitted ✓" : "Final submit";
    b.disabled = !!lec.submittedAt || lec.closed || !lec.submitOpen;
    b.className = "submit" + (lec.submitOpen && !lec.submittedAt && !lec.closed ? " primary" : "");
    b.title = lec.submittedAt ? "You have submitted this lecture." : lec.submitOpen ? "Submit your answers for this lecture." : "The instructor opens Final submit near the end of the lecture.";
  }
  const msgs = [];
  if (lec.mode === "live" && !isInstr()) {
    if (lec.closed) msgs.push(["info", "This lecture has been closed. Your results are saved; it will appear under past lectures for practice."]);
    else if (lec.submittedAt) msgs.push(["ok", `Submitted at ${new Date(lec.submittedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Your answers for this lecture are recorded. You can still read the questions.`]);
    else if (lec.submitOpen) msgs.push(["warn", "Final submit is open: press Final submit (below) before you leave."]);
  }
  if (!lec.cur && lec.mode === "live") msgs.push(["wait", "Waiting for the instructor to open the first question. Keep this page open: it updates by itself."]);
  lec.banner.replaceChildren(...msgs.map(([cls, text]) => el("p", { class: "banner " + cls, text })));
  setBar();
}

const qState = (s) => (!s || !s.tries ? "none" : !s.correct ? "wrong" : (s.score ?? 1) < 1 ? "penalty" : "solved");
const STATE_TEXT = { none: "not tried", wrong: "not yet right", penalty: "solved with a penalty", solved: "solved" };

// Updates the nav item, the tries chip and the badge of one question.
function refreshQuestion(uid) {
  const lec = state.lec;
  const e = entry(uid);
  const s = lec.status[uid];
  const st = qState(s);
  const item = lec.navItems[uid];
  const isOpen = lec.mode !== "live" || lec.open.has(uid);
  if (item) {
    item.className = "qn " + (isOpen ? st : "off") + (lec.cur === uid ? " current" : "");
    item.disabled = !openable(e);
    item.title = `${label(e)}: ` + (isOpen ? STATE_TEXT[st] : "not open yet");
  }
  const card = lec.cards[uid];
  if (!card) return;
  const chip = card.querySelector(".try-chip");
  const tries = s ? s.tries : 0;
  const regime = lec.parts[e.part].regime;
  if (s && s.correct) {
    const pct = Math.round(100 - 100 * (s.score ?? 1));
    chip.textContent = `Tries: ${tries} · ` + (pct > 0 ? `Penalty: ${pct}%` : "No penalty");
    chip.className = "try-chip solved";
    chip.title = "Solved" + (pct > 0 ? `: this question counts ${100 - pct}%.` : ": full credit.");
  } else {
    const pct = penaltyPct(regime, tries);
    chip.textContent = `Tries: ${tries} · ` + (pct > 0 ? `Penalty: ${pct}%` : "No penalty");
    chip.className = "try-chip" + (pct > 0 ? " warn" : "");
    chip.title = (pct > 0 ? `If your next Check is right, this question counts ${100 - pct}%.` : "Your next Check can earn full credit.")
      + " Each Check of a changed answer is a try" + (e.q.type === "code" ? "; Pre-check is free." : ".");
  }
  const badge = card.querySelector(".qbadge");
  badge.className = "qbadge " + (st === "none" ? "" : st === "wrong" ? "wrong" : "right");
  badge.textContent = st === "none" ? "" : st === "wrong" ? "✗ try again" : "✓ solved";
  const io = card.querySelector(".instr-open");
  if (io) {
    io.querySelector("span").textContent = isOpen ? "Open for students ✓" : "Not open for students yet";
    io.querySelector("button").hidden = isOpen;
  }
}

/* One Check: counts a try unless the question is solved or the answer is the one checked last time.
   Returns { correct, repeat, solvedBefore } (or { locked } after Final submit or Close). */
function recordCheck(e, canonical, correct) {
  const lec = state.lec;
  if (locked(lec)) return { locked: true, correct };
  const prev = lec.status[e.uid] || { tries: 0, correct: false };
  if (prev.correct) return { correct, solvedBefore: true };
  if (prev.last === canonical) return { correct: prev.lastCorrect, repeat: true };
  const tries = prev.tries + 1;
  const score = correct ? 1 - penaltyPct(lec.parts[e.part].regime, tries - 1) / 100 : 0;
  lec.status[e.uid] = { tries, correct, score, last: canonical, lastCorrect: correct };
  saveProgress();
  if (lec.mode === "live") queueReport({ session: lec.session, bundle: e.bundle, qid: e.qid, tries, correct });
  refreshQuestion(e.uid);
  setBar();
  return { correct };
}

function verdictText(r, isCode) {
  if (r.locked) return el("p", { class: "muted", text: "This lecture is submitted or closed: Checks are no longer recorded." });
  if (r.solvedBefore) return el("p", { class: r.correct ? "ok" : "bad", text: r.correct
    ? "Correct. (You had already solved this one; your score for it stays.)"
    : "Not quite, but you had already solved this one; your score for it stays." });
  const base = r.correct ? (isCode ? "All tests passed. Well done!" : "Correct! Well done.")
    : (isCode ? "Not all tests passed yet. Look at the table, fix your code and try again." : "Not quite. Have another look and try again.");
  return el("p", { class: r.correct ? "ok" : "bad", text: base + (r.repeat ? " (Same answer as your last Check: not counted as a new try.)" : "") });
}

const TYPE_LABEL = { mcq: "Choose one", short: "Short answer", predict: "What does it print?", order: "Put in order", code: "Code" };

function questionCard(e) {
  const lec = state.lec;
  const q = e.q, uid = e.uid;
  const feedback = el("div", { class: "feedback", "aria-live": "polite" });
  const card = el("section", { class: "qcard", id: "q-" + uid },
    el("div", { class: "qhead" }, el("span", { class: "qno", text: label(e) }), el("span", { class: "qtype", text: TYPE_LABEL[q.type] || q.type }),
      el("span", { class: "qbadge" }), el("span", { class: "try-chip" })),
    el("div", { class: "qtext", html: q.html || "" }));
  const check = (answer, canonical) => feedback.replaceChildren(verdictText(recordCheck(e, canonical, grade(q, answer)), false));

  if (q.type === "mcq") {
    const name = "mcq-" + uid;
    const opts = (q.options || []).map((o, i) => el("label", { class: "opt" },
      el("input", { type: "radio", name, value: String(i), checked: String(lec.answers[uid]) === String(i),
        onchange: () => { lec.answers[uid] = i; saveProgress(); } }),
      el("span", { html: o })));
    const btn = el("button", { class: "primary", text: "Check", onclick: () => {
      if (lec.answers[uid] === undefined) return feedback.replaceChildren(el("p", { class: "bad", text: "Choose an answer first." }));
      check(lec.answers[uid], String(lec.answers[uid]));
    } });
    card.append(el("div", { class: "opts" }, opts), el("div", { class: "actions" }, btn), feedback);
  } else if (q.type === "short" || q.type === "predict") {
    if (q.type === "predict" && q.code) card.append(el("pre", { class: "code", text: q.code }));
    const input = q.type === "predict"
      ? el("textarea", { rows: String(Math.max(2, (q.lines_hint || 2))), spellcheck: "false", autocapitalize: "none", placeholder: "Type the exact output" })
      : el("input", { type: "text", spellcheck: "false", autocapitalize: "none", placeholder: "Your answer" });
    input.value = lec.answers[uid] || "";
    input.addEventListener("input", () => { lec.answers[uid] = input.value; saveProgress(); });
    if (q.type === "short") input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") btn.click(); });
    const btn = el("button", { class: "primary", text: "Check", onclick: () => {
      if (!input.value.trim()) return feedback.replaceChildren(el("p", { class: "bad", text: "Type an answer first." }));
      check(input.value, q.type === "short" ? squash(input.value) : normalise(input.value));
    } });
    card.append(el("div", { class: "answer" }, input), el("div", { class: "actions" }, btn), feedback);
  } else if (q.type === "order") {
    const lines = q.lines || [];
    let order = Array.isArray(lec.answers[uid]) ? lec.answers[uid] : lines.map((_, i) => i);
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
      lec.answers[uid] = order; saveProgress(); draw();
    };
    draw();
    const btn = el("button", { class: "primary", text: "Check", onclick: () => check(order, JSON.stringify(order)) });
    card.append(list, el("div", { class: "actions" }, btn), feedback);
  } else if (q.type === "code") {
    card.append(codeArea(e, feedback), feedback);
  }
  if (isInstr() && lec.mode === "live") card.prepend(openStrip(e));
  const full = lec.parts[e.part].full;
  if (full) card.append(answerBox(e, full, card));
  return card;
}

/* ------------------------------------------------------------------ Submit: the summary (live: Final submit) */

function summaryTable(lec) {
  const rows = counted(lec).map((e) => {
    const s = lec.status[e.uid];
    const st = qState(s);
    return el("tr", { class: st }, el("td", { text: label(e) }), el("td", { text: STATE_TEXT[st] }),
      el("td", { class: "num", text: s ? String(s.tries) : "0" }), el("td", { class: "num", text: s && s.correct ? fmt(s.score ?? 1) : "0" }));
  });
  const t = lecScore(lec);
  return el("div", { class: "tablewrap" }, el("table", { class: "summary" },
    el("thead", {}, el("tr", {}, ["Question", "Result", "Tries", "Score"].map((h) => el("th", { text: h })))),
    el("tbody", {}, rows),
    el("tfoot", {}, el("tr", {}, el("td", { colspan: "3", text: `Total (${t.solved} of ${t.n} solved)` }), el("td", { class: "num", text: `${fmt(t.score)} / ${t.n}` })))));
}

function openSummary() {
  const lec = state.lec;
  if (lec.mode !== "live") {
    const close = modal(el("h2", { text: "Summary" }), summaryTable(lec),
      el("p", { class: "muted", text: "Practice: nothing is recorded. You can keep working on the questions." }),
      el("div", { class: "actions" }, el("button", { class: "primary", text: "Close", onclick: () => close() })));
    return;
  }
  if (!lec.submitOpen || lec.submittedAt || lec.closed) return;
  const notOpenYet = lec.qs.length - counted(lec).length;
  const err = el("p", { class: "err" });
  const go = el("button", { class: "primary", text: "Submit", onclick: async () => {
    go.disabled = true;
    await flushOutbox();
    if (store.get(KEY.outbox, []).some((x) => x.session === lec.session)) {
      go.disabled = false;
      err.textContent = "Some of your results have not reached the server yet. Check your internet connection and try again.";
      return;
    }
    try {
      const r = await api("POST", "/api/submit", { session: lec.session });
      lec.submittedAt = r.submitted_at;
      close();
      const toast = document.querySelector(".toast");
      if (toast) toast.remove();
      redraw();
    } catch (e) { go.disabled = false; err.textContent = e.message; }
  } });
  const close = modal(el("h2", { text: "Final submit" }), summaryTable(lec),
    notOpenYet ? el("p", { class: "muted", text: `(${notOpenYet} more question${notOpenYet > 1 ? "s" : ""} of these topics will come in a later lecture.)` }) : null,
    el("p", { text: "After you submit, your answers for this lecture are final." }), err,
    el("div", { class: "actions" }, go, el("button", { text: "Not yet", onclick: () => close() })));
}

/* ------------------------------------------------------------------ instructor: open a question, show the answer */

function openStrip(e) {
  const lec = state.lec;
  const btn = el("button", { class: "small primary", text: "Open for students", onclick: async () => {
    btn.disabled = true;
    try {
      await api("POST", "/api/admin/open", { session: lec.session, bundle: e.bundle, qid: e.qid });
      lec.open.add(e.uid);
      redraw();
    } catch (err) { alert(err.message); }
    btn.disabled = false;
  } });
  return el("div", { class: "instr-open" }, el("span"), btn);
}

function answerBox(e, fullContent, card) {
  const full = questions(fullContent).find((x) => x.qid === e.qid) || {};
  const q = e.q;
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

function codeArea(e, feedback) {
  const lec = state.lec;
  const q = e.q, uid = e.uid;
  const holder = el("div", { class: "editor" });
  const wrap = el("div", { class: "codearea" }, holder);
  const cm = CodeMirror(holder, {
    value: lec.answers[uid] !== undefined ? lec.answers[uid] : (q.preload || ""),
    mode: "python", lineNumbers: true, indentUnit: 4, tabSize: 4, matchBrackets: true, viewportMargin: Infinity,
    extraKeys: { Tab: (c) => c.replaceSelection("    ") },
  });
  cm.on("change", () => { lec.answers[uid] = cm.getValue(); saveProgress(); });
  setTimeout(() => cm.refresh(), 0);
  const keys = el("div", { class: "keys" }, KEYS.map(([label, text]) =>
    el("button", { class: "small key", text: label, onclick: () => { cm.replaceSelection(text); cm.focus(); } })));
  const run = async (mode, btn) => {
    btn.disabled = true;
    feedback.replaceChildren(el("p", { class: "muted", text: "Running your code..." }));
    try {
      const code = cm.getValue();
      const r = await runCodeTests(q, code, mode);
      const out = [];
      if (r.syntax) out.push(el("pre", { class: "err", text: r.syntax }));
      else out.push(resultsTable(r));
      if (mode === "all") {
        const res = recordCheck(e, normalise(code), !r.syntax && r.passed);
        out.unshift(r.syntax && !res.solvedBefore && !res.locked ? el("p", { class: "bad", text: "Your code has a syntax error (see below)." + (res.repeat ? " (Same code as your last Check: not counted as a new try.)" : "") })
          : verdictText({ ...res, correct: !r.syntax && r.passed }, true));
      } else {
        out.unshift(el("p", { class: "muted", text: r.syntax ? "Pre-check: your code has a syntax error (see below)."
          : r.passed ? "Pre-check: the examples pass. Now press Check (it also runs hidden tests)." : "Pre-check: not all examples pass yet." }));
      }
      if (r.figures) out.push(el("div", { class: "figs" }, r.figures.map((b) => el("img", { src: "data:image/png;base64," + b, alt: "your drawing" }))));
      feedback.replaceChildren(...out);
    } catch (err) { feedback.replaceChildren(el("p", { class: "bad", text: err.message })); }
    finally { btn.disabled = false; }
  };
  const preBtn = el("button", { text: "Pre-check", title: "Runs the examples only. Free: not a try." });
  preBtn.onclick = () => run("examples", preBtn);
  const checkBtn = el("button", { class: "primary", text: "Check", title: "Runs all the tests, hidden ones too. Counts as a try." });
  checkBtn.onclick = () => run("all", checkBtn);
  wrap.append(keys, el("div", { class: "actions" }, preBtn, checkBtn));
  if (q.tutor) {
    wrap.append(el("div", { class: "tutor" }, el("button", { class: "linkbtn", text: "Visualize this code in Python Tutor ↗",
      title: "Opens your code in pythontutor.com (step through it line by line)",
      onclick: () => window.open("https://pythontutor.com/visualize.html#code=" + encodeURIComponent(cm.getValue()) + "&py=3&cumulative=false&curInstr=0", "_blank", "noopener") })));
  }
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

/* ------------------------------------------------------------------ my marks (only the student's own) */

async function showMarks() {
  const g = state.gen;
  state.lec = null;
  const r = await api("GET", "/api/my-marks");
  if (!fresh(g)) return;
  setBar();
  $("view").className = "view";
  const val = (x) => (x === null || x === undefined ? "-" : fmt(x));
  const parts = [el("header", { class: "welcome" }, el("h1", { text: "My marks" }),
    el("p", { text: `${r.name} (${r.roll})` }), r.updated ? el("p", { class: "muted small", text: `Marks updated ${r.updated}.` }) : null)];
  const cats = new Map(r.categories.map((c) => [c.id, c]));
  const groups = [...new Set(r.items.map((it) => it.category))];
  for (const cid of groups) {
    const c = cats.get(cid) || { name: cid, dropped: [] };
    const rows = r.items.filter((it) => it.category === cid).map((it) => {
      const src = it.parts.map((p) => p.src).filter(Boolean);
      const rem = it.parts.map((p) => p.rem).filter(Boolean);
      const dropped = (c.dropped || []).includes(it.id);
      return el("tr", { class: dropped ? "dropped" : "" },
        el("td", {}, el("div", { text: it.title }),
          it.parts.length > 1 ? el("div", { class: "muted small", text: it.parts.map((p) => `${p.title}: ${val(p.m)} / ${p.max}`).join(" · ") }) : null,
          src.length ? el("div", { class: "muted small", text: src.map((s) => (s === "late" ? "late submission" : s + " batch")).join(", ") }) : null,
          rem.length ? el("div", { class: "muted small", text: rem.join("; ") }) : null,
          dropped ? el("div", { class: "small dropnote", text: "lowest lab: dropped (best of the rest count)" }) : null),
        el("td", { class: "num", text: it.graded ? `${fmt(it.marks)} / ${it.max}` : `- / ${it.max}` }),
        el("td", { class: "num muted", text: it.graded ? `${it.percent}%` : "" }));
    });
    parts.push(el("section", { class: "mcat" },
      el("h2", {}, c.name, c.percent !== undefined ? el("span", { class: "mpct", text: ` ${c.percent}%` + (c.note ? ` (${c.note})` : "") }) : null),
      el("div", { class: "tablewrap" }, el("table", { class: "grid marks" }, el("tbody", {}, rows)))));
  }
  if (!r.items.length) parts.push(el("p", { class: "muted", text: "No marks have been uploaded yet." }));
  const lp = r.categories.find((c) => c.id === "lectures");
  const a = r.attendance;
  parts.push(el("section", { class: "mcat" },
    el("h2", { text: "Lectures" }),
    el("p", { text: `Attendance: ${a.attended} of ${a.held} lectures (${a.percent}%)` + (a.exempt ? " · exempt from the attendance rule (full marks in the midsem)" : "") }),
    el("p", { text: `Lecture score: ${fmt(r.lectures.score)} of ${r.lectures.possible} questions` + (lp ? ` (${lp.percent}%)` : "") }),
    el("details", {}, el("summary", { text: "Lecture by lecture" }),
      el("div", { class: "tablewrap" }, el("table", { class: "grid" },
        el("thead", {}, el("tr", {}, ["Lec", "Date", "", "Score", "Topics"].map((h) => el("th", { text: h })))),
        el("tbody", {}, r.lecture_list.slice().reverse().map((l) => el("tr", {},
          el("td", { class: "num", text: String(l.lec_no) }), el("td", { text: `${l.day} ${l.date}` }),
          el("td", { class: "cell " + (l.present ? "p" : "a"), text: l.present ? "P" : "A" }),
          el("td", { class: "num", text: l.manual ? "" : `${fmt(l.score)} / ${l.out_of}` }),
          el("td", { class: "small", text: l.manual ? "(attendance on paper)" : l.topics })))))))));
  parts.push(el("p", { class: "muted small", text: "Only you can see this page. If something looks wrong, please contact the instructor." }));
  $("view").replaceChildren(...parts.filter(Boolean));
}

/* ------------------------------------------------------------------ routing */

async function route() {
  const g = ++state.gen;
  stopPolling();
  const toast = document.querySelector(".toast");
  if (toast) toast.remove();
  if (!store.get(KEY.token)) return showSignIn();
  try {
    if (!state.me) { state.me = await api("GET", "/api/me"); guestNotice(); }
    if (!fresh(g)) return;
    const m = location.hash.match(/^#\/lec\/(.+)$/);
    if (location.hash.startsWith("#/instructor") && state.me.instructor && window.Instructor) await window.Instructor.route(g);
    else if (location.hash === "#/now") await openNow();
    else if (location.hash === "#/marks") await showMarks();
    else if (m) await openPractice(decodeURIComponent(m[1]));
    else await showList();
  } catch (e) {
    if (!fresh(g)) return;
    if (e.status === 401) return showSignIn("Please sign in again.");
    $("view").className = "view";
    $("view").replaceChildren(el("section", { class: "card center" }, el("p", { class: "err", text: e.message }),
      el("button", { text: "Try again", onclick: route })));
  }
}
window.addEventListener("hashchange", route);
route();
flushOutbox();
