"use strict";
/* lecture_instructor.js - instructor pages of the CS101 lecture system (only for the instructor's account;
   the server checks every request). Each page has its own address, so they can be open in separate tabs:
     #/instructor                 lectures: Start / Close, password, Mark as taught
     #/instructor/live/<session>  live dashboard of one lecture (refreshes every few seconds while active)
     #/instructor/attendance      the attendance sheet (+ CSV download)
     #/instructor/student/<email> one student's attendance
   The lecture itself (with "Show answer") is the normal lecture page, #/lec/<bundle>.
   Uses the helpers of lecture.js (api, el, $, state, store, setBar, fmt, questions, CFG). */

(() => {
  let timer = null;
  const NAMES_KEY = "lec:instr:names";
  const showNames = () => store.get(NAMES_KEY, true);
  const txt = (html) => { const d = document.createElement("div"); d.innerHTML = html || ""; return d.textContent.replace(/\s+/g, " ").trim(); };
  const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const who = (p) => (showNames() ? p.name + (p.roll ? ` (${p.roll})` : "") : (p.roll || "guest")) + (p.guest ? " [guest]" : "");
  const newTab = (href, text, cls = "") => el("a", { class: "btn " + cls, href, target: "_blank", rel: "noopener", text: text + " ↗" });

  function nav(current) {
    const link = (href, text, key) => el("a", { href, class: current === key ? "on" : "", text });
    return el("nav", { class: "inav" }, link("#/instructor", "Lectures", "home"), link("#/instructor/attendance", "Attendance", "att"),
      el("a", { href: "#/", text: "Student view" }));
  }

  function pageStart(current) {
    state.lec = null;
    setBar();
    $("view").className = "view wide";
    $("view").replaceChildren(nav(current));
  }

  /* ---------------------------------------------------------------- lectures (home) */
  async function home() {
    pageStart("home");
    const ov = await api("GET", "/api/admin/overview");
    const view = $("view");
    const off = ov.offering;
    const nextNo = Math.max(ov.first_lec_no - 1, ...ov.sessions.map((s) => s.lec_no)) + 1;
    view.append(el("p", { class: "muted", text: off
      ? `${off.title} · ${ov.roster_size} students on the roster · next lecture will be Lec ${nextNo} · auto-close after ${ov.auto_close_minutes} min`
      : "No course offering set up yet (upload a roster)." }));
    const active = ov.sessions.find((s) => s.active);
    if (active) {
      view.append(el("section", { class: "activebox" },
        el("div", { class: "ab-title", text: `Now: Lec ${active.lec_no}: ${active.bundle_title}` }),
        el("div", { class: "ab-meta", text: `started ${active.start} · ${active.present} present so far` }),
        el("div", { class: "ab-pass" }, el("span", { text: "Password" }), el("b", { text: active.password })),
        el("div", { class: "actions" },
          newTab(`#/instructor/live/${active.id}`, "Open dashboard", "primary"),
          newTab(`#/lec/${encodeURIComponent(active.bundle)}`, "Open the lecture (with answers)"),
          el("button", { class: "danger", text: "Close lecture", onclick: () => closeLecture(active) }))));
    }
    const rows = ov.bundles.map((b) => {
      const held = b.sessions.map((s) => el("a", { class: "held", href: `#/instructor/live/${s.id}`,
        text: `Lec ${s.lec_no} (${s.day} ${s.date}) · ${s.present} present${s.active ? " · ACTIVE" : ""}` }));
      if (b.released) held.unshift(el("span", { class: "muted", text: "taught before the system" }));
      const acts = [];
      if (!active) acts.push(el("button", { class: "small primary", text: b.sessions.length ? "Start again" : "Start", onclick: () => startLecture(b, nextNo) }));
      if (!b.sessions.length) acts.push(el("button", { class: "small", text: b.released ? "Unmark taught" : "Mark as taught",
        title: "Taught before the system: show it to students as a past lecture (practice), without attendance",
        onclick: async () => { await api("POST", "/api/admin/release", { bundles: [b.id], released: !b.released }); home(); } }));
      acts.push(newTab(`#/instructor/preview/${encodeURIComponent(b.id)}`, "Preview", "small"));
      return el("tr", { class: b.sessions.some((s) => s.active) ? "rowactive" : "" },
        el("td", { class: "num", text: String(b.ord) }),
        el("td", {}, el("div", { class: "bt", text: b.title }), el("div", { class: "muted small", text: `${b.id} · ${b.n_questions} questions` })),
        el("td", {}, held.length ? el("div", { class: "heldlist" }, held) : el("span", { class: "muted", text: "not yet" })),
        el("td", { class: "acts" }, acts));
    });
    view.append(el("h2", { text: "Lecture bundles" }),
      ov.bundles.length ? el("div", { class: "tablewrap" }, el("table", { class: "grid" },
        el("thead", {}, el("tr", {}, el("th", { text: "#" }), el("th", { text: "Bundle" }), el("th", { text: "Held" }), el("th", { text: "" }))),
        el("tbody", {}, rows))) : el("p", { class: "muted", text: "No bundles uploaded yet (tools/lecture_upload.py bundle ...)." }));
  }

  async function startLecture(b, nextNo) {
    if (!confirm(`Start Lec ${nextNo}: ${b.title}?\n\nA password is generated; students can join with it. Attendance is counted from now.`)) return;
    try {
      const r = await api("POST", "/api/admin/start", { bundle: b.id });
      home();
      window.open(`#/instructor/live/${r.session}`, "_blank", "noopener");
    } catch (e) { alert(e.message); }
  }

  async function closeLecture(s) {
    if (!confirm(`Close Lec ${s.lec_no}: ${s.bundle_title || s.title}?\n\nAnswers after this are not recorded; the lecture becomes practice for everyone.`)) return;
    try { await api("POST", "/api/admin/close", { session: s.id }); route(); } catch (e) { alert(e.message); }
  }

  /* ---------------------------------------------------------------- live dashboard */
  async function live(sessionId) {
    pageStart("live");
    const holder = el("div");
    $("view").append(holder);
    let snippets = null;
    const draw = async () => {
      let d;
      try { d = await api("GET", "/api/admin/live?session=" + sessionId); }
      catch (e) { holder.replaceChildren(el("p", { class: "err", text: e.message })); return; }
      if (!snippets) {
        try {
          const full = (await api("GET", "/api/admin/bundle?id=" + encodeURIComponent(d.session.bundle))).content;
          snippets = Object.fromEntries(questions(full).map((q) => [q.qid, short(q.title || txt(q.html), 90)]));
        } catch (e) { snippets = {}; }
      }
      holder.replaceChildren(...dashboard(d, snippets));
      clearTimeout(timer);
      if (d.session.active && location.hash === `#/instructor/live/${sessionId}`) timer = setTimeout(draw, 4000);
    };
    await draw();
  }

  function dashboard(d, snippets) {
    const s = d.session;
    const elapsed = Math.max(0, Math.round(((s.closed_at || d.server_now) - s.started_at) / 60000));
    const pass = el("b", { class: "pw", text: s.password });
    const head = el("section", { class: "dhead" },
      el("div", { class: "dh-left" },
        el("div", { class: "dh-title", text: `Lec ${s.lec_no}: ${s.title}` }),
        el("div", { class: "muted", text: `${s.date} · ${s.start}–${s.close || "now"} · ${s.active ? "ACTIVE" : "closed"}` })),
      s.active ? el("div", { class: "dh-pass" }, el("span", { text: "Password" }), pass) : null,
      el("div", { class: "tiles" },
        tile("Present", `${d.present}`, `of ${d.roster_size} on the roster` + (d.guests_present ? ` + ${d.guests_present} guest${d.guests_present > 1 ? "s" : ""}` : "")),
        tile("Joined", `${d.joined}`, d.guests.length ? `+ ${d.guests.length} guest${d.guests.length > 1 ? "s" : ""}` : "students"),
        tile("Time", `${elapsed} min`, s.active ? "since start" : "lecture length")));
    const tools = el("div", { class: "actions" },
      el("label", { class: "toggle" }, el("input", { type: "checkbox", checked: showNames(), onchange: (e) => { store.set(NAMES_KEY, e.target.checked); route(); } }),
        " show names (off: roll numbers only, for the projector)"),
      s.active ? newTab(`#/lec/${encodeURIComponent(s.bundle)}`, "Open the lecture (with answers)", "small") : null,
      s.active ? el("button", { class: "small danger", text: "Close lecture", onclick: () => closeLecture(s) }) : null);

    const legend = el("div", { class: "legend" }, el("span", {}, el("i", { class: "sw right" }), "✓ right"),
      el("span", {}, el("i", { class: "sw wrong" }), "✗ wrong (not yet right)"), el("span", {}, el("i", { class: "sw none" }), "– not attempted (of those present)"));
    const qrows = d.questions.map((q) => {
      const total = Math.max(q.right + q.wrong + q.not_attempted, 1);
      const seg = (n, cls) => (n ? el("span", { class: "seg " + cls, style: `width:${(100 * n) / total}%` }) : null);
      const tip = `${q.right} right, ${q.wrong} wrong, ${q.not_attempted} not attempted`;
      const first = q.first.length
        ? el("ol", { class: "first" }, q.first.map((f, i) => el("li", { class: i < 3 ? "top" : "", text: `${who(f)} · ${f.time}` })))
        : el("p", { class: "muted small", text: "Nobody has solved it yet." });
      const details = el("details", {}, el("summary", { text: q.first.length ? `First solvers: ${q.first.slice(0, 3).map((f) => who(f)).join(", ")}${q.first.length > 3 ? ", ..." : ""}` : "First solvers: none yet" }), first);
      return el("div", { class: "qrow" },
        el("div", { class: "qr-head" }, el("b", { text: `Q${q.no}` }), el("span", { class: "muted", text: q.type }), el("span", { class: "qr-text", text: snippets[q.qid] || "" })),
        el("div", { class: "qr-bar" },
          el("div", { class: "bar", title: tip, role: "img", "aria-label": tip }, seg(q.right, "right"), seg(q.wrong, "wrong"), seg(q.not_attempted, "none")),
          el("div", { class: "counts", text: `✓ ${q.right}   ✗ ${q.wrong}   – ${q.not_attempted}` })),
        details);
    });
    const lb = d.leaderboard.length ? el("div", { class: "tablewrap" }, el("table", { class: "grid lb" },
      el("thead", {}, el("tr", {}, el("th", { text: "#" }), el("th", { text: "Student" }), el("th", { text: "Solved" }), el("th", { text: "Score" }), el("th", { text: "Reached at" }))),
      el("tbody", {}, d.leaderboard.map((x, i) => el("tr", { class: i < 3 ? "top" : "" },
        el("td", { class: "num", text: String(i + 1) }), el("td", { text: who(x) }), el("td", { class: "num", text: `${x.solved}/${s.n_questions}` }),
        el("td", { class: "num", text: fmt(x.score) }), el("td", { class: "num", text: x.reached }))))))
      : el("p", { class: "muted", text: "No correct answers yet." });
    const guests = d.guests.length ? el("details", { class: "guests" }, el("summary", { text: `${d.guests.length} guest${d.guests.length > 1 ? "s" : ""} (iitgoa accounts not on the roster; counted in the bars, not in Present)` }),
      el("ul", {}, d.guests.map((g) => el("li", { text: `${g.name} <${g.email}> · solved ${g.solved}` })))) : null;
    return [head, tools, el("h2", { text: "Questions" }), legend, ...qrows, el("h2", { text: "Leaderboard (top 20; ties: who got there first)" }), lb, guests].filter(Boolean);
  }

  const tile = (label, value, sub) => el("div", { class: "tile" }, el("div", { class: "t-label", text: label }), el("div", { class: "t-value", text: value }), el("div", { class: "t-sub", text: sub }));

  /* ---------------------------------------------------------------- attendance */
  let sheetCache = null;
  async function attendance() {
    pageStart("att");
    const sheet = sheetCache = await api("GET", "/api/admin/attendance");
    const view = $("view");
    const nGuests = sheet.students.filter((st) => st.guest).length, nRoster = sheet.students.length - nGuests;
    const filter = el("input", { type: "text", placeholder: "Filter by name, roll number or email", class: "filter" });
    const dl = el("button", { class: "primary", text: "Download CSV", onclick: downloadCsv });
    view.append(el("div", { class: "actions" }, filter, dl,
      el("span", { class: "muted", text: `${nRoster} students${nGuests ? ` + ${nGuests} guest${nGuests > 1 ? "s" : ""}` : ""} · ${sheet.lectures.length} lectures recorded (Lec ${sheet.lectures.map((l) => l.lec_no).join(", ") || "none yet"})` })));
    const L = sheet.lectures;
    const head = el("tr", {}, el("th", { class: "sticky", text: "Roll" }), el("th", { class: "sticky2", text: "Name" }),
      L.map((l) => el("th", { class: "lcol" }, el("a", { href: `#/instructor/live/${l.session}`, text: `Lec ${l.lec_no}` }),
        el("div", { class: "small muted", text: `${l.day} ${l.date}` }), el("div", { class: "small", text: `${l.present} present` }),
        l.guests ? el("div", { class: "small muted", text: `+ ${l.guests} guest${l.guests > 1 ? "s" : ""}` }) : null)),
      el("th", { text: "Attended" }), el("th", { text: "Avg score" }));
    const body = el("tbody");
    const draw = () => {
      const f = filter.value.trim().toLowerCase();
      body.replaceChildren(...sheet.students.filter((st) => !f || st.name.toLowerCase().includes(f) || st.roll.includes(f) || st.email.includes(f)).map((st) =>
        el("tr", { class: st.guest ? "guestrow" : "" }, el("td", { class: "sticky num", text: st.guest ? "guest" : st.roll }),
          el("td", { class: "sticky2" }, el("a", { href: `#/instructor/student/${encodeURIComponent(st.email)}`, text: st.guest ? st.email : st.name, title: st.guest ? st.name : st.email })),
          st.cells.map((c) => el("td", { class: "cell " + (c.present ? "p" : "a"),
            title: c.joined ? `joined ${c.joined_at}, last ${c.last_seen}, IP ${c.ip}, solved ${c.solved}` : "did not join",
            text: c.present ? `P ${fmt(c.score)}` : "A" })),
          el("td", { class: "num", text: `${st.attended}/${L.length}` }), el("td", { class: "num", text: fmt(st.average_score) }))));
    };
    filter.addEventListener("input", draw);
    draw();
    view.append(el("div", { class: "tablewrap sheet" }, el("table", { class: "grid att" }, el("thead", {}, head), body)),
      el("p", { class: "muted small", text: "P = present (joined the active lecture and attempted at least one question), with the participation score out of 10; A = absent. Hover a cell for join and last-seen times and the IP address. Guests (iitgoa accounts not on the roster) are listed at the end by email." }));
  }

  async function downloadCsv() {
    const r = await fetch(CFG.backend + "/api/admin/attendance.csv", { headers: { Authorization: "Bearer " + store.get("lec:token") } });
    if (!r.ok) return alert("Download failed.");
    const a = el("a", { href: URL.createObjectURL(await r.blob()), download: `attendance_${(sheetCache || {}).offering || "lectures"}.csv` });
    document.body.append(a); a.click(); a.remove();
  }

  async function student(email) {
    pageStart("att");
    const sheet = sheetCache || await api("GET", "/api/admin/attendance");
    const st = sheet.students.find((s) => s.email === email);
    if (!st) return $("view").append(el("p", { class: "err", text: "Not on the roster and never joined: " + email }));
    $("view").append(el("h2", { text: st.guest ? `${st.name} (guest, not on the roster)` : `${st.name} (${st.roll})` }),
      el("p", { class: "muted", text: `${st.email} · attended ${st.attended} of ${sheet.lectures.length} · average participation score ${fmt(st.average_score)} / 10` }),
      el("div", { class: "tablewrap" }, el("table", { class: "grid" },
        el("thead", {}, el("tr", {}, ["Lecture", "Date", "Present", "Score", "Solved", "Joined", "Last seen", "IP"].map((h) => el("th", { text: h })))),
        el("tbody", {}, sheet.lectures.map((l, i) => {
          const c = st.cells[i];
          return el("tr", {}, el("td", {}, el("a", { href: `#/instructor/live/${l.session}`, text: `Lec ${l.lec_no}: ${l.title}` })),
            el("td", { text: `${l.day} ${l.date}` }), el("td", { class: "cell " + (c.present ? "p" : "a"), text: c.present ? "P" : "A" }),
            el("td", { class: "num", text: fmt(c.score) }), el("td", { class: "num", text: String(c.solved) }),
            el("td", { text: c.joined_at }), el("td", { text: c.last_seen }), el("td", { class: "small", text: c.ip }));
        })))));
  }

  /* ---------------------------------------------------------------- preview a bundle (any state) */
  async function preview(bundleId) {
    const full = (await api("GET", "/api/admin/bundle?id=" + encodeURIComponent(bundleId))).content;
    $("view").className = "view";
    const key = `lec:prog:${bundleId}:preview`;
    const saved = store.get(key, { answers: {}, status: {} });
    state.lec = { active: false, bundle: bundleId, title: full.title + " (preview)", content: full, full, answers: saved.answers, status: saved.status, key };
    await renderLecture();
  }

  /* ---------------------------------------------------------------- routing */
  async function route() {
    clearTimeout(timer);
    const h = location.hash;
    let m;
    if ((m = h.match(/^#\/instructor\/live\/(\d+)$/))) return live(Number(m[1]));
    if (h === "#/instructor/attendance") return attendance();
    if ((m = h.match(/^#\/instructor\/student\/(.+)$/))) return student(decodeURIComponent(m[1]));
    if ((m = h.match(/^#\/instructor\/preview\/(.+)$/))) return preview(decodeURIComponent(m[1]));
    return home();
  }

  window.Instructor = { route };
  window.addEventListener("hashchange", () => { if (!location.hash.startsWith("#/instructor")) { clearTimeout(timer); $("view").className = "view"; } });
})();
