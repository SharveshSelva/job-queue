/**
 * Free job sources — no API key, no account, no credits.
 *
 * Every function here returns a raw array that scripts/fetch-jobs.mjs feeds
 * straight into its existing normalise(). Nothing about the pipeline changes:
 * same registry, same dedupe, same prune, same commit.
 *
 * Company-board sources (Greenhouse/Lever/Ashby/SmartRecruiters) need a slug
 * per company — see COMPANIES below. Aggregator sources need nothing.
 *
 * Run `node scripts/verify-sources.mjs` to see which of these are live and
 * which company slugs actually resolve.
 */

const UA = { "User-Agent": "job-queue/1.0 (personal job tracker)" };

async function getJSON(url, opts = {}) {
  const res = await fetch(url, { headers: UA, ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ------------------------------------------------------------------
   RELEVANCE FILTER
   Some sources have no way to search server-side: RemoteOK, Arbeitnow and
   Workday return their entire board regardless of what you ask for, and
   the company-board sources (Greenhouse/Lever/Ashby/SmartRecruiters/Keka)
   return every opening at a company — sales, HR, finance included, not
   just engineering. Without this, "React Developer" as a search term does
   nothing for those sources and they dump their whole inventory into the
   queue. Same word-match approach weworkremotely() and hnWhoIsHiring()
   already use below — not exact, but turns "every job at the company"
   into "the ones actually worth swiping on."

   Real engineering roles are often titled "Software Development Engineer",
   "Fullstack Engineer", "SDE II", "SDET" rather than literally containing
   "developer" — RELEVANT_EXTRA widens recall for those regardless of what
   SEARCH_TERMS says. But "engineer" alone also matches whole job families
   that are pre-sales/support, not software: Solutions Engineer, Customer
   Success Engineer, GTM Engineer, Value Engineer are real, common titles
   at exactly the SaaS companies in COMPANIES. RELEVANT_EXCLUDE (checked
   first, as phrases) keeps those out without narrowing "engineer" itself.
-------------------------------------------------------------------*/
const RELEVANT_EXTRA = ["engineer", "fullstack", "sde", "sdet"];
const RELEVANT_EXCLUDE = [
  "customer success", "solutions engineer", "solution engineer",
  "sales engineer", "gtm engineer", "value engineer", "support engineer",
];

export function relevant(rows, terms) {
  const needle = [
    ...String(terms).toLowerCase().split(/\s+/).filter(w => w.length > 3),
    ...RELEVANT_EXTRA,
  ];
  return rows.filter(r => {
    const title = String(r.title || "").toLowerCase();
    if (RELEVANT_EXCLUDE.some(p => title.includes(p))) return false;
    return needle.some(w => title.includes(w));
  });
}

/* ------------------------------------------------------------------
   COMPANY SLUGS
   The slug is the path segment on the company's careers URL, e.g.
   boards.greenhouse.io/razorpaysoftwareprivatelimited  ->  that last part.
   Add companies you'd actually work for. Wrong slugs just 404 and are skipped.
-------------------------------------------------------------------*/
export const COMPANIES = {
  // hasura, chargebee, browserstack and juspay run fully custom career sites
  // (or a different ATS entirely — Gem, SAP SuccessFactors, Workday) with no
  // presence on Greenhouse/Lever/Ashby/SmartRecruiters. Removed, not guessed.
  greenhouse: [
    "razorpaysoftwareprivatelimited",   // verified live
    "postman",                          // verified live
    "groww",                            // verified live — guessed as Lever originally, actually here
  ],
  lever: [
    "zeta", "cred", "meesho",           // verified live — guessed as Greenhouse originally
    "Sprinto",                          // verified live — case-sensitive, lowercase "sprinto" 404s
  ],
  ashby: [
    "atlan",                            // verified live — guessed as Greenhouse originally
  ],
  smartrecruiters: [
    "Freshworks",                       // verified live
    "swiggy",                           // verified live — guessed as Lever originally
    "Zomato1",                          // verified live — guessed as Ashby originally, note trailing "1"
  ],
};

/* ---------------------- per-company ATS boards ---------------------- */

export async function greenhouse(slugs) {
  const out = [];
  for (const slug of slugs) {
    try {
      const d = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
      for (const j of d.jobs || []) {
        out.push({
          title: j.title,
          company: slug,
          // location arrives nested as { name: "..." } — flatten it here so
          // normalise() never sees an object
          location: j.location?.name || "",
          url: j.absolute_url,
          datePosted: j.updated_at,
          _src: "Greenhouse",
        });
      }
    } catch { /* board disabled, wrong slug, or vanity domain — skip */ }
  }
  return out;
}

export async function lever(slugs) {
  const out = [];
  for (const slug of slugs) {
    try {
      const rows = await getJSON(`https://api.lever.co/v0/postings/${slug}?mode=json`);
      for (const j of rows || []) {
        out.push({
          title: j.text,
          company: slug,
          location: j.categories?.location || "",
          url: j.hostedUrl || j.applyUrl,
          datePosted: j.createdAt ? new Date(j.createdAt).toISOString() : null,
          jobType: j.categories?.commitment || "",
          workplaceType: j.workplaceType || "",
          _src: "Lever",
        });
      }
    } catch { /* skip */ }
  }
  return out;
}

export async function ashby(slugs) {
  const out = [];
  for (const slug of slugs) {
    try {
      const d = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
      for (const j of d.jobs || []) {
        out.push({
          title: j.title,
          company: slug,
          location: j.location || "",
          url: j.jobUrl || j.applyUrl,
          datePosted: j.publishedAt || j.updatedAt,
          jobType: j.employmentType || "",
          workplaceType: j.isRemote ? "Remote" : "",
          salary: j.compensation?.summary || "",
          _src: "Ashby",
        });
      }
    } catch { /* skip */ }
  }
  return out;
}

export async function smartrecruiters(slugs) {
  const out = [];
  for (const slug of slugs) {
    try {
      const d = await getJSON(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`);
      for (const j of d.content || []) {
        const city = j.location?.city || "";
        const country = j.location?.country || "";
        out.push({
          title: j.name,
          company: slug,
          location: [city, country].filter(Boolean).join(", "),
          url: `https://jobs.smartrecruiters.com/${slug}/${j.id}`,
          datePosted: j.releasedDate,
          jobType: j.typeOfEmployment?.label || "",
          workplaceType: j.location?.remote ? "Remote" : "",
          _src: "SmartRecruiters",
        });
      }
    } catch { /* skip */ }
  }
  return out;
}

/* ------------------------- global aggregators ------------------------- */

export async function remoteok() {
  // First element of the array is a legal notice, not a job.
  const rows = await getJSON("https://remoteok.com/api");
  return (Array.isArray(rows) ? rows.slice(1) : [])
    .filter(j => j.position && j.url)
    .map(j => ({
      title: j.position,
      company: j.company,
      location: j.location || "Remote",
      url: j.url,
      datePosted: j.date,
      salary: j.salary_min ? `$${j.salary_min} - $${j.salary_max} a year` : "",
      workplaceType: "Remote",
      _src: "RemoteOK",
    }));
}

export async function remotive(term) {
  const d = await getJSON(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(term)}&limit=50`);
  return (d.jobs || []).map(j => ({
    title: j.title,
    company: j.company_name,
    location: j.candidate_required_location || "Remote",
    url: j.url,
    datePosted: j.publication_date,
    jobType: j.job_type || "",
    salary: j.salary || "",
    workplaceType: "Remote",
    _src: "Remotive",
  }));
}

// ⚠️ created_at is not a trustworthy "posted" date. It's the only date
// field this API exposes, correctly parsed as unix seconds — but checked
// live, it clusters within minutes of whenever the API is called, for
// listings across wildly different companies and roles. That reads as
// "last touched by Arbeitnow's own pipeline," not "originally posted by
// the employer." Harmless for freshness *within* one run (every listing
// looks equally new), but a listing's stamped date is set once on first
// sight (see the `seen` dedupe in fetch-jobs.mjs) — so an old listing
// this app happens to see for the first time today gets permanently
// mis-dated as posted today.
export async function arbeitnow() {
  const d = await getJSON("https://www.arbeitnow.com/api/job-board-api");
  return (d.data || []).map(j => ({
    title: j.title,
    company: j.company_name,
    location: j.location || "",
    url: j.url,
    datePosted: j.created_at ? new Date(j.created_at * 1000).toISOString() : null,
    jobType: (j.job_types || []).join(", "),
    workplaceType: j.remote ? "Remote" : "",
    _src: "Arbeitnow",
  }));
}

/* ------------------- Hacker News "Who is Hiring" -------------------
   Posted the 1st of each month. Each top-level comment is one job ad,
   written freeform — so this is deliberately best-effort: first line as
   the title, first link as the URL. Noisier than the others, but it
   surfaces remote-friendly startups nothing else indexes.
--------------------------------------------------------------------*/
export async function hnWhoIsHiring(term) {
  const search = await getJSON(
    "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=hiring&hitsPerPage=3"
  );
  const story = (search.hits || []).find(h => /who is hiring/i.test(h.title || ""));
  if (!story) return [];

  const thread = await getJSON(`https://hn.algolia.com/api/v1/items/${story.objectID}`);
  const needle = term.toLowerCase().split(/\s+/).filter(w => w.length > 3);

  return (thread.children || [])
    .filter(c => c.text && !c.deleted)
    .map(c => {
      const text = c.text.replace(/<[^>]+>/g, " ").replace(/&#x2F;/g, "/").replace(/&amp;/g, "&");
      const firstLine = text.trim().split(/[|\n]/)[0].trim().slice(0, 110);
      // Must match against the decoded `text`, not raw `c.text` — HN's API
      // HTML-entity-encodes every "/", so a raw comment has "https:&#x2F;
      // &#x2F;example.com", not "https://example.com". Matching the raw
      // field means "https?:\/\/" never matches anything, every comment
      // gets dropped by the `c.link &&` filter below, and this source
      // always returns zero jobs regardless of search term.
      const link = (text.match(/https?:\/\/[^\s"'<>]+/) || [])[0];
      return { text, firstLine, link, created: c.created_at };
    })
    .filter(c => c.link && needle.some(w => c.text.toLowerCase().includes(w)))
    .slice(0, 25)
    .map(c => ({
      title: c.firstLine,
      company: "via HN Who is Hiring",
      location: /remote/i.test(c.text) ? "Remote" : "See post",
      url: c.link,
      datePosted: c.created,
      workplaceType: /remote/i.test(c.text) ? "Remote" : "",
      _src: "HN",
    }));
}

/* ==================================================================
   ADDITIONAL FREE SOURCES
   Endpoint patterns below are best-effort where noted. Anything that
   404s is skipped silently — run scripts/verify-sources.mjs to see
   which are actually live before relying on them.
===================================================================*/

/* ---------------------- remote aggregators ---------------------- */

export async function jobicy(term) {
  const d = await getJSON(`https://jobicy.com/api/v2/remote-jobs?count=50&tag=${encodeURIComponent(term)}`);
  return (d.jobs || []).map(j => ({
    title: j.jobTitle,
    company: j.companyName,
    location: j.jobGeo || "Remote",
    url: j.url,
    datePosted: j.pubDate,
    jobType: (j.jobType || []).join(", "),
    salary: j.annualSalaryMin ? `$${j.annualSalaryMin} - $${j.annualSalaryMax} a year` : "",
    workplaceType: "Remote",
    _src: "Jobicy",
  }));
}

// ⚠️ pubDate has the same problem as Arbeitnow's created_at, worse: every
// listing checked live came back within minutes of request time regardless
// of the job, so treat "posted" for this source as "first seen by us," not
// "actually posted then." See the Arbeitnow comment above for what that
// does and doesn't break.
export async function himalayas(term) {
  const d = await getJSON(`https://himalayas.app/jobs/api?limit=50&search=${encodeURIComponent(term)}`);
  return (d.jobs || []).map(j => ({
    title: j.title,
    company: j.companyName,
    location: (j.locationRestrictions || []).join(", ") || "Remote",
    url: j.applicationLink || j.guid,
    datePosted: j.pubDate ? new Date(j.pubDate * 1000).toISOString() : null,
    salary: j.minSalary ? `$${j.minSalary} - $${j.maxSalary} a year` : "",
    workplaceType: "Remote",
    _src: "Himalayas",
  }));
}

// We Work Remotely publishes RSS, not JSON. Light regex parse — no XML dep.
export async function weworkremotely(term) {
  const res = await fetch("https://weworkremotely.com/categories/remote-programming-jobs.rss", { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const items = xml.split("<item>").slice(1);
  const needle = term.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
    if (!m) return "";
    return m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim();
  };
  return items.map(b => {
    const raw = tag(b, "title");                       // "Company: Job Title"
    const [company, ...rest] = raw.split(":");
    return {
      title: (rest.join(":") || raw).trim(),
      company: rest.length ? company.trim() : "—",
      location: tag(b, "region") || "Remote",
      url: tag(b, "link"),
      datePosted: tag(b, "pubDate"),
      workplaceType: "Remote",
      _src: "WWR",
    };
  }).filter(j => j.url && (!needle.length || needle.some(w => j.title.toLowerCase().includes(w))));
}

/* -------------------------- Workday --------------------------
   Every customer has its own tenant + site, so this needs a list of
   {tenant, site, host} rather than a plain slug. POST, not GET.
   Example: { tenant:"nvidia", site:"NVIDIAExternalCareerSite", host:"wd5" }
--------------------------------------------------------------*/
export const WORKDAY_TENANTS = [
  // { tenant: "example", site: "ExternalCareerSite", host: "wd3" },
];

export async function workday(tenants = WORKDAY_TENANTS) {
  const out = [];
  for (const t of tenants) {
    try {
      const base = `https://${t.tenant}.${t.host}.myworkdayjobs.com`;
      const res = await fetch(`${base}/wday/cxs/${t.tenant}/${t.site}/jobs`, {
        method: "POST",
        headers: { ...UA, "Content-Type": "application/json" },
        body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: "" }),
      });
      if (!res.ok) continue;
      const d = await res.json();
      for (const j of d.jobPostings || []) {
        out.push({
          title: j.title,
          company: t.tenant,
          location: j.locationsText || "",
          url: `${base}/${t.site}${j.externalPath}`,
          datePosted: j.postedOn || "",
          _src: "Workday",
        });
      }
    } catch { /* skip */ }
  }
  return out;
}

/* --------------------- Indian ATS platforms ---------------------
   Freshteam and Zoho Recruit are gone from here — both platforms only
   expose their job data behind an authenticated REST API (OAuth token /
   API key), confirmed by hitting the real endpoints and getting a 401.
   Their public careers pages render jobs server-side with no JSON to
   scrape either. No free no-auth path exists, so they're not offered
   as sources at all (see fetch-jobs.mjs SOURCES).

   Keka and Darwinbox DO have real no-auth JSON endpoints — found by
   pulling each platform's own JS bundle and reading its API route
   table, then confirming live against a real tenant.

   Darwinbox is NOT wired into fetch-jobs.mjs SOURCES even though the
   function below works: curl with a browser User-Agent gets a clean 200,
   but Node's fetch — with the exact same URL, method, body and headers —
   gets a 403 from Cloudflare every time (cf-ray header, __cf_bm cookie
   present). That's Cloudflare bot management fingerprinting the TLS/HTTP
   client itself, not the request content, and it's the same Node runtime
   GitHub Actions uses — so this would silently contribute 0 jobs in
   production. Kept here (and in verify-sources.mjs) in case it's ever
   worth fetching through something Cloudflare doesn't flag, e.g. a
   headless browser — deliberately not attempting to spoof past it here.
-----------------------------------------------------------------*/
export const INDIAN_ATS = {
  keka: ["ihl"],                // <company>.keka.com — verified live
  darwinbox: ["dbx", "hetero"], // <company>.darwinbox.in — endpoint verified, blocked by Cloudflare for Node
};

const BROWSER_UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
};

export async function keka(slugs = INDIAN_ATS.keka) {
  const out = [];
  for (const s of slugs) {
    try {
      const rows = await getJSON(`https://${s}.keka.com/careers/api/jobs/default/active`);
      for (const j of (Array.isArray(rows) ? rows : rows.data || [])) {
        out.push({
          title: j.title, company: s,
          location: (j.jobLocations || []).map(l => l.city).filter(Boolean).join(", "),
          url: `https://${s}.keka.com/careers/jobdetails/${j.id}`,
          datePosted: j.publishedOn,
          salary: j.salaryRangeFormat || "",
          _src: "Keka",
        });
      }
    } catch { /* skip — some tenants 403 privacy-gate their board */ }
  }
  return out;
}

export async function darwinbox(slugs = INDIAN_ATS.darwinbox) {
  const out = [];
  for (const s of slugs) {
    try {
      const d = await getJSON(`https://${s}.darwinbox.in/ms/candidateapi/job/alljobs`, {
        method: "POST",
        headers: { ...BROWSER_UA, "Content-Type": "application/json" },
        body: JSON.stringify({ page: 1 }),
      });
      for (const j of (d.data || [])) {
        out.push({
          title: j.title || j.designation_display_name, company: s,
          location: (j.officelocation_show_arr_list || []).join(", ") || String(j.locations || "").replace(/\r/g, ""),
          url: `https://${s}.darwinbox.in/ms/candidate/careers/jobDetails/${j.id}`,
          datePosted: j.posted_on ? new Date(j.posted_on * 1000).toISOString() : j.created_on,
          workplaceType: j.is_remote ? "Remote" : "",
          _src: "Darwinbox",
        });
      }
    } catch { /* skip — Cloudflare challenge or tenant down */ }
  }
  return out;
}
