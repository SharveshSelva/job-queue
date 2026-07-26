/* The queue — reads data/jobs.json (refreshed by GitHub Actions),
   keeps triage decisions in localStorage. No backend at runtime. */

const KEY = "jobqueue.v1";
const DAY = 864e5;

const SEEN_KEY = "jobqueue.lastOpen";

const state = {
  jobs: [], updated: null,
  lastOpen: Number(localStorage.getItem(SEEN_KEY)) || 0,
  decisions: load(),
  tab: "queue", mode: "cards",
  remote: false, fresh: false, minPay: 0,
};

function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(state.decisions)); }
  catch { toast("Storage full — decision not saved"); }
}

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const age = d => Math.floor((Date.now() - new Date(d)) / DAY);
const ago = d => { const n = age(d); return n <= 0 ? "today" : n === 1 ? "yesterday"
  : n < 30 ? n + "d" : n < 365 ? Math.floor(n / 30) + "mo" : Math.floor(n / 365) + "y"; };
const inr = n => "₹" + (n >= 1000 ? Math.round(n / 1000) + "k" : n);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

/* ------------------------------ data ------------------------------ */
async function loadJobs(bustCache = false) {
  const url = "data/jobs.json" + (bustCache ? "?t=" + Date.now() : "");
  try {
    const res = await fetch(url, { cache: bustCache ? "reload" : "default" });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    state.jobs = data.jobs || [];
    state.updated = data.updated;
  } catch {
    if (!state.jobs.length) toast("No connection and nothing cached yet");
  }
  render();
}

/* Quietly pull a newer file after first paint. Never blocks the UI. */
async function refreshInBackground() {
  try {
    const res = await fetch("data/jobs.json?t=" + Date.now(), { cache: "reload" });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.jobs) return;
    const before = state.jobs.length;
    state.jobs = data.jobs;
    state.updated = data.updated;
    render();
    const gained = undecided().length - before;
    if (gained > 0) toast(`${gained} new since you last looked`);
  } catch { /* offline — cached copy stands */ }
}

/* ---------------------------- selectors ---------------------------- */
const undecided = () => state.jobs
  .filter(j => !state.decisions[j.id])
  .filter(j => state.remote ? j.remote : true)
  .filter(j => state.fresh ? age(j.posted) <= 30 : true)
  .filter(j => state.minPay ? (j.hi || j.lo || 0) >= state.minPay : true)
  .sort((a, b) => new Date(b.posted) - new Date(a.posted));

const withState = s => state.jobs
  .filter(j => state.decisions[j.id] === s)
  .sort((a, b) => new Date(b.posted) - new Date(a.posted));

const filtersOn = () => state.remote || state.fresh || state.minPay > 0;

/* ----------------------------- actions ----------------------------- */
function decide(job, verdict) {
  if (verdict === "applied") window.open(job.url, "_blank", "noopener");
  state.decisions[job.id] = verdict;
  persist(); render();
}
function undo(id) { delete state.decisions[id]; persist(); render(); }

/* ------------------------------ views ------------------------------ */
function render() {
  const q = undecided(), sv = withState("saved"), ap = withState("applied");
  $('[data-count="queue"]').textContent   = q.length;
  $('[data-count="saved"]').textContent   = sv.length;
  $('[data-count="applied"]').textContent = ap.length;

  const arrivals = state.lastOpen
    ? state.jobs.filter(j => !state.decisions[j.id] &&
        new Date(j.first_seen || j.posted).getTime() > state.lastOpen).length
    : 0;
  $("#stamp").textContent = state.updated
    ? (arrivals > 0
        ? `${arrivals} new since you last looked · ${state.jobs.length} total`
        : `${state.jobs.length} listings · updated ${ago(state.updated)} ago`)
    : "No listings yet — the first fetch hasn't run.";
  $("#stamp").style.color = arrivals > 0 ? "var(--fresh)" : "";

  const onQueue = state.tab === "queue";
  $("#filters").classList.toggle("hidden", !onQueue);
  $("#modes").classList.toggle("hidden", !onQueue);

  const stage = $("#stage");
  const actions = $("#actions");
  stage.innerHTML = "";
  actions.classList.add("hidden");

  if (!onQueue) return renderList(stage, state.tab === "saved" ? sv : ap, true);
  if (!q.length) return renderEmpty(stage);
  if (state.mode === "list") return renderList(stage, q, false);
  renderDeck(stage, q, actions);
}

