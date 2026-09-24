"use strict";
/* Shared exam / practice page.
   Backend: window.EXAM_BACKEND = "local" (exam.py on this computer) or
            "web" (practice site: Python runs in the browser, see web_backend.js). */

const BACKEND = window.EXAM_BACKEND || "local";
const WEB = BACKEND === "web";
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
};
const fmt = (x) => (Math.round(x * 100) / 100).toString();

async function api(path, body, rawName) {
  if (WEB) return WebBackend.request(path, body, rawName);
  const opts = body === undefined ? {} : {
    method: "POST",
    headers: rawName ? { "Content-Type": "application/octet-stream", "X-Filename": rawName } : { "Content-Type": "application/json" },
    body: rawName ? body : JSON.stringify(body),
  };
  let res;
  try { res = await fetch(path, opts); }
  catch (e) { throw new Error("Cannot reach the exam program. Is its terminal window still open?"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function show(screen) {
  for (const s of ["screen-bank", "screen-login", "screen-exam", "screen-done"]) $(s).hidden = s !== screen;
}

/* ------------------------------------------------------------------ */
/* Start-up                                                            */
/* ------------------------------------------------------------------ */
let sessionNote = "";

async function init() {
  const st = await api("/api/state").catch((e) => ({ phase: "choose_bank", error: e.message }));
  await route(st);
}

async function route(st) {
  $("bank-error").textContent = st.error || "";
  if (st.phase === "choose_bank") return showChoose();
  if (st.phase === "password") return showPassword(st);
  if (st.phase === "login") return showLogin(st);
  return loadExam();
}

async function showChoose() {
  $("choose-part").hidden = false;
  $("password-part").hidden = true;
  show("screen-bank");
  if (!WEB) return;
  $("choose-title").textContent = "Python programming practice";
  $("file-help").hidden = true;
  $("bank-list-wrap").hidden = false;
  const list = $("bank-list");
  list.textContent = "";
  let banks = [];
  try { banks = (await (await fetch("question_banks/index.json", { cache: "no-store" })).json()).banks || []; }
  catch (e) { /* no index: only the file button */ }
  $("bank-list-empty").hidden = banks.length > 0;
  for (const b of banks) {
    const meta = `${b.questions} questions, ${fmt(b.marks)} marks` + (b.duration_minutes ? `, ${b.duration_minutes} min` : "");
    const item = el("li", {}, el("button", {
      class: "bank-item", onclick: () => openBankUrl("question_banks/" + b.file, b.file),
    }, el("span", { class: "bank-title", text: b.title }), el("span", { class: "muted", text: meta })));
    list.append(item);
  }
}

async function openBankUrl(url, name) {
  $("bank-error").textContent = "";
  try {
    const buf = await (await fetch(url, { cache: "no-store" })).arrayBuffer();
    await route(await api("/api/bank", buf, name));
  } catch (e) { $("bank-error").textContent = e.message; }
}

$("bank-file").addEventListener("change", async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  $("bank-error").textContent = "";
  try { await route(await api("/api/bank", await f.arrayBuffer(), f.name)); }
  catch (e) { $("bank-error").textContent = e.message; }
  ev.target.value = "";
});

function showPassword(st) {
  $("choose-part").hidden = true;
  $("password-part").hidden = false;
  $("password-title").textContent = "Programming exam";
  $("password-file").textContent = "Question file: " + st.bank_file;
  show("screen-bank");
  $("password").focus();
}

async function unlock() {
  $("bank-error").textContent = "";
  try {
    const st = await api("/api/unlock", { password: $("password").value });
    $("password").value = "";
    await route(st);
  } catch (e) { $("bank-error").textContent = e.message; }
}
$("btn-unlock").addEventListener("click", unlock);
$("password").addEventListener("keydown", (e) => { if (e.key === "Enter") unlock(); });

function showLogin(st) {
  $("login-title").textContent = st.title;
  $("login-opens").hidden = !st.opens_at;
  $("login-opens").textContent = st.opens_at ? `This exam opens at ${st.opens_at}.` : "";
  show("screen-login");
  $("roll").focus();
}

async function login() {
  $("login-error").textContent = "";
  $("btn-login").disabled = true;
  try {
    const r = await api("/api/login", { roll: $("roll").value, name: $("name").value });
    if (r.resumed) sessionNote = "Resumed your saved exam" + (r.name_differs ? ` (registered name: ${r.name})` : "") + ".";
    await loadExam();
  } catch (e) { $("login-error").textContent = e.message; }
  $("btn-login").disabled = false;
}
$("btn-login").addEventListener("click", login);
$("name").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });

