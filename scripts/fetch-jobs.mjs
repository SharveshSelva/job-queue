/**
 * Runs on GitHub Actions. Pulls jobs from free sources plus, optionally,
 * several Apify actors, normalises them into one shape, merges into
 * data/jobs.json, prunes stale rows.
 *
 * Free sources need no env at all. APIFY_TOKEN is only required if SOURCES
 * asks for a paid source (indeed, wellfound, linkedin, google, naukri).
 *
 * Optional env (GitHub Variables):
 *   APIFY_TOKEN             repo secret — only needed for paid sources
 *   SEARCH_TERMS           comma separated, default "React Developer,Frontend Developer"
 *   SEARCH_LOCATION        "Chennai"  (or "Remote")
 *   SEARCH_COUNTRY         ISO-2, "IN"      — used by the Indeed actor
 *   SEARCH_COUNTRY_NAME    "india"          — used by the orgupdate actors
 *   SOURCES                comma separated ids, default "indeed,wellfound,linkedin"
 *   LINKEDIN_PAGES         pages to scrape, 1 page ≈ 25-60 jobs, default 1
 *   LINKEDIN_EXPERIENCE    entry | associate | mid-senior | director | executive | internship
 *   LINKEDIN_WORKPLACE     remote | hybrid | onsite
 *   LINKEDIN_LOW_APPLICANTS  "true" to only return roles with <10 applicants
 *   MAX_ITEMS_PER_SOURCE   billing cap per actor run, default 25
 *   MAX_AGE_DAYS           prune listings older than this, default 45
 */
import { readFile, writeFile } from "node:fs/promises";
import * as free from "./free-sources.mjs";

const TOKEN     = process.env.APIFY_TOKEN;
const TERMS     = (process.env.SEARCH_TERMS || "React Developer,Frontend Developer")
                    .split(",").map(s => s.trim()).filter(Boolean);
const LOCATION  = process.env.SEARCH_LOCATION || "Chennai";
const COUNTRY   = process.env.SEARCH_COUNTRY || "IN";
const CNAME     = (process.env.SEARCH_COUNTRY_NAME || "india").toLowerCase();
const WANTED    = (process.env.SOURCES || "greenhouse,lever,ashby,smartrecruiters,remoteok,remotive,arbeitnow,hn,jobicy,himalayas,wwr,keka").split(",").map(s => s.trim());
const LI_PAGES     = Number(process.env.LINKEDIN_PAGES || 1);
const LI_EXPERIENCE= process.env.LINKEDIN_EXPERIENCE || "";   // entry | associate | mid-senior | ...
const LI_WORKPLACE = process.env.LINKEDIN_WORKPLACE  || "";   // remote | hybrid | onsite
const LI_LOW_APPS  = /^(1|true|yes)$/i.test(process.env.LINKEDIN_LOW_APPLICANTS || "");
const CAP       = Number(process.env.MAX_ITEMS_PER_SOURCE || 25);
const MAX_AGE   = Number(process.env.MAX_AGE_DAYS || 45);
const OUT       = "data/jobs.json";
const USAGE     = "data/usage.json";
// Hard ceiling on Apify spend per calendar month. Apify's free tier is $5;
// this defaults well under it so the app can never eat the whole allowance.
const BUDGET    = Number(process.env.APIFY_BUDGET_USD || 2.0);