function renderEmpty(stage) {
  const any = Object.keys(state.decisions).length > 0;
  const f = filtersOn();
  const div = document.createElement("div");
  div.className = "empty";
  div.innerHTML = `<h3>${f ? "Nothing matches those filters" : "Queue clear"}</h3>
    <p>${f ? "Loosen a filter to see the rest."
           : "New listings land automatically twice a day."}</p>
    ${f ? '<button id="clearf">Clear filters</button>'
        : any ? '<button id="resetf">Start over</button>' : ""}`;
  stage.append(div);
  $("#clearf")?.addEventListener("click", () => {
    state.remote = state.fresh = false; state.minPay = 0;
    $$(".chip").forEach(c => c.classList.remove("on")); render();
  });
  $("#resetf")?.addEventListener("click", () => {
    state.decisions = {}; persist(); render();
  });
}

function renderDeck(stage, q, actions) {
  const job = q[0];
  const deck = document.createElement("div");
  deck.className = "deck";

  q.slice(1, 5).forEach((_, i) => {
    const g = document.createElement("div");
    g.className = "ghostcard";
    g.style.cssText = `top:${(i + 1) * 7}px;opacity:${0.32 - i * 0.07};transform:scale(${1 - (i + 1) * 0.022})`;
    deck.append(g);
  });

  const card = document.createElement("article");
  card.className = "card settle";
  card.innerHTML = `
    <div class="badges">
      ${age(job.posted) <= 7 ? '<span class="b new">NEW</span>' : ""}
      ${job.remote ? '<span class="b rem">REMOTE</span>' : ""}
      ${job.source ? `<span class="b src">${esc(job.source).toUpperCase()}</span>` : ""}
      ${job.applicants != null && job.applicants < 10 ? '<span class="b few">FEW APPLICANTS</span>' : ""}
      <span class="when">${ago(job.posted)} · ${esc(job.type)}</span>
    </div>
    <h2>${esc(job.title)}</h2>
    <p class="co">${esc(job.company)}</p>
    <p class="meta">${esc(job.loc)} · ${esc(job.exp)}${job.applicants != null ? ` · ${job.applicants} applicants` : ""}</p>
    <p class="pay ${job.lo ? "known" : ""}">${esc(job.pay)}</p>
    <a class="full" href="${esc(job.url)}" target="_blank" rel="noopener">Open full posting</a>`;
  deck.append(card);
  stage.append(deck);

  actions.classList.remove("hidden");
  actions.onclick = e => {
    const b = e.target.closest(".act"); if (!b) return;
    decide(job, b.classList.contains("apply") ? "applied"
             : b.classList.contains("save")  ? "saved" : "skipped");
  };

  attachSwipe(card, job);
}

function attachSwipe(card, job) {
  let x0 = 0, dx = 0, dragging = false, tear = null;

  const start = e => {
    dragging = true; card.classList.remove("settle");
    x0 = (e.touches ? e.touches[0] : e).clientX;
  };
  const move = e => {
    if (!dragging) return;
    dx = (e.touches ? e.touches[0] : e).clientX - x0;
    card.style.transform = `translateX(${dx}px) rotate(${Math.max(-14, Math.min(14, dx / 9))}deg)`;
    const want = dx > 45 ? "l" : dx < -45 ? "r" : null;
    if (want !== (tear && tear.dataset.side)) {
      tear?.remove(); tear = null;
      if (want) {
        tear = document.createElement("span");
        tear.className = "tear " + want;
        tear.dataset.side = want;
        tear.textContent = want === "l" ? "SAVE" : "SKIP";
        card.append(tear);
      }
    }
  };
  const end = () => {
    if (!dragging) return;
    dragging = false; card.classList.add("settle");
    if (dx > 90) return decide(job, "saved");
    if (dx < -90) return decide(job, "skipped");
    card.style.transform = ""; tear?.remove(); tear = null; dx = 0;
  };

  card.addEventListener("touchstart", start, { passive: true });
  card.addEventListener("touchmove", move, { passive: true });
  card.addEventListener("touchend", end);
  card.addEventListener("mousedown", start);
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", end);
}