async function backToChoose() {
  await api("/api/reset", {}).catch(() => {});
  location.reload();
}
$("btn-back").addEventListener("click", backToChoose);
$("btn-back-pw").addEventListener("click", backToChoose);

/* ------------------------------------------------------------------ */
/* Questions                                                           */
/* ------------------------------------------------------------------ */
let EXAM = null;          // static data from /api/exam
let STATUS = null;        // latest status
let current = 1;
let cm = null;
const docs = {};          // per-question CodeMirror documents (keeps undo history)
const serverCode = {};    // last code the backend has for each question
const lastResult = {};    // last pre-check/check result per question (this session)
let clockOffset = 0;
let busy = false;
let submitting = false;
let ticker = null;

const MODE_LABEL = { exam: "Exam in progress", preview: "Preview (nothing is saved)", practice: "Practice" };

async function loadExam() {
  EXAM = await api("/api/exam");
  clockOffset = EXAM.server_now - Date.now() / 1000;
  if (EXAM.submitted) return showDone(EXAM.status);
  setupEditor();
  for (const k of Object.keys(docs)) delete docs[k];
  for (const q of EXAM.status.questions) {
    docs[q.no] = CodeMirror.Doc(q.code, "python");
    serverCode[q.no] = q.code;
  }
  $("tb-mode").textContent = MODE_LABEL[EXAM.mode] || "";
  $("tb-title").textContent = EXAM.title;
  $("tb-student").textContent = EXAM.mode === "exam" ? `${EXAM.roll}, ${EXAM.name}` : "";
  $("tb-student").hidden = EXAM.mode !== "exam";
  $("tb-start").textContent = new Date(EXAM.started_epoch * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  $("tb-start-wrap").hidden = EXAM.mode !== "exam";
  $("mb-penalty").textContent = EXAM.penalty_text;
  $("mb-penalty").className = EXAM.penalty_on ? "penalty-on" : "";
  buildTools();
  buildNav();
  applyStatus(EXAM.status);
  show("screen-exam");
  const firstOpen = EXAM.status.questions.find((q) => q.state !== "correct");
  current = 0;
  openQuestion(firstOpen ? firstOpen.no : 1);
  if (sessionNote) { $("save-state").textContent = sessionNote; sessionNote = ""; }
  clearInterval(ticker);
  tick();
  ticker = setInterval(tick, 1000);
}

function buildTools() {
  const t = $("mb-tools");
  t.textContent = "";
  if (EXAM.mode === "practice") {
    t.append(
      el("button", { class: "small", text: "Download progress", title: "Save your answers to a file on this computer", onclick: downloadProgress }),
      el("button", { class: "small", text: "Open progress", title: "Continue from a progress file", onclick: () => $("progress-file").click() }),
      el("button", { class: "small", text: "Start over", onclick: startOver }),
      el("button", { class: "small", text: "Other question sets", onclick: backToChoose }));
  } else if (EXAM.mode === "preview") {
    t.append(el("button", { class: "small", text: "Open another bank", onclick: backToChoose }));
  }
  $("btn-more").hidden = t.childElementCount === 0;   // phones show the tools behind "More"
}
$("btn-more").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = document.body.classList.toggle("tools-open");
  $("btn-more").setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (e) => {
  if (document.body.classList.contains("tools-open") && !e.target.closest("#mb-tools")) {
    document.body.classList.remove("tools-open");
    $("btn-more").setAttribute("aria-expanded", "false");
  }
});

function isDirty(no) { return docs[no] && docs[no].getValue() !== serverCode[no]; }

function buildNav() {
  const nav = $("nav");
  nav.textContent = "";
  const heads = {};
  for (const s of EXAM.sections || []) heads[s.start] = s.heading;
  for (const q of EXAM.questions) {
    if (heads[q.no]) nav.append(el("div", { class: "nav-heading", text: heads[q.no] }));
    const a = el("a", { href: "#", id: "nav-" + q.no, title: q.title },
      el("span", { class: "num", text: String(q.no) }),
      el("span", { class: "title", text: q.title }),
      el("span", { class: "dot", title: "Changed since the last Check" }));
    a.addEventListener("click", (e) => { e.preventDefault(); openQuestion(q.no); });
    nav.append(a);
  }
  const lg = el("div", { class: "legend" });
  for (const [c, t] of [["var(--correct)", "correct"], ["var(--wrong)", "wrong"], ["var(--idle)", "not attempted"], ["var(--edited)", "changed, not checked"]]) {
    const i = el("i"); i.style.background = c;
    lg.append(el("span", {}, i, t));
  }
  nav.append(lg);
}