/* ------------------------------------------------------------------
   SOURCES
   Each entry: which actor, how to build its input, whether it's on.
   Toggle with the SOURCES variable — no code edit needed.
-------------------------------------------------------------------*/
const SOURCES = {
  /* ---------- FREE. No key, no account, no credits. On by default. ---------- */
  // greenhouse/lever/ashby/smartrecruiters/keka return every opening at a
  // company; remoteok/arbeitnow/workday return their entire board. None of
  // them take a search term — free.relevant() filters the raw rows by
  // title against every configured TERM (not just the one the outer loop
  // happens to be on; see the `perCompany` skip-repeat-fetches list below).
  greenhouse:     { label: "Greenhouse",     free: true, fetch: async () => free.relevant(await free.greenhouse(free.COMPANIES.greenhouse), TERMS.join(" ")) },
  lever:          { label: "Lever",          free: true, fetch: async () => free.relevant(await free.lever(free.COMPANIES.lever), TERMS.join(" ")) },
  ashby:          { label: "Ashby",          free: true, fetch: async () => free.relevant(await free.ashby(free.COMPANIES.ashby), TERMS.join(" ")) },
  smartrecruiters:{ label: "SmartRecruiters",free: true, fetch: async () => free.relevant(await free.smartrecruiters(free.COMPANIES.smartrecruiters), TERMS.join(" ")) },
  remoteok:       { label: "RemoteOK",       free: true, fetch: async () => free.relevant(await free.remoteok(), TERMS.join(" ")) },
  remotive:       { label: "Remotive",       free: true, fetch: t => free.remotive(t) },
  arbeitnow:      { label: "Arbeitnow",      free: true, fetch: async () => free.relevant(await free.arbeitnow(), TERMS.join(" ")) },
  hn:             { label: "HN Hiring",      free: true, fetch: t => free.hnWhoIsHiring(t) },
  jobicy:         { label: "Jobicy",         free: true, fetch: t => free.jobicy(t) },
  himalayas:      { label: "Himalayas",      free: true, fetch: t => free.himalayas(t) },
  wwr:            { label: "WWR",            free: true, fetch: t => free.weworkremotely(t) },
  workday:        { label: "Workday",        free: true, fetch: async () => free.relevant(await free.workday(), TERMS.join(" ")) },
  // Indian ATS — Keka confirmed working end to end. Freshteam and Zoho
  // Recruit require an authenticated API (401 on the real endpoint, no
  // public JSON alternative) and aren't registered at all. Darwinbox's
  // endpoint is real and correct (verified live via curl) but sits behind
  // Cloudflare bot mitigation that 403s Node's fetch specifically — the
  // exact client GitHub Actions runs — so it's left out of SOURCES too;
  // it would silently contribute 0 jobs every day. The function still
  // lives in free-sources.mjs and shows up in verify-sources.mjs in case
  // that ever becomes usable (e.g. via a browser-based fetch).
  keka:           { label: "Keka",           free: true, fetch: async () => free.relevant(await free.keka(), TERMS.join(" ")) },

  /* ---------- APIFY. Costs credits. Off by default now. ---------- */
  // Indeed. Broadest coverage for India. Own input shape.
  indeed: {
    actor: "misceres/indeed-scraper",
    label: "Indeed",
    input: term => ({
      position: term,
      location: LOCATION,
      country: COUNTRY,
      maxItemsPerSearch: CAP,
      saveOnlyUniqueItems: true,
      parseCompanyDetails: false,
      followApplyRedirects: false,
    }),
  },

  // Wellfound (ex-AngelList). Startup roles — usually the best-quality listings here.
  wellfound: {
    actor: "orgupdate/wellfound-jobs-scraper",
    label: "Wellfound",
    input: term => ({
      countryName: CNAME,
      locationName: LOCATION,
      includeKeyword: term,
      pagesToFetch: 1,
      datePosted: "month",
    }),
  },

  // Google Jobs aggregates LinkedIn / Glassdoor / ZipRecruiter / careers pages.
  // Widest net, noisiest results — expect duplicates of the other sources.
  google: {
    actor: "orgupdate/google-jobs-scraper",
    label: "Google Jobs",
    input: term => ({
      countryName: CNAME,
      locationName: LOCATION,
      includeKeyword: term,
      pagesToFetch: 1,
      datePosted: "week",
    }),
  },

  // Naukri — biggest Indian pool, no free API. Costs credits.
  naukri: {
    actor: "sunny_bhavsar/naukri-jobs-scraper",
    label: "Naukri",
    input: term => ({ keyword: term, location: LOCATION, maxItems: CAP }),
  },

  // Second Indeed scraper — keep as a fallback if `indeed` starts failing.
  indeed_alt: {
    actor: "borderline/indeed-scraper",
    label: "Indeed",
    input: term => ({ position: term, location: LOCATION, country: COUNTRY, maxItems: CAP }),
  },

  // LinkedIn, no authentication needed — public listing pages only.
  // Safe to leave on: nothing touches your LinkedIn account.
  linkedin: {
    actor: "aligned_safe/linkedin-jobs-scraper-2026",
    label: "LinkedIn",
    input: term => {
      const i = {
        keyword: term,
        location: LOCATION,
        pages: LI_PAGES,
      };
      if (LI_EXPERIENCE) i.experience = LI_EXPERIENCE;   // entry | associate | mid-senior | …
      if (LI_WORKPLACE)  i.workplace  = LI_WORKPLACE;    // remote | hybrid | onsite
      if (LI_LOW_APPS)   i.under10Applicants = true;     // fewer applicants = better odds
      return i;
    },
  },
};