function renderList(stage, jobs, decided) {
  if (!jobs.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.innerHTML = `<p>${state.tab === "saved"
      ? "Nothing saved yet. Swipe right to keep one for later."
      : "Nothing applied yet. Apply opens the posting and files it here."}</p>`;
    stage.append(p); return;
  }
  const wrap = document.createElement("div");
  wrap.className = "rows";
  wrap.innerHTML = jobs.map(j => `
    <div class="row" data-id="${esc(j.id)}">
      <div class="top">
        <div style="min-width:0;flex:1">
          ${decided ? `<a class="t" href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.title)}</a>`
                    : `<p class="t">${esc(j.title)}</p>`}
          <p class="s">${esc(j.company)} · ${esc(j.loc)} · ${ago(j.posted)}${j.remote ? " · Remote" : ""}${j.source ? " · " + esc(j.source) : ""}</p>
        </div>
        ${decided ? '<button class="undo">Undo</button>'
                  : `<span class="amt ${j.lo ? "known" : ""}">${j.lo ? inr(j.lo) + "–" + inr(j.hi) : "—"}</span>`}
      </div>
      ${decided ? "" : `<div class="btns">
        <button class="mini skip">Skip</button>
        <button class="mini save">Save</button>
        <button class="mini apply grow">Apply</button></div>`}
    </div>`).join("");

  wrap.onclick = e => {
    const row = e.target.closest(".row"); if (!row) return;
    const job = state.jobs.find(j => j.id === row.dataset.id); if (!job) return;
    if (e.target.classList.contains("undo")) return undo(job.id);
    const b = e.target.closest(".mini"); if (!b) return;
    decide(job, b.classList.contains("apply") ? "applied"
             : b.classList.contains("save")  ? "saved" : "skipped");
  };
  stage.append(wrap);
}

/* ------------------------------ wiring ------------------------------ */
$(".tabs").addEventListener("click", e => {
  const b = e.target.closest(".tab"); if (!b) return;
  $$(".tab").forEach(t => t.classList.toggle("on", t === b));
  state.tab = b.dataset.tab; render();
});

$("#modes").addEventListener("click", e => {
  const b = e.target.closest(".mode"); if (!b) return;
  $$(".mode").forEach(m => m.classList.toggle("on", m === b));
  state.mode = b.dataset.mode; render();
});

$("#filters").addEventListener("click", e => {
  const c = e.target.closest(".chip"); if (!c) return;
  if (c.dataset.pay) {
    const v = Number(c.dataset.pay);
    const on = state.minPay === v;
    state.minPay = on ? 0 : v;
    $$("[data-pay]").forEach(x => x.classList.toggle("on", !on && x === c));
  } else {
    const f = c.dataset.f;
    state[f] = !state[f];
    c.classList.toggle("on", state[f]);
  }
  render();
});

$("#refresh").addEventListener("click", async e => {
  e.currentTarget.classList.add("spin");
  await loadJobs(true);
  e.currentTarget.classList.remove("spin");
  toast("Reloaded");
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

/* Paint from cache first, then quietly catch up. */
loadJobs().then(() => {
  setTimeout(refreshInBackground, 400);
  // stamp this visit only after the user has actually seen the list
  setTimeout(() => {
    state.lastOpen = Date.now();
    localStorage.setItem(SEEN_KEY, String(state.lastOpen));
  }, 3000);
});

/* Coming back to the app after a while re-checks for new listings. */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshInBackground();
});