function applyStatus(status) {
  STATUS = status;
  const s = status.summary;
  $("tb-marks").textContent = `${fmt(s.marks)} / ${fmt(s.max_marks)}`;
  $("tb-correct").textContent = s.correct;
  $("tb-wrong").textContent = s.wrong;
  $("tb-idle").textContent = s.not_attempted;
  for (const q of status.questions) {
    serverCode[q.no] = q.code;
    refreshNavItem(q.no);
  }
  if (current) showWorth(current);
  if (status.submitted) showDone(status);
}

function refreshNavItem(no) {
  const a = $("nav-" + no);
  if (!a || !STATUS) return;
  const q = STATUS.questions[no - 1];
  a.className = [q.state, no === current ? "current" : "", (q.modified || isDirty(no)) ? "edited" : ""].join(" ").trim();
}

function showWorth(no) {
  const q = STATUS.questions[no - 1];
  const w = $("q-worth");
  w.hidden = !EXAM.penalty_on || q.state === "correct";
  if (w.hidden) return;
  w.textContent = q.next_worth_pct >= 100
    ? "Your next Check can earn full marks."
    : `After ${q.failed_checks} failed Check${q.failed_checks === 1 ? "" : "s"}, your next Check can earn at most ${fmt(q.next_worth_pct)}% (${fmt(q.max_marks * q.next_worth_pct / 100)} of ${fmt(q.max_marks)} marks).`;
}

/* ---------- question list: collapsible (desktop), drawer (phones) ---------- */
const narrow = () => window.matchMedia("(max-width: 800px)").matches;
let desktopNavOpen = true, mobileNavOpen = false;
try { desktopNavOpen = localStorage.getItem("cr-nav-collapsed") !== "1"; } catch (e) { /* storage unavailable */ }
function applyNav() {
  const open = narrow() ? mobileNavOpen : desktopNavOpen;
  document.body.classList.toggle("nav-open", narrow() && open);
  document.body.classList.toggle("nav-collapsed", !narrow() && !open);
  $("btn-nav").setAttribute("aria-expanded", String(open));
}
function toggleNav(force) {
  if (narrow()) mobileNavOpen = force === undefined ? !mobileNavOpen : force;
  else {
    desktopNavOpen = force === undefined ? !desktopNavOpen : force;
    try { localStorage.setItem("cr-nav-collapsed", desktopNavOpen ? "0" : "1"); } catch (e) { /* ignore */ }
  }
  applyNav();
  if (cm) cm.refresh();
}
$("btn-nav").addEventListener("click", () => toggleNav());
$("nav-backdrop").addEventListener("click", () => toggleNav(false));
window.addEventListener("resize", applyNav);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("nav-open")) toggleNav(false);
});
applyNav();

/* ---------- editor ---------- */
const DEDENT_OPENERS = {
  else: ["if", "elif", "for", "while", "try", "except"],
  elif: ["if", "elif"],
  except: ["try", "except"],
  finally: ["try", "except", "else"],
};

