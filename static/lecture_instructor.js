"use strict";
/* lecture_instructor.js - instructor pages of the CS101 lecture system (only for the instructor's account;
   the server checks every request). Each page has its own address and the menu opens them in new tabs:
     #/instructor                 Lectures: Start / Close, password, add a topic, Mark as taught, Preview
     #/instructor/live/<session>  dashboard of one lecture: open questions, Final submit, bars, and (with
                                  "Details", off by default, for the instructor's own device) names
     #/instructor/attendance      Attendance: the sheet (+ CSV download)
     #/instructor/student/<email> one student's attendance
     #/instructor/questions       Questions: the active lecture with "Open for students" and "Show answer"
     #/instructor/preview/<id>    any bundle with "Show answer"
   Uses the helpers of lecture.js (api, el, $, state, fresh, store, setBar, fmt, fmt1, questions, fullTitle,
   CFG, enterLive, renderLecture, showList, modal). */

(() => {
  let timer = null;
  const newTab = (href, text, cls = "") => el("a", { class: "btn " + cls, href, target: "_blank", rel: "noopener", text: text + " ↗" });
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const DETAILS_KEY = "lec:details";       // per device: names on the dashboard (never on the projector)

  function nav(current) {
    const link = (href, text, key) => el("a", { href, class: current === key ? "on" : "", target: "_blank", rel: "noopener", text });
    return el("nav", { class: "inav" }, link("#/instructor", "Lectures", "home"), link("#/instructor/attendance", "Attendance", "att"),
      link("#/instructor/questions", "Questions", "questions"));
  }

  function pageStart(current) {
    state.lec = null;
    setBar();
    $("view").className = "view wide";
    $("view").replaceChildren(nav(current));
  }

  const act = async (path, body) => { try { const r = await api("POST", path, body); return r; } catch (e) { alert(e.message); return null; } };

  /* ---------------------------------------------------------------- lectures (home) */
  async function home(g) {
    pageStart("home");
    const ov = await api("GET", "/api/admin/overview");
    if (!fresh(g)) return;
    const view = $("view");
    const off = ov.offering;
    const nextNo = Math.max(ov.first_lec_no - 1, ...ov.sessions.map((s) => s.lec_no)) + 1;
    view.append(el("p", { class: "muted", text: off
      ? `${off.title} · ${ov.roster_size} students on the roster · next lecture will be Lec ${nextNo} · auto-close after ${ov.auto_close_minutes} min`
      : "No course offering set up yet (upload a roster)." }));
    const active = ov.sessions.find((s) => s.active);
    if (active) {
      view.append(el("section", { class: "activebox" },
        el("div", { class: "ab-title", text: `Now: Lec ${active.lec_no} · ${active.title}` }),
        el("div", { class: "ab-meta", text: `started ${active.start} · ${active.n_open} question${active.n_open === 1 ? "" : "s"} open · ${active.present} present so far`
          + (active.submit_open ? " · Final submit open" : "") }),
        el("div", { class: "ab-pass" }, el("span", { text: "Password" }), el("b", { text: active.password })),
        el("div", { class: "actions" },
          newTab(`#/instructor/live/${active.id}`, "Open dashboard", "primary"),
          newTab("#/instructor/questions", "Questions"),
          el("button", { class: "danger", text: "Close lecture", onclick: () => closeLecture(active) }))));
    }
    const rows = ov.bundles.map((b) => {
      const inActive = active && active.parts.some((p) => p.bundle === b.id);
      const held = b.sessions.map((s) => el("a", { class: "held", href: `#/instructor/live/${s.id}`, target: "_blank", rel: "noopener",
        text: `Lec ${s.lec_no} (${s.day} ${s.date}) · ${s.opened_here} q · ${s.present} present${s.active ? " · ACTIVE" : ""}` }));
      if (b.released) held.unshift(el("span", { class: "muted", text: "taught before the system" }));
      const acts = [];
      if (!active) acts.push(el("button", { class: "small primary", text: b.sessions.length ? "Start again" : "Start", onclick: () => startLecture(b, nextNo) }));
      else if (!inActive && !active.submit_open) acts.push(el("button", { class: "small primary", text: "Add to Lec " + active.lec_no, title: "Continue the running lecture with this topic",
        onclick: async () => { if (confirm(`Add ${fullTitle(b)} to Lec ${active.lec_no}?`) && await act("/api/admin/add-bundle", { session: active.id, bundle: b.id })) route(); } }));
      acts.push(el("button", { class: "small", text: b.released ? "Unmark taught" : "Mark as taught",
        title: "Taught before the system: show it to students as a past lecture (practice), without attendance",
        onclick: async () => { await api("POST", "/api/admin/release", { bundles: [b.id], released: !b.released }); route(); } }));
      acts.push(newTab(`#/instructor/preview/${encodeURIComponent(b.id)}`, "Preview", "small"));
      return el("tr", { class: inActive ? "rowactive" : "" },
        el("td", { class: "num", text: b.number || String(b.ord) }),
        el("td", {}, el("div", { class: "bt", text: b.title }),
          el("div", { class: "muted small", text: `${b.id} · ${b.n_questions} questions` + (b.covered && !b.released ? ` · ${b.covered} opened so far` : "") })),
        el("td", {}, held.length ? el("div", { class: "heldlist" }, held) : el("span", { class: "muted", text: "not yet" })),
        el("td", { class: "acts" }, acts));
    });
    view.append(el("h2", { text: "Lecture bundles" }),
      ov.bundles.length ? el("div", { class: "tablewrap" }, el("table", { class: "grid" },
        el("thead", {}, el("tr", {}, el("th", { text: "Topic" }), el("th", { text: "Bundle" }), el("th", { text: "Held" }), el("th", { text: "" }))),
        el("tbody", {}, rows))) : el("p", { class: "muted", text: "No bundles uploaded yet (tools/lecture_upload.py bundle ...)." }));

    // every lecture instance, with Delete for ones started by mistake
    const held = ov.sessions.slice().reverse();
    view.append(el("h2", { text: "Lectures held" }),
      held.length ? el("div", { class: "tablewrap" }, el("table", { class: "grid" },
        el("thead", {}, el("tr", {}, ["Lec", "Topics", "Date", "Start - close", "Questions", "Present", ""].map((h) => el("th", { text: h })))),
        el("tbody", {}, held.map((s) => el("tr", { class: s.active ? "rowactive" : "" },
          el("td", { class: "num", text: String(s.lec_no) }),
          el("td", { text: s.title }),
          el("td", { text: `${s.day} ${s.date}` }),
          el("td", { text: `${s.start} - ${s.close || "now (active)"}` }),
          el("td", { class: "num", text: String(s.n_open) }),
          el("td", { class: "num", text: String(s.present) }),
          el("td", { class: "acts" }, newTab(`#/instructor/live/${s.id}`, "Dashboard", "small"),
            el("button", { class: "small danger", text: "Delete", onclick: () => deleteLecture(s) })))))))
        : el("p", { class: "muted", text: "None yet." }));
  }

  async function deleteLecture(s) {
    if (!confirm(`Delete Lec ${s.lec_no} (${s.title}, ${s.day} ${s.date}, ${s.present} present)?\n\n`
      + "Its attendance, joins and results are removed for good. Use this only for a lecture started by mistake.")) return;
    if (await act("/api/admin/delete-session", { session: s.id })) route();
  }

  async function startLecture(b, nextNo) {
    if (!confirm(`Start Lec ${nextNo}: ${fullTitle(b)}?\n\nA password is generated; students can join with it. Questions open only when you open them.`)) return;
    const r = await act("/api/admin/start", { bundle: b.id });
    if (!r) return;
    route();
    window.open(`#/instructor/live/${r.session}`, "_blank", "noopener");
  }

  async function closeLecture(s) {
    if (!confirm(`Close Lec ${s.lec_no}: ${s.title}?\n\nResults after this are not recorded; the questions opened become practice for everyone.`)) return;
    if (await act("/api/admin/close", { session: s.id })) route();
  }

  /* ---------------------------------------------------------------- questions: the active lecture with answers */
  async function questionsPage(g) {
    const ov = await api("GET", "/api/admin/overview");
    if (!fresh(g)) return;
    const active = ov.sessions.find((s) => s.active);
    if (!active) return showList();
    await enterLive(active.password, g);
  }

  /* ---------------------------------------------------------------- live dashboard */
  async function live(sessionId, g) {
    pageStart("live");
    const holder = el("div");
    $("view").append(holder);
    const draw = async () => {
      let d;
      try { d = await api("GET", "/api/admin/live?session=" + sessionId); }
      catch (e) { if (fresh(g)) holder.replaceChildren(el("p", { class: "err", text: e.message })); return; }
      if (!fresh(g)) return;
      // keep the expanded lists expanded across refreshes
      const open = new Set([...holder.querySelectorAll("details[open]")].map((x) => x.dataset.key));
      holder.replaceChildren(...dashboard(d, draw));
      holder.querySelectorAll("details").forEach((x) => { if (open.has(x.dataset.key)) x.open = true; });
      clearTimeout(timer);
      if (d.session.active) timer = setTimeout(draw, 4000);
    };
    await draw();
  }

  function dashboard(d, redraw) {
    const s = d.session;
    const details = !!store.get(DETAILS_KEY, false);
    const elapsed = Math.max(0, Math.round(((s.closed_at || d.server_now) - s.started_at) / 60000));
    const frac = d.roster_size ? d.present / d.roster_size : 0;
    const presentTile = el("div", { class: "tile wide" }, el("div", { class: "t-label", text: "Present" }),
      el("div", { class: "t-value" }, `${d.present}`, el("span", { class: "t-of", text: ` / ${d.roster_size}` })),
      el("div", { class: "pbar", role: "img", "aria-label": `${Math.round(100 * frac)}% of the roster present`, title: `${Math.round(100 * frac)}% of the students on the roster` },
        el("span", { style: `width:${100 * frac}%` })),
      el("div", { class: "t-sub", text: `${Math.round(100 * frac)}% of the roster` + (d.guests_present ? ` · + ${plural(d.guests_present, "guest")}` : "") }));
    const post = (path, body) => async () => { if (await act(path, body)) redraw(); };
    const controls = s.active ? el("div", { class: "dh-acts" },
      s.submit_open ? null : el("button", { class: "primary", text: "Open next question", onclick: post("/api/admin/open-next", { session: s.id }) }),
      s.submit_open ? el("span", { class: "chip ok", text: `Final submit open since ${s.submit_opened}` })
        : el("button", { text: "Open Final submit", onclick: async () => {
          if (confirm("Open Final submit now?\n\nAfter this no more questions or topics can be opened in this lecture.")) await post("/api/admin/open-submit", { session: s.id })();
        } }),
      el("button", { class: "danger", text: "Close lecture", onclick: async () => {
        if (confirm(`Close Lec ${s.lec_no}?\n\nResults after this are not recorded.`) && await act("/api/admin/close", { session: s.id })) redraw();
      } })) : null;
    const head = el("section", { class: "dhead" },
      el("div", { class: "dh-left" },
        el("div", { class: "dh-title", text: s.title }),
        el("div", { class: "dh-lec" }, el("b", { text: `Lec ${s.lec_no}` }),
          s.other_lec_nos.length ? el("span", { class: "muted", text: ` · these topics also in Lec ${s.other_lec_nos.join(", ")}` }) : null),
        el("div", { class: "muted", text: `${s.date} · started ${s.start}${s.close ? ` · closed ${s.close}` : ""} · ${s.active ? "ACTIVE" : "closed"}` })),
      el("div", { class: "tiles" },
        presentTile,
        tile("Joined", `${d.joined}`, d.guests.length ? `+ ${plural(d.guests.length, "guest")}` : "students"),
        tile("Open", `${s.n_open}`, "questions"),
        s.submit_open || d.submitted ? tile("Submitted", `${d.submitted}`, "students") : null,
        tile("Time", `${elapsed} min`, s.active ? "since start" : "lecture length")),
      controls);

    const toggle = el("label", { class: "toggle" }, el("input", { type: "checkbox", checked: details, onchange: (ev) => { store.set(DETAILS_KEY, ev.target.checked); redraw(); } }), "Details");
    const legend = el("div", { class: "legend" }, el("span", {}, el("i", { class: "sw right" }), "✓ right"),
      el("span", {}, el("i", { class: "sw wrong" }), "✗ wrong (not yet right)"), el("span", {}, el("i", { class: "sw none" }), "○ not attempted (of those who joined)"), toggle);
    const names = (key, title, list) => el("details", { "data-key": key }, el("summary", { text: `${title} (${list.length})` }),
      list.length ? el("p", { class: "names", text: list.join(", ") }) : el("p", { class: "muted small", text: "none" }));
    const blocks = [];
    for (const p of d.parts) {
      if (d.parts.length > 1) blocks.push(el("h3", { class: "dpart", text: fullTitle(p) }));
      for (const q of p.questions) {
        const total = Math.max(q.right + q.wrong + q.not_attempted, 1);
        const seg = (n, cls) => (n ? el("span", { class: "seg " + cls, style: `width:${(100 * n) / total}%` }) : null);
        const tip = `${q.right} right, ${q.wrong} wrong, ${q.not_attempted} not attempted`;
        const k = q.bundle + "/" + q.qid;
        const status = q.open ? el("span", { class: "chip ok", text: `open ${q.opened}` })
          : s.active && !s.submit_open ? el("button", { class: "small", text: "Open", onclick: post("/api/admin/open", { session: s.id, bundle: q.bundle, qid: q.qid }) })
            : el("span", { class: "chip", text: "not opened" });
        blocks.push(el("div", { class: "qrow" + (q.open ? "" : " closedq") },
          el("div", { class: "qr-head" }, el("b", { text: `Q${q.no}` }), el("span", { class: "muted", text: q.type }), el("span", { class: "qr-text", text: q.text }),
            q.earlier.length ? el("span", { class: "chip", text: `done in Lec ${q.earlier.join(", ")}` }) : null, status),
          q.open ? el("div", { class: "qr-bar" },
            el("div", { class: "bar", title: tip, role: "img", "aria-label": tip }, seg(q.right, "right"), seg(q.wrong, "wrong"), seg(q.not_attempted, "none")),
            el("div", { class: "counts", text: `✓ ${q.right}   ✗ ${q.wrong}   ○ ${q.not_attempted}` })) : null,
          q.open && details ? el("div", { class: "lists" }, names("r-" + k, "Correct", q.names.right), names("w-" + k, "Wrong", q.names.wrong),
            names("n-" + k, "Not attempted", q.names.not_attempted)) : null));
      }
    }
    const extra = details ? [el("div", { class: "lists bottom" }, names("inactive", "Inactive", d.inactive),
      d.guests.length ? names("guests", "Guests", d.guests.map((x) => `${x.name} <${x.email}>`)) : null)] : [];
    return [head, el("h2", { text: "Questions" }), legend, ...blocks, ...extra].filter(Boolean);
  }

  const tile = (label, value, sub) => el("div", { class: "tile" }, el("div", { class: "t-label", text: label }), el("div", { class: "t-value", text: value }), el("div", { class: "t-sub", text: sub }));

  /* ---------------------------------------------------------------- attendance */
  let sheetCache = null;
  async function attendance(g) {
    pageStart("att");
    const sheet = sheetCache = await api("GET", "/api/admin/attendance");
    if (!fresh(g)) return;
    const view = $("view");
    const nGuests = sheet.students.filter((st) => st.guest).length, nRoster = sheet.students.length - nGuests;
    const filter = el("input", { type: "text", placeholder: "Filter by name, roll number or email", class: "filter" });
    const dl = el("button", { class: "primary", text: "Download CSV", onclick: downloadCsv });
    view.append(el("div", { class: "actions" }, filter, dl,
      el("span", { class: "muted", text: `${nRoster} students${nGuests ? ` + ${plural(nGuests, "guest")}` : ""} · ${sheet.lectures.length} lectures recorded (Lec ${sheet.lectures.map((l) => l.lec_no).join(", ") || "none yet"})` })));
    const L = sheet.lectures;
    const head = el("tr", {}, el("th", { class: "sticky", text: "Roll" }), el("th", { class: "sticky2", text: "Name" }),
      L.map((l) => el("th", { class: "lcol", title: l.title }, el("a", { href: `#/instructor/live/${l.session}`, target: "_blank", rel: "noopener", text: `Lec ${l.lec_no}` }),
        el("div", { class: "small muted", text: `${l.day} ${l.date}` }), el("div", { class: "small", text: `${l.present} present · ${l.questions} q` }),
        l.guests ? el("div", { class: "small muted", text: `+ ${plural(l.guests, "guest")}` }) : null)),
      el("th", { text: "Attended" }), el("th", { text: "Lecture score" }));
    const body = el("tbody");
    const draw = () => {
      const f = filter.value.trim().toLowerCase();
      body.replaceChildren(...sheet.students.filter((st) => !f || st.name.toLowerCase().includes(f) || st.roll.includes(f) || st.email.includes(f)).map((st) =>
        el("tr", { class: st.guest ? "guestrow" : "" }, el("td", { class: "sticky num", text: st.guest ? "guest" : st.roll }),
          el("td", { class: "sticky2" }, el("a", { href: `#/instructor/student/${encodeURIComponent(st.email)}`, text: st.guest ? st.email : st.name, title: st.guest ? st.name : st.email })),
          st.cells.map((c) => el("td", { class: "cell " + (c.present ? "p" : "a"),
            title: c.joined ? `joined ${c.joined_at}, last ${c.last_seen}${c.submitted ? `, submitted ${c.submitted}` : ", not submitted"}, IP ${c.ip}, solved ${c.solved}` : "did not join",
            text: c.present ? `P ${fmt(c.score)}/${c.out_of}` : "A" })),
          el("td", { class: "num", text: `${st.attended}/${L.length}` }), el("td", { class: "num", text: `${fmt(st.total_score)}/${st.total_possible}` }))));
    };
    filter.addEventListener("input", draw);
    draw();
    view.append(el("div", { class: "tablewrap sheet" }, el("table", { class: "grid att" }, el("thead", {}, head), body)),
      el("p", { class: "muted small", text: "P = present (answered at least one question before the lecture closed), with the score (penalties applied) out of the questions opened; A = absent. Hover a cell for join, last-seen and submit times and the IP address. Guests (iitgoa accounts not on the roster) are listed at the end by email." }));
  }

  async function downloadCsv() {
    const r = await fetch(CFG.backend + "/api/admin/attendance.csv", { headers: { Authorization: "Bearer " + store.get("lec:token") } });
    if (!r.ok) return alert("Download failed.");
    const a = el("a", { href: URL.createObjectURL(await r.blob()), download: `attendance_${(sheetCache || {}).offering || "lectures"}.csv` });
    document.body.append(a); a.click(); a.remove();
  }

  async function student(email, g) {
    pageStart("att");
    const sheet = sheetCache || await api("GET", "/api/admin/attendance");
    if (!fresh(g)) return;
    const st = sheet.students.find((s) => s.email === email);
    if (!st) return $("view").append(el("p", { class: "err", text: "Not on the roster and never joined: " + email }));
    $("view").append(el("h2", { text: st.guest ? `${st.name} (guest, not on the roster)` : `${st.name} (${st.roll})` }),
      el("p", { class: "muted", text: `${st.email} · attended ${st.attended} of ${sheet.lectures.length} · lecture score ${fmt(st.total_score)} / ${st.total_possible}` }),
      el("div", { class: "tablewrap" }, el("table", { class: "grid" },
        el("thead", {}, el("tr", {}, ["Lecture", "Date", "Present", "Score", "Solved", "Joined", "Last seen", "Submitted", "IP"].map((h) => el("th", { text: h })))),
        el("tbody", {}, sheet.lectures.map((l, i) => {
          const c = st.cells[i];
          return el("tr", {}, el("td", {}, el("a", { href: `#/instructor/live/${l.session}`, text: `Lec ${l.lec_no}: ${l.title}` })),
            el("td", { text: `${l.day} ${l.date}` }), el("td", { class: "cell " + (c.present ? "p" : "a"), text: c.present ? "P" : "A" }),
            el("td", { class: "num", text: `${fmt(c.score)}/${c.out_of}` }), el("td", { class: "num", text: String(c.solved) }),
            el("td", { text: c.joined_at }), el("td", { text: c.last_seen }), el("td", { text: c.submitted }), el("td", { class: "small", text: c.ip }));
        })))));
  }

  /* ---------------------------------------------------------------- preview a bundle (any state) */
  async function preview(bundleId, g) {
    const full = (await api("GET", "/api/admin/bundle?id=" + encodeURIComponent(bundleId))).content;
    if (!fresh(g)) return;
    const key = `lec:prog:${bundleId}:preview`;
    const saved = store.get(key, { answers: {}, status: {} });
    state.lec = { mode: "preview", parts: [{ id: bundleId, number: full.number || "", title: full.title, content: full, full }],
      answers: saved.answers || {}, status: saved.status || {}, cur: saved.cur, key };
    await renderLecture(g);
  }

  /* ---------------------------------------------------------------- routing */
  async function route(g) {
    clearTimeout(timer);
    if (g === undefined) g = ++state.gen;
    const h = location.hash;
    let m;
    if ((m = h.match(/^#\/instructor\/live\/(\d+)$/))) return live(Number(m[1]), g);
    if (h === "#/instructor/attendance") return attendance(g);
    if (h === "#/instructor/questions") return questionsPage(g);
    if ((m = h.match(/^#\/instructor\/student\/(.+)$/))) return student(decodeURIComponent(m[1]), g);
    if ((m = h.match(/^#\/instructor\/preview\/(.+)$/))) return preview(decodeURIComponent(m[1]), g);
    return home(g);
  }

  window.Instructor = { route };
  window.addEventListener("hashchange", () => { if (!location.hash.startsWith("#/instructor")) clearTimeout(timer); });
})();