// APIFY_TOKEN is only required if a requested source actually needs it —
// free sources must keep working with no token, no secret, no account.
if (WANTED.some(id => SOURCES[id] && !SOURCES[id].free) && !TOKEN) {
  console.error("APIFY_TOKEN not set, but SOURCES asks for a paid source. Repo → Settings → Secrets and variables → Actions.");
  process.exit(1);
}

/* ---------------- salary: pull ₹ figures out of free text ---------------- */
const MONTH = 1, YEAR = 1 / 12;
// No live FX feed here — this is a rough, occasionally-stale constant so a
// "$120,000 a year" listing (RemoteOK/Jobicy/Himalayas all report in USD)
// doesn't get compared against ₹ figures as if the number were already
// rupees. Being off by a few percent on the exchange rate is a minor
// inaccuracy; treating $120,000 as ₹120,000 is off by 88x and quietly
// filters the highest-paying listings out of the queue.
const USD_INR = 88;

function parsePay(text = "") {
  if (!text || /^n\/?a$/i.test(String(text).trim())) return { lo: null, hi: null, label: "Not stated" };
  const t = String(text).replace(/,/g, "");

  // Currency has to be decided before any number is parsed — a bare
  // number means nothing without knowing which currency it's in.
  const isUsd = /\$|USD/i.test(t) && !/₹/.test(t);
  const fx = isUsd ? USD_INR : 1;

  // Wellfound style: "₹3L–₹4L a year", "₹8L–₹24L a year"
  const lakh = t.match(/₹\s*(\d+(?:\.\d+)?)\s*L\s*(?:-|–|to)?\s*(?:₹\s*(\d+(?:\.\d+)?)\s*L)?/i);
  if (lakh) {
    const a = Number(lakh[1]) * 1e5 * YEAR;
    const b = lakh[2] ? Number(lakh[2]) * 1e5 * YEAR : a;
    return { lo: Math.round(a), hi: Math.round(b), label: String(text).trim().slice(0, 60) };
  }

  const lpa = t.match(/(?:₹|rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:-|–|to)?\s*(\d+(?:\.\d+)?)?\s*lpa/i);
  if (lpa) {
    const a = Number(lpa[1]) * 1e5 * YEAR;
    const b = lpa[2] ? Number(lpa[2]) * 1e5 * YEAR : a;
    return { lo: Math.round(a), hi: Math.round(b), label: String(text).trim().slice(0, 60) };
  }
  // "$50,000 - $80,000 a year": each number needs its own optional currency
  // prefix. Without "$" as an option here, "$50000 - $80000" fails to match
  // starting at the first number (the bare "$" blocks the optional-prefix
  // group), so the regex engine skips ahead and matches only "$80000 a
  // year" — silently dropping the low end of every USD range.
  const per = t.match(/(?:₹|\$|rs\.?\s*)?(\d{4,9}(?:\.\d+)?)\s*(?:-|–|to)?\s*(?:₹|\$|rs\.?\s*)?(\d{4,9}(?:\.\d+)?)?\s*(?:per|a|\/)\s*(month|year|annum|yr|mo)/i);
  if (per) {
    const unit = /mo/i.test(per[3]) ? MONTH : YEAR;
    const a = Number(per[1]) * unit * fx;
    const b = per[2] ? Number(per[2]) * unit * fx : a;
    return { lo: Math.round(a), hi: Math.round(b), label: String(text).trim().slice(0, 60) };
  }
  return { lo: null, hi: null, label: String(text).trim().slice(0, 60) || "Not stated" };
}

const pick = (o, keys) => {
  for (const k of keys) {
    const v = o?.[k];
    if (v == null || v === "") continue;
    if (Array.isArray(v)) { if (v.length) return v.join(", "); continue; }  // Indeed returns jobType: ["Permanent","Full-time"]
    return v;
  }
  return null;
};