function setupEditor() {
  if (cm) return;
  cm = CodeMirror($("editor"), {
    mode: "python", lineNumbers: true, indentUnit: 4, tabSize: 4, indentWithTabs: false,
    smartIndent: true, matchBrackets: true, viewportMargin: Infinity,
    extraKeys: {
      Tab: (c) => {
        if (c.somethingSelected()) c.indentSelection("add");
        else c.replaceSelection(" ".repeat(4 - (c.getCursor().ch % 4)), "end");
      },
      "Shift-Tab": (c) => c.indentSelection("subtract"),
      Backspace: (c) => {
        const cur = c.getCursor(), before = c.getLine(cur.line).slice(0, cur.ch);
        if (!c.somethingSelected() && cur.ch > 0 && /^ +$/.test(before)) {
          c.replaceRange("", { line: cur.line, ch: Math.floor((cur.ch - 1) / 4) * 4 }, cur);
        } else return CodeMirror.Pass;
      },
      "Ctrl-S": () => doAction("save"),
    },
  });
  // Auto-dedent "else:", "elif ...:", "except ...:", "finally:" to the block they belong to.
  cm.on("inputRead", (c, ch) => {
    if (ch.text.length !== 1 || !ch.text[0].endsWith(":")) return;
    const ln = ch.from.line, m = c.getLine(ln).match(/^(\s*)(else|elif|except|finally)\b.*:\s*$/);
    if (!m) return;
    const cur = m[1].length;
    for (let i = ln - 1; i >= 0; i--) {
      const l = c.getLine(i), t = l.trim();
      if (!t || t.startsWith("#")) continue;
      const ind = l.length - l.trimStart().length;
      if (ind >= cur) continue;
      if (DEDENT_OPENERS[m[2]].includes(t.split(/[\s:(]/)[0])) c.replaceRange(" ".repeat(ind), { line: ln, ch: 0 }, { line: ln, ch: cur });
      return;
    }
  });
  cm.on("change", () => { refreshNavItem(current); $("save-state").textContent = isDirty(current) ? "Unsaved changes" : ""; });
}

/* ---------- question display ---------- */
function openQuestion(no) {
  if (current && docs[current] && no !== current && isDirty(current)) doAction("save", current, true);
  const prev = current;
  current = no;
  const q = EXAM.questions[no - 1];
  $("q-title").textContent = `Question ${q.no}: ${q.title}`;
  const n = EXAM.questions.length;
  $("mb-current").textContent = `Q${q.no} of ${n}: ${q.title}`;
  $("qnav-pos").textContent = `${q.no} / ${n}`;
  $("btn-prev").disabled = q.no <= 1;
  $("btn-next").disabled = q.no >= n;
  $("prev-label").textContent = q.no > 1 ? `${q.no - 1}. ${EXAM.questions[q.no - 2].title}` : "Previous";
  $("next-label").textContent = q.no < n ? `${q.no + 1}. ${EXAM.questions[q.no].title}` : "Next";
  if (narrow()) toggleNav(false);
  $("q-mark").textContent = `${fmt(q.mark)} mark${q.mark === 1 ? "" : "s"}`;
  $("q-text").innerHTML = q.html;        // written by the instructor
  renderExamples(q.examples);
  $("btn-fill").hidden = !q.answer;          // only present in instructor preview from XML
  cm.swapDoc(docs[no]);
  cm.refresh();
  renderResult(lastResult[no]);
  showWorth(no);
  $("save-state").textContent = isDirty(no) ? "Unsaved changes" : "";
  if (prev) refreshNavItem(prev);
  refreshNavItem(no);
  $("main").scrollTop = 0;
  if (!narrow()) cm.focus();              // on phones this would pop up the keyboard
}

function pre(text) { return el("pre", { text: text }); }

function renderExamples(examples) {
  const box = $("q-examples");
  box.textContent = "";
  if (!examples.length) return;
  const hasCode = examples.some((x) => x.testcode.trim()), hasIn = examples.some((x) => x.stdin.trim());
  const head = el("tr", {}, hasCode ? el("th", { text: "Test" }) : null, hasIn ? el("th", { text: "Input" }) : null, el("th", { text: "Result" }));
  const body = el("tbody");
  for (const x of examples) {
    body.append(el("tr", {}, hasCode ? el("td", {}, pre(x.testcode)) : null,
      hasIn ? el("td", {}, pre(x.stdin)) : null, el("td", {}, pre(x.expected))));
  }
  box.append(el("h3", { text: "For example" }), el("table", { class: "io" }, el("thead", {}, head), body));
}

function renderResult(r) {
  const box = $("result");
  box.textContent = "";
  if (!r) return;
  if (r.syntax_error) {
    const title = r.mode === "check" ? "Syntax error: your code could not run (this counts as a Check)" : "Syntax error: your code could not run";
    box.append(el("div", { class: "res bad" }, el("h4", { text: title }), el("pre", { class: "err", text: r.syntax_error })));
    return;
  }
  const shown = r.tests.filter((t) => t.show);
  const hasCode = shown.some((t) => t.testcode.trim()), hasIn = shown.some((t) => t.stdin.trim());
  const cols = 3 + (hasCode ? 1 : 0) + (hasIn ? 1 : 0);
  const head = el("tr", {}, el("th", { text: "" }), hasCode ? el("th", { text: "Test" }) : null,
    hasIn ? el("th", { text: "Input" }) : null, el("th", { text: "Expected" }), el("th", { text: "Got" }));
  const body = el("tbody");
  for (const t of r.tests) {
    const row = el("tr", { class: t.passed ? "pass" : "fail" }, el("td", { class: "mark", text: t.passed ? "✓" : "✗" }));
    if (t.show) {
      if (hasCode) row.append(el("td", {}, pre(t.testcode)));
      if (hasIn) row.append(el("td", {}, pre(t.stdin)));
      row.append(el("td", {}, pre(t.expected)), el("td", {}, pre(t.got)));
    } else {
      const td = el("td", { class: "hidden-row", text: `Hidden test ${t.n}: ${t.passed ? "passed" : "failed"}` });
      td.setAttribute("colspan", String(cols - 1));
      row.append(td);
    }
    body.append(row);
  }
  const ok = r.passed_all;
  let title, note = null;
  if (r.mode === "check") {
    const pen = r.penalty_pct ? ` (after ${fmt(r.penalty_pct)}% penalty)` : "";
    title = ok ? `Passed all tests. Marks: ${fmt(r.mark)} / ${fmt(r.max_mark)}${pen}` : `Not all tests passed. Marks: 0 / ${fmt(r.max_mark)}`;
    if (!ok) note = "Your code must pass every test, including hidden ones, to earn marks. You can change it and Check again.";
    if (r.repeat) note = "This code is the same as your previous Check, so it was not counted as a new try.";
  } else {
    title = ok ? "Pre-check passed (not graded)" : "Pre-check failed (not graded)";
  }
  const res = el("div", { class: "res " + (ok ? "ok" : "bad") }, el("h4", { text: title }),
    el("table", { class: "io" }, el("thead", {}, head), body));
  if (r.aborted) res.append(el("p", { text: "Testing stopped at the first error or time-out; the remaining tests were not run." }));
  if (note) res.append(el("p", { text: note }));
  box.append(res);
}

/* ---------- actions ---------- */
function setBusy(b, label) {
  busy = b;
  for (const id of ["btn-precheck", "btn-check", "btn-save", "btn-submit"]) $(id).disabled = b;
  if (label !== undefined) $("save-state").textContent = label;
}

async function doAction(kind, no = current, quiet = false) {
  if (submitting || (busy && !quiet)) return;
  const code = docs[no].getValue();
  if (!quiet) setBusy(true, kind === "save" ? "Saving..." : "Running tests...");
  try {
    const r = await api("/api/" + kind, { no, code });
    if (r.time_up) { applyStatus(r.status); return; }
    if (r.result) { lastResult[no] = r.result; if (no === current) renderResult(r.result); }
    applyStatus(r.status);
    if (!quiet) $("save-state").textContent = (EXAM.mode === "preview" ? "Done at " : "Saved at ") + new Date().toLocaleTimeString();
  } catch (e) {
    if (!quiet) $("save-state").textContent = "";
    alert(e.message);
  } finally {
    if (!quiet) setBusy(false);
    refreshNavItem(no);
  }
}
$("btn-precheck").addEventListener("click", () => doAction("precheck"));
$("btn-prev").addEventListener("click", () => { if (current > 1) openQuestion(current - 1); });
$("btn-next").addEventListener("click", () => { if (current < EXAM.questions.length) openQuestion(current + 1); });
$("btn-check").addEventListener("click", () => doAction("check"));
$("btn-save").addEventListener("click", () => doAction("save"));
$("btn-fill").addEventListener("click", () => {
  const q = EXAM.questions[current - 1];
  if (q.answer) { cm.setValue(q.answer); cm.focus(); }   // Ctrl+Z restores the previous code
});

/* ---------- confirmation dialog ---------- */
let modalAction = null;
function confirmBox(title, lines, okText, action) {
  $("modal-title").textContent = title;
  const body = $("modal-body");
  body.textContent = "";
  for (const l of lines) body.append(el("p", { text: l }));
  $("modal-ok").textContent = okText;
  modalAction = action;
  $("modal").hidden = false;
  $("modal-cancel").focus();
}
$("modal-cancel").addEventListener("click", () => { $("modal").hidden = true; });
$("modal-ok").addEventListener("click", () => { $("modal").hidden = true; if (modalAction) modalAction(); });

$("btn-submit").addEventListener("click", () => {
  const s = STATUS.summary;
  const pending = STATUS.questions.filter((q) => q.modified || isDirty(q.no)).length;
  const lines = [`Correct: ${s.correct}, wrong: ${s.wrong}, not attempted: ${s.not_attempted}. Marks so far: ${fmt(s.marks)} / ${fmt(s.max_marks)}.`];
  if (pending) lines.push(`${pending} answer(s) were changed after their last Check; they will be checked and graded now.`);
  lines.push(EXAM.mode === "exam" ? "After submitting you cannot change any answer." : "You can start over afterwards.");
  confirmBox("Submit?", lines, "Submit now", () => submitExam("student"));
});

async function submitExam(reason) {
  if (submitting) return;
  submitting = true;
  setBusy(true, "Submitting, grading remaining answers...");
  const codes = {};
  for (const no of Object.keys(docs)) codes[no] = docs[no].getValue();
  try {
    applyStatus((await api("/api/submit", { codes, reason })).status);
  } catch (e) {
    submitting = false;
    setBusy(false);
    alert(e.message);
  }
}

/* ---------- clock ---------- */
function tick() {
  if (!EXAM || !STATUS || STATUS.submitted) return;
  const t = $("tb-left");
  if (EXAM.deadline_epoch == null) {
    $("tb-clock-label").textContent = "Time";
    t.textContent = "No limit";
    t.className = "nolimit";
    return;
  }
  const left = Math.max(0, Math.round(EXAM.deadline_epoch - (Date.now() / 1000 + clockOffset)));
  const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60), s = left % 60;
  $("tb-clock-label").textContent = "Time left";
  t.textContent = `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  t.className = left <= 120 ? "urgent" : left <= 600 ? "soon" : "";
  if (left === 0) submitExam("time_up");
}

/* ---------- practice-only tools (web) ---------- */
function downloadProgress() {
  const { name, text } = WebBackend.exportProgress(docs);
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type: "application/json" })), download: name });
  document.body.append(a); a.click(); a.remove();
}
$("progress-file").addEventListener("change", async (ev) => {
  const f = ev.target.files[0];
  ev.target.value = "";
  if (!f) return;
  try {
    WebBackend.importProgress(await f.text());
    submitting = false;
    await loadExam();
    $("save-state").textContent = "Progress loaded from " + f.name;
  } catch (e) { alert(e.message); }
});
function startOver() {
  confirmBox("Start over?", ["All your answers for this question set will be cleared."], "Clear and start over", async () => {
    WebBackend.restart();
    submitting = false;
    for (const k of Object.keys(lastResult)) delete lastResult[k];
    await loadExam();
  });
}

/* ---------- done ---------- */
function showDone(status) {
  submitting = true;
  const s = status.summary;
  const exam = EXAM && EXAM.mode === "exam";
  $("done-heading").textContent = exam ? "Exam submitted" : "Finished";
  $("done-who").textContent = EXAM ? (exam ? `${EXAM.title}: ${EXAM.roll}, ${EXAM.name}` : EXAM.title) : "";
  $("done-reason").textContent = (status.submit_reason === "time_up" ? "Submitted automatically when time ran out" : "Submitted") +
    (status.submitted_at ? " at " + status.submitted_at.replace("T", " ") : "") + ".";
  $("done-marks").textContent = `${fmt(s.marks)} / ${fmt(s.max_marks)} marks`;
  const rows = $("done-rows");
  rows.textContent = "";
  const label = { correct: "Correct", wrong: "Wrong", not_attempted: "Not attempted" };
  for (const q of status.questions) {
    const title = EXAM ? EXAM.questions[q.no - 1].title : "";
    rows.append(el("tr", {}, el("td", { text: String(q.no) }), el("td", { text: title }),
      el("td", { class: "r-" + q.state, text: label[q.state] }), el("td", { text: `${fmt(q.marks)} / ${fmt(q.max_marks)}` })));
  }
  $("done-path").textContent = exam && EXAM.sol_path ? "Your answers are saved in " + EXAM.sol_path + ". You may close this window." : "";
  const acts = $("done-actions");
  acts.textContent = "";
  if (EXAM && EXAM.mode === "practice") {
    acts.append(el("button", { text: "Start over", onclick: startOver }), el("button", { text: "Other question sets", onclick: backToChoose }));
  } else if (EXAM && EXAM.mode === "preview") {
    acts.append(el("button", { text: "Open another bank", onclick: backToChoose }));
  }
  show("screen-done");
}

window.addEventListener("beforeunload", (e) => {
  if (EXAM && STATUS && !STATUS.submitted && Object.keys(docs).some((n) => isDirty(Number(n)))) {
    e.preventDefault();
    e.returnValue = "";
  }
});

init();
