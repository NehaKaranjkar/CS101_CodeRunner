"use strict";
/* lecture.js - student page of the CS101 lecture system (see docs/lecture_support_system.md).

   Sign in with Google (iitgoa.ac.in), list the lectures (active / past / future), join the active
   lecture with its password, answer the questions. Every question is checked here, in the browser
   (code runs in Pyodide); the answer keys come with the questions. Each Check of a changed answer is a
   try, and as in the labs every try after the first failed one costs a penalty (default "10, 20, ...").
   In the ACTIVE lecture each Check is reported to the backend in the background (tries, solved or not);
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
const fmt1 = (x) => (Math.round(x * 10) / 10).toFixed(1);

/* ------------------------------------------------------------------ backend */

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const RETRY = /^\/api\/(join|report|lectures|bundle|me)\b/;
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
function queueReport(item) {
  const box = store.get(KEY.outbox, []).filter((x) => !(x.session === item.session && x.qid === item.qid));
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
      const i = box.findIndex((x) => x.session === item.session && x.qid === item.qid);
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

function lecScore(lec) {
  const qs = questions(lec.content);
  const sum = qs.reduce((a, q) => a + ((lec.status[q.qid] || {}).correct ? (lec.status[q.qid].score ?? 1) : 0), 0);
  return { score: qs.length ? 10 * sum / qs.length : 0, solved: qs.filter((q) => (lec.status[q.qid] || {}).correct).length, n: qs.length };
}

function setBar() {
  const me = state.me, lec = state.lec;
  $("bar-user").hidden = !me;
  if (me) $("bar-email").textContent = me.email;
  $("bar-instructor").hidden = !(me && me.instructor);
  $("bar-guest").hidden = !(me && !me.instructor && !me.on_roster);
  $("bar-lec").hidden = !lec;
  $("bar-score").hidden = !lec;
  if (lec) {
    $("bar-title").textContent = (lec.active ? `Lec ${lec.lec_no} · ` : "") + fullTitle(lec);
    $("bar-date").textContent = lec.active ? `${lec.day} ${lec.date}` : lec.preview ? "Preview (not recorded)" : "Practice (not recorded)";
    const s = lecScore(lec);
    $("bar-score").textContent = `${fmt1(s.score)} / 10`;
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

// Accounts that are not on the roster see this once (per browser) after signing in.
function guestNotice() {
  const me = state.me;
  if (!me || me.instructor || me.on_roster) return;
  const k = "lec:guestnote:" + me.email;
  if (store.get(k)) return;
  const close = () => { store.set(k, true); box.remove(); };
  const box = el("div", { class: "modal-back" }, el("div", { class: "modal", role: "dialog", "aria-modal": "true" },
    el("p", { text: "Your login account is not among the registered students for CS101. Please contact the instructor." }),
    el("p", { class: "muted", text: "You can still follow the lectures and solve the questions, but your attendance is not recorded." }),
    el("div", { class: "actions" }, el("button", { class: "primary", text: "OK", onclick: close }))));
  document.body.append(box);
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
  const active = lecs.filter((l) => l.state === "active");
  const past = lecs.filter((l) => l.state === "past");            // in topic order, like the others
  const future = lecs.filter((l) => l.state === "future");
  const card = (l) => {
    const recent = l.held.slice(-3).reverse().map((h) => `Lec ${h.lec_no} (${h.day} ${h.date})`).join(", ");
    const meta = l.state === "future" ? "coming up"
      : l.state === "active" ? `Lec ${l.active.lec_no}, now · ${l.questions} questions`
      : (recent ? recent + (l.held.length > 3 ? ` and ${l.held.length - 3} earlier` : "") + " · " : "") + `${l.questions} questions`;
    const inner = [el("span", { class: "lt" }, l.number ? el("span", { class: "lnum", text: l.number }) : null, l.title),
      el("span", { class: "lm", text: meta })];
    if (l.state === "future") return el("li", { class: "lcard future" }, ...inner);
    return el("li", {}, el("a", { class: "lcard " + l.state, href: "#/lec/" + encodeURIComponent(l.id) }, ...inner,
      l.state === "active" ? el("span", { class: "badge", text: "Now" }) : null));
  };
  const parts = [   // (replaceChildren would print a null as the text "null", so filter them out)
    el("header", { class: "welcome" }, el("h1", { text: r.course || "CS101" }),
      el("p", { text: "Welcome to the class!" })),
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
  const g = state.gen;
  const r = await api("GET", "/api/lectures");
  if (!fresh(g)) return;
  const l = r.lectures.find((x) => x.id === bundleId);
  if (!l || l.state === "future") { location.hash = "#/"; return; }
  if (l.state === "past") {
    const b = await api("GET", "/api/bundle?id=" + encodeURIComponent(bundleId));
    if (!fresh(g)) return;
    const key = `lec:prog:${bundleId}:practice`;
    const saved = store.get(key, { answers: {}, status: {} });
    state.lec = { active: false, bundle: bundleId, number: l.number, title: l.title, content: b.content, answers: saved.answers, status: saved.status || {}, key };
    return renderLecture(g);
  }
  const joinKey = "lec:join:" + bundleId;
  const remembered = store.get(joinKey);
  if (remembered && remembered.session === l.active.session) {
    try { return await enterActive(bundleId, remembered.password, g); } catch (e) { /* fall through to the password form */ }
  }
  if (!fresh(g)) return;
  showPasswordForm(l, g);
}

function showPasswordForm(l, g) {
  setBar();
  $("view").className = "view";
  const input = el("input", { type: "text", autocomplete: "off", autocapitalize: "none", spellcheck: "false", placeholder: "lecture password" });
  const go = async () => {
    btn.disabled = true;
    try { await enterActive(l.id, input.value, g); }
    catch (e) { btn.disabled = false; err.textContent = e.message; }
  };
  const btn = el("button", { class: "primary", text: "Join", onclick: go });
  const err = el("p", { class: "err", text: "" });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  $("view").replaceChildren(el("section", { class: "card center" },
    el("h1", { text: `Lec ${l.active.lec_no}: ${fullTitle(l)}` }),
    el("p", { text: "Enter the password announced in class." }),
    el("div", { class: "row" }, input, btn), err));
  input.focus();
}

async function enterActive(bundleId, password, g) {
  const r = await api("POST", "/api/join", { bundle: bundleId, password });
  if (!fresh(g)) return;
  store.set("lec:join:" + bundleId, { session: r.session, password });
  const key = `lec:prog:${bundleId}:s${r.session}`;
  const saved = store.get(key, { answers: {}, status: {} });
  // the server's record and this browser's are merged (a student may switch phones mid-lecture)
  const status = { ...(saved.status || {}) };
  for (const [qid, s] of Object.entries(r.results || {})) {
    const mine = status[qid] || { tries: 0, correct: false };
    if (s.correct && !mine.correct) status[qid] = { ...mine, tries: s.tries, correct: true, score: s.score };
    else if (!mine.correct && s.tries > mine.tries) status[qid] = { ...mine, tries: s.tries };
  }
  state.me.on_roster = r.on_roster;
  state.lec = { active: true, bundle: bundleId, session: r.session, lec_no: r.lec_no, number: r.content.number || "", title: r.title,
    date: r.date, day: r.day, content: r.content, answers: saved.answers || {}, status, key };
  saveProgress();
  await renderLecture(g);
}

function saveProgress() {
  const lec = state.lec;
  if (lec) store.set(lec.key, { answers: lec.answers, status: lec.status });
}

/* ------------------------------------------------------------------ the lecture page */

async function renderLecture(g) {
  const lec = state.lec;
  if (state.me.instructor && !lec.full) {       // answer keys and solutions, for "Show answer" (instructor only)
    try { lec.full = (await api("GET", "/api/admin/bundle?id=" + encodeURIComponent(lec.bundle))).content; } catch (e) { lec.full = null; }
    if (!fresh(g)) return;
  }
  lec.regime = parsePenalty(lec.content.penalty);
  setBar();
  const view = $("view");
  view.className = "view lecview";
  const main = el("div", { class: "lecmain" });
  const nav = el("nav", { class: "lqnav", "aria-label": "Questions" });
  lec.navItems = {};
  main.append(el("header", { class: "lhead" },
    lec.number ? el("div", { class: "lh-num", text: "Topic " + lec.number }) : null,
    el("h1", { text: lec.title }),
    lec.content.description ? el("div", { class: "lh-desc", html: lec.content.description }) : null));
  let qn = 0;
  for (const it of lec.content.items || []) {
    if (it.kind === "text") main.append(el("section", { class: "teach", html: it.html }));
    else if (it.kind === "question") {
      const n = ++qn;
      main.append(questionCard(it, n));
      const item = el("button", { class: "qn", title: `Question ${n}`, text: String(n),
        onclick: () => document.getElementById("q-" + it.qid).scrollIntoView({ behavior: "smooth", block: "start" }) });
      lec.navItems[it.qid] = item;
      nav.append(item);
    }
  }
  main.append(el("p", { class: "muted endnote", text: lec.active
    ? "Your results are recorded for this lecture. Keep going at your own pace."
    : "This lecture is for practice: nothing is recorded." }));
  nav.prepend(el("div", { class: "lqnav-head", text: "Questions" }));
  nav.append(el("div", { class: "lqnav-key" },
    el("span", {}, el("i", { class: "k solved" }), "solved"), el("span", {}, el("i", { class: "k penalty" }), "solved with penalty"),
    el("span", {}, el("i", { class: "k wrong" }), "not yet right"), el("span", {}, el("i", { class: "k none" }), "not tried")));
  view.replaceChildren(el("div", { class: "lecgrid" }, nav, main));
  for (const q of questions(lec.content)) refreshQuestion(q.qid);
  watchCurrent(main);
  window.scrollTo(0, 0);
}

// Marks the question being read in the nav.
let observer = null;
function watchCurrent(main) {
  if (observer) observer.disconnect();
  if (!("IntersectionObserver" in window)) return;
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const item = state.lec && state.lec.navItems[e.target.id.slice(2)];
      if (item) item.classList.toggle("current", e.isIntersecting);
    }
  }, { rootMargin: "-30% 0px -50% 0px" });
  main.querySelectorAll(".qcard").forEach((c) => observer.observe(c));
}

const qState = (s) => (!s || !s.tries ? "none" : !s.correct ? "wrong" : (s.score ?? 1) < 1 ? "penalty" : "solved");

// Updates the nav item, the tries chip and the badge of one question.
function refreshQuestion(qid) {
  const lec = state.lec;
  const s = lec.status[qid];
  const st = qState(s);
  const item = lec.navItems[qid];
  if (item) item.className = "qn " + st + (item.classList.contains("current") ? " current" : "");
  if (item) item.title = `Question ${item.textContent}: ` + { none: "not tried", wrong: "not yet right", penalty: "solved with a penalty", solved: "solved" }[st];
  const card = document.getElementById("q-" + qid);
  if (!card) return;
  const chip = card.querySelector(".try-chip");
  const tries = s ? s.tries : 0;
  if (s && s.correct) {
    const pct = Math.round(100 - 100 * (s.score ?? 1));
    chip.textContent = `Tries: ${tries} · ` + (pct > 0 ? `Penalty: ${pct}%` : "No penalty");
    chip.className = "try-chip solved";
    chip.title = "Solved" + (pct > 0 ? `: this question counts ${100 - pct}%.` : ": full credit.");
  } else {
    const pct = penaltyPct(lec.regime, tries);
    chip.textContent = `Tries: ${tries} · ` + (pct > 0 ? `Penalty: ${pct}%` : "No penalty");
    chip.className = "try-chip" + (pct > 0 ? " warn" : "");
    chip.title = (pct > 0 ? `If your next Check is right, this question counts ${100 - pct}%.` : "Your next Check can earn full credit.")
      + " Each Check of a changed answer is a try" + (questions(lec.content).find((q) => q.qid === qid).type === "code" ? "; Pre-check is free." : ".");
  }
  const badge = card.querySelector(".qbadge");
  badge.className = "qbadge " + (st === "none" ? "" : st === "wrong" ? "wrong" : "right");
  badge.textContent = st === "none" ? "" : st === "wrong" ? "✗ try again" : "✓ solved";
}

/* One Check: counts a try unless the question is solved or the answer is the one checked last time.
   Returns { correct, repeat, solvedBefore }. */
function recordCheck(q, canonical, correct) {
  const lec = state.lec;
  const prev = lec.status[q.qid] || { tries: 0, correct: false };
  if (prev.correct) return { correct, solvedBefore: true };
  if (prev.last === canonical) return { correct: prev.lastCorrect, repeat: true };
  const tries = prev.tries + 1;
  const score = correct ? 1 - penaltyPct(lec.regime, tries - 1) / 100 : 0;
  lec.status[q.qid] = { tries, correct, score, last: canonical, lastCorrect: correct };
  saveProgress();
  if (lec.active) queueReport({ session: lec.session, qid: q.qid, tries, correct });
  refreshQuestion(q.qid);
  setBar();
  return { correct };
}

function verdictText(r, isCode) {
  if (r.solvedBefore) return el("p", { class: r.correct ? "ok" : "bad", text: r.correct
    ? "Correct. (You had already solved this one; your score for it stays.)"
    : "Not quite, but you had already solved this one; your score for it stays." });
  const base = r.correct ? (isCode ? "All tests passed. Well done!" : "Correct! Well done.")
    : (isCode ? "Not all tests passed yet. Look at the table, fix your code and try again." : "Not quite. Have another look and try again.");
  return el("p", { class: r.correct ? "ok" : "bad", text: base + (r.repeat ? " (Same answer as your last Check: not counted as a new try.)" : "") });
}

const TYPE_LABEL = { mcq: "Choose one", short: "Short answer", predict: "What does it print?", order: "Put in order", code: "Code" };

function questionCard(q, n) {
  const lec = state.lec;
  const feedback = el("div", { class: "feedback", "aria-live": "polite" });
  const card = el("section", { class: "qcard", id: "q-" + q.qid },
    el("div", { class: "qhead" }, el("span", { class: "qno", text: `Q${n}` }), el("span", { class: "qtype", text: TYPE_LABEL[q.type] || q.type }),
      el("span", { class: "qbadge" }), el("span", { class: "try-chip" })),
    el("div", { class: "qtext", html: q.html || "" }));
  const check = (answer, canonical) => feedback.replaceChildren(verdictText(recordCheck(q, canonical, grade(q, answer)), false));

  if (q.type === "mcq") {
    const name = "mcq-" + q.qid;
    const opts = (q.options || []).map((o, i) => el("label", { class: "opt" },
      el("input", { type: "radio", name, value: String(i), checked: String(lec.answers[q.qid]) === String(i),
        onchange: () => { lec.answers[q.qid] = i; saveProgress(); } }),
      el("span", { html: o })));
    const btn = el("button", { class: "primary", text: "Check", onclick: () => {
      if (lec.answers[q.qid] === undefined) return feedback.replaceChildren(el("p", { class: "bad", text: "Choose an answer first." }));
      check(lec.answers[q.qid], String(lec.answers[q.qid]));
    } });
    card.append(el("div", { class: "opts" }, opts), el("div", { class: "actions" }, btn), feedback);
  } else if (q.type === "short" || q.type === "predict") {
    if (q.type === "predict" && q.code) card.append(el("pre", { class: "code", text: q.code }));
    const input = q.type === "predict"
      ? el("textarea", { rows: String(Math.max(2, (q.lines_hint || 2))), spellcheck: "false", autocapitalize: "none", placeholder: "Type the exact output" })
      : el("input", { type: "text", spellcheck: "false", autocapitalize: "none", placeholder: "Your answer" });
    input.value = lec.answers[q.qid] || "";
    input.addEventListener("input", () => { lec.answers[q.qid] = input.value; saveProgress(); });
    if (q.type === "short") input.addEventListener("keydown", (e) => { if (e.key === "Enter") btn.click(); });
    const btn = el("button", { class: "primary", text: "Check", onclick: () => {
      if (!input.value.trim()) return feedback.replaceChildren(el("p", { class: "bad", text: "Type an answer first." }));
      check(input.value, q.type === "short" ? squash(input.value) : normalise(input.value));
    } });
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
    const btn = el("button", { class: "primary", text: "Check", onclick: () => check(order, JSON.stringify(order)) });
    card.append(list, el("div", { class: "actions" }, btn), feedback);
  } else if (q.type === "code") {
    card.append(codeArea(q, feedback), feedback);
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

function codeArea(q, feedback) {
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
      const code = cm.getValue();
      const r = await runCodeTests(q, code, mode);
      const out = [];
      if (r.syntax) out.push(el("pre", { class: "err", text: r.syntax }));
      else out.push(resultsTable(r));
      if (mode === "all") {
        const res = recordCheck(q, normalise(code), !r.syntax && r.passed);
        out.unshift(r.syntax && !res.solvedBefore ? el("p", { class: "bad", text: "Your code has a syntax error (see below)." + (res.repeat ? " (Same code as your last Check: not counted as a new try.)" : "") })
          : verdictText({ ...res, correct: !r.syntax && r.passed }, true));
      } else {
        out.unshift(el("p", { class: "muted", text: r.syntax ? "Pre-check: your code has a syntax error (see below)."
          : r.passed ? "Pre-check: the examples pass. Now press Check (it also runs hidden tests)." : "Pre-check: not all examples pass yet." }));
      }
      if (r.figures) out.push(el("div", { class: "figs" }, r.figures.map((b) => el("img", { src: "data:image/png;base64," + b, alt: "your drawing" }))));
      feedback.replaceChildren(...out);
    } catch (e) { feedback.replaceChildren(el("p", { class: "bad", text: e.message })); }
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

/* ------------------------------------------------------------------ routing */

async function route() {
  const g = ++state.gen;
  if (observer) { observer.disconnect(); observer = null; }
  if (!store.get(KEY.token)) return showSignIn();
  try {
    if (!state.me) { state.me = await api("GET", "/api/me"); guestNotice(); }
    if (!fresh(g)) return;
    const m = location.hash.match(/^#\/lec\/(.+)$/);
    if (location.hash.startsWith("#/instructor") && state.me.instructor && window.Instructor) await window.Instructor.route(g);
    else if (m) await openLecture(decodeURIComponent(m[1]));
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