/* Plain base64 of a URL collides — job-board URLs share a long common prefix. */
function hashId(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 14);
}

function normalise(r, term, source) {
  // Field names differ per actor. aligned_safe/linkedin uses snake_case
  // (job_url, job_title, company_name); misceres/indeed uses positionName;
  // the orgupdate actors use camelCase. Cover all three.
  const url = pick(r, ["job_url", "url", "URL", "absolute_url", "hostedUrl", "link", "jobUrl", "applyUrl", "externalApplyLink", "jobPostingUrl"]);
  const title = pick(r, ["job_title", "positionName", "title", "jobTitle", "position", "text", "name"]);
  if (!url || !title) return null;

  const loc = pick(r, ["job_location", "location", "jobLocation", "formattedLocation", "place"]) || "—";
  const payRaw = pick(r, ["salary", "salaryInfo", "compensation", "salaryRange", "pay"])
                 || pick(r, ["job_description", "description", "descriptionText", "jobDescription"]) || "";
  const { lo, hi, label } = parsePay(typeof payRaw === "string" ? payRaw : JSON.stringify(payRaw));

  const postedRaw = pick(r, ["posted_date", "postingDateParsed", "postedAt", "datePosted", "publishedAt", "postedDate", "listedAt", "date"]);
  let posted = new Date().toISOString().slice(0, 10);
  if (postedRaw) {
    const raw = String(postedRaw).trim();
    // Wellfound returns relative text ("28 days ago") — Date() can't parse it,
    // and silently defaulting to today would make every listing look brand new.
    const rel = raw.match(/(\d+)\+?\s*(hour|day|week|month|year)s?\s*ago/i);
    if (rel) {
      const n = Number(rel[1]);
      const mult = { hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[rel[2].toLowerCase()];
      posted = new Date(Date.now() - n * mult * 864e5).toISOString().slice(0, 10);
    } else if (/just posted|today|new/i.test(raw)) {
      posted = new Date().toISOString().slice(0, 10);
    } else {
      const d = new Date(raw);
      if (!isNaN(d)) posted = d.toISOString().slice(0, 10);
    }
  }

  const blob = `${loc} ${pick(r, ["workplace", "workplaceType", "workType", "remoteWorkModel"]) || ""}`;
  const isRemote = /remote|work from home|wfh|anywhere/i.test(blob);
  const clean = String(url).split("?")[0];

  return {
    id: hashId(clean),
    title: String(title).trim(),
    company: pick(r, ["company_name", "company", "companyName", "employer", "organization"]) || "—",
    loc: String(loc).trim(),
    posted,
    type: pick(r, ["employment_type", "jobType", "employmentType", "contractType"]) || "—",
    remote: isRemote,
    lo, hi, pay: label,
    exp: pick(r, ["experience_level", "experienceLevel", "seniority", "experience"]) || "—",
    applicants: (() => {
      const a = pick(r, ["num_applicants", "applicants", "applicantCount", "numApplicants", "applicantsCount"]);
      if (a == null) return null;
      const n = parseInt(String(a).replace(/\D/g, ""), 10);
      return Number.isFinite(n) ? n : null;
    })(),
    source, term,
    url: clean,
    first_seen: new Date().toISOString().slice(0, 10),
  };
}

async function runActor(actor, input) {
  // maxItems caps *billing* on pay-per-result actors — the safety net on cost.
  const ep = `https://api.apify.com/v2/acts/${actor.replace("/", "~")}`
           + `/run-sync-get-dataset-items?token=${TOKEN}&timeout=280&maxItems=${CAP}`;
  const res = await fetch(ep, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 180);
    throw new Error(`HTTP ${res.status} — ${body}`);
  }
  const items = await res.json();
  return Array.isArray(items) ? items : [];
}

/* -------------------------------- main -------------------------------- */
let existing = [];
try {
  existing = JSON.parse(await readFile(OUT, "utf8")).jobs ?? [];
  console.log(`Loaded ${existing.length} cached listings.`);
} catch { console.log("No cache — starting fresh."); }

