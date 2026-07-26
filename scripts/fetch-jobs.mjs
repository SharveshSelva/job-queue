/**
 * Runs on GitHub Actions. Pulls jobs from several Apify actors, normalises
 * them into one shape, merges into data/jobs.json, prunes stale rows.
 *
 * Required env:
 *   APIFY_TOKEN            repo secret
 * Optional env (GitHub Variables):
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

const TOKEN     = process.env.APIFY_TOKEN;
const TERMS     = (process.env.SEARCH_TERMS || "React Developer,Frontend Developer")
                    .split(",").map(s => s.trim()).filter(Boolean);
const LOCATION  = process.env.SEARCH_LOCATION || "Chennai";
const COUNTRY   = process.env.SEARCH_COUNTRY || "IN";
const CNAME     = (process.env.SEARCH_COUNTRY_NAME || "india").toLowerCase();
const WANTED    = (process.env.SOURCES || "indeed,wellfound,linkedin").split(",").map(s => s.trim());
const LI_PAGES     = Number(process.env.LINKEDIN_PAGES || 1);
const LI_EXPERIENCE= process.env.LINKEDIN_EXPERIENCE || "";   // entry | associate | mid-senior | ...
const LI_WORKPLACE = process.env.LINKEDIN_WORKPLACE  || "";   // remote | hybrid | onsite
const LI_LOW_APPS  = /^(1|true|yes)$/i.test(process.env.LINKEDIN_LOW_APPLICANTS || "");
const CAP       = Number(process.env.MAX_ITEMS_PER_SOURCE || 25);
const MAX_AGE   = Number(process.env.MAX_AGE_DAYS || 45);
const OUT       = "data/jobs.json";

if (!TOKEN) {
  console.error("APIFY_TOKEN not set. Repo → Settings → Secrets and variables → Actions.");
  process.exit(1);
}

/* ------------------------------------------------------------------
   SOURCES
   Each entry: which actor, how to build its input, whether it's on.
   Toggle with the SOURCES variable — no code edit needed.
-------------------------------------------------------------------*/
const SOURCES = {
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

/* ---------------- salary: pull ₹ figures out of free text ---------------- */
const MONTH = 1, YEAR = 1 / 12;
function parsePay(text = "") {
  if (!text || /^n\/?a$/i.test(String(text).trim())) return { lo: null, hi: null, label: "Not stated" };
  const t = String(text).replace(/,/g, "");

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
  const per = t.match(/(?:₹|rs\.?\s*)?(\d{4,9}(?:\.\d+)?)\s*(?:-|–|to)?\s*(?:₹|rs\.?\s*)?(\d{4,9}(?:\.\d+)?)?\s*(?:per|a|\/)\s*(month|year|annum|yr|mo)/i);
  if (per) {
    const unit = /mo/i.test(per[3]) ? MONTH : YEAR;
    const a = Number(per[1]) * unit;
    const b = per[2] ? Number(per[2]) * unit : a;
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
  const url = pick(r, ["job_url", "url", "URL", "link", "jobUrl", "applyUrl", "externalApplyLink", "jobPostingUrl"]);
  const title = pick(r, ["job_title", "positionName", "title", "jobTitle", "position", "name"]);
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

  tally[id] = 0;
  for (const term of TERMS) {
    process.stdout.write(`${src.label.padEnd(12)} ${term} … `);
    let rows = [];
    try { rows = await runActor(src.actor, src.input(term)); }
    catch (e) { console.log(`failed (${e.message})`); continue; }

    let fresh = 0;
    for (const r of rows) {
      const j = normalise(r, term, src.label);
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

console.log("\n— summary —");
for (const [k, v] of Object.entries(tally)) console.log(`  ${k.padEnd(12)} +${v}`);
console.log(`  pruned      ${seen.size - jobs.length} stale`);
console.log(`  live        ${jobs.length} listings`);

if (added === 0 && existing.length === 0) {
  console.error("\nNothing fetched and no cache. Check APIFY_TOKEN, then the actor input schemas.");
  process.exit(1);
}