/* ---- Apify spend ledger. Resets each calendar month. ---- */
const thisMonth = new Date().toISOString().slice(0, 7);
let usage = { month: thisMonth, spentUsd: 0, runs: 0 };
try {
  const prev = JSON.parse(await readFile(USAGE, "utf8"));
  if (prev.month === thisMonth) usage = prev;
  else console.log(`New month (${thisMonth}) — Apify budget reset to $${BUDGET.toFixed(2)}.`);
} catch { /* first run */ }
const budgetLeft = () => BUDGET - usage.spentUsd;
// Worst-case cost of one actor call: start fee + a full page of results.
// Check the *projected* cost fits, not merely that budget is above zero —
// otherwise a call can overshoot the cap on its way past it.
const callCost  = () => 0.02 + CAP * 0.012;
const canAfford = () => budgetLeft() >= callCost();

const seen = new Map(existing.map(j => [j.url, j]));
const tally = {};
let added = 0;

for (const id of WANTED) {
  const src = SOURCES[id];
  if (!src) { console.warn(`! unknown source "${id}" — skipping`); continue; }
  if (src.requiresSecret && !process.env[src.requiresSecret]) {
    console.warn(`! ${id} needs ${src.requiresSecret} — skipping`);
    continue;
  }

  if (!src.free && !canAfford()) {
    console.log(`${src.label.padEnd(16)} skipped — would exceed budget ($${usage.spentUsd.toFixed(2)} spent, $${budgetLeft().toFixed(2)} left, call costs up to $${callCost().toFixed(2)})`);
    continue;
  }
  tally[id] = 0;
  // These sources' fetch() ignores whatever term the outer loop passes in
  // (they filter against the full TERMS list internally via free.relevant())
  // — running them again per search term would just refetch the same rows.
  const perCompany = ["greenhouse","lever","ashby","smartrecruiters","remoteok","arbeitnow","workday","keka"].includes(id);
  const terms = perCompany ? [TERMS[0]] : TERMS;
  for (const term of terms) {
    if (!src.free && !canAfford()) {
      console.log(`${src.label.padEnd(16)} ${term} — skipped, budget reserve reached`);
      continue;
    }
    process.stdout.write(`${src.label.padEnd(12)} ${term} … `);
    let rows = [];
    // free sources expose fetch(); Apify sources expose actor+input
    try { rows = src.fetch ? await src.fetch(term) : await runActor(src.actor, src.input(term)); }
    catch (e) { console.log(`failed (${e.message})`); continue; }

    if (!src.free) {
      // ~$0.02 to start a run + ~$0.012 per result, matching observed billing
      const cost = 0.02 + rows.length * 0.012;
      usage.spentUsd += cost;
      usage.runs += 1;
      if (!canAfford()) console.log(`  ! budget reserve reached — remaining paid calls will be skipped`);
    }

    let fresh = 0;
    for (const r of rows) {
      const j = normalise(r, term, r._src || src.label);
      if (!j || seen.has(j.url)) continue;   // keeps the original first_seen
      seen.set(j.url, j);
      fresh++; added++; tally[id]++;
    }
    console.log(`${rows.length} raw, ${fresh} new`);
  }
}

const cutoff = Date.now() - MAX_AGE * 864e5;
const jobs = [...seen.values()]
  .filter(j => new Date(j.posted).getTime() >= cutoff)
  .sort((a, b) => new Date(b.posted) - new Date(a.posted));

await writeFile(OUT, JSON.stringify({
  updated: new Date().toISOString(),
  location: LOCATION,
  terms: TERMS,
  sources: WANTED,
  count: jobs.length,
  jobs,
}, null, 2) + "\n");

await writeFile(USAGE, JSON.stringify(usage, null, 2) + "\n");

console.log("\n— summary —");
for (const [k, v] of Object.entries(tally)) {
  const tag = SOURCES[k]?.free ? "free" : "apify";
  console.log(`  ${k.padEnd(16)} +${String(v).padStart(3)}  (${tag})`);
}
console.log(`  pruned      ${seen.size - jobs.length} stale`);
console.log(`  live        ${jobs.length} listings`);
console.log(`  apify spend $${usage.spentUsd.toFixed(2)} of $${BUDGET.toFixed(2)} this month`);

if (added === 0 && existing.length === 0) {
  console.error("\nNothing fetched and no cache. Check APIFY_TOKEN, then the actor input schemas.");
  process.exit(1);
}
