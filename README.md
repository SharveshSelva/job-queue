# The queue

A job feed that updates itself. GitHub Actions runs the scrape twice a day and commits
the results; GitHub Pages serves the app. Install it to your phone's home screen and it
behaves like a native app — including offline.

No server. No monthly bill. Nothing to keep running.

```
GitHub Actions (cron, twice daily)
        │  pulls free job-board APIs (Apify is optional, off by default)
        ▼
   data/jobs.json      ← committed back to the repo
        │
        ▼
GitHub Pages ──► PWA on your phone ──► triage state in localStorage
```

---

## Setup — about 10 minutes, once

### 1. Create the repo

Make a new **public** repo on GitHub (Pages is free on public repos), then push these files:

```bash
git init
git add .
git commit -m "the queue"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/job-queue.git
git push -u origin main
```

### 2. Add your Apify token — optional, skip this if you're only using free sources

The default `SOURCES` list is entirely free job-board APIs — no key, no account, nothing
to top up. This step is only needed if you turn on a paid Apify source (see
[Apify sources](#apify-sources-optional-cost-credits) below).

Get it from **Apify Console → Settings → Integrations → Personal API token**.

In your repo: **Settings → Secrets and variables → Actions → New repository secret**

| Name | Value |
|---|---|
| `APIFY_TOKEN` | your token |

The token only ever exists inside the Action runner. It is never sent to the browser.

### 3. Let the Action write to the repo

**Settings → Actions → General → Workflow permissions** → select **Read and write permissions** → Save.

Without this the fetch runs fine but can't commit, and nothing ever updates.

### 4. Turn on Pages

**Settings → Pages → Source: Deploy from a branch → Branch: `main` / `(root)`** → Save.

Your app appears at `https://YOUR-USERNAME.github.io/job-queue/` within a minute or two.

### 5. Install it on your phone

Open that URL in **Chrome on Android** → menu (⋮) → **Install app** (or *Add to Home screen*).

Chrome installs it properly: it lands in your **app drawer** alongside everything else, opens
**fullscreen with no browser bar**, and uninstalls like any normal app.

If Chrome offers *"Add to Home screen"* instead of *"Install app"*, something's wrong with the
manifest — that variant makes a bookmark that opens in a browser tab. It shouldn't happen here
(PNG icons at 192/512 plus a maskable variant are all present), but that's the tell to watch for.

**It opens instantly.** The shell and the last-known listings are cached, so it paints with
zero network wait — even on no signal. It then checks for newer listings in the background
and tells you *"3 new since you last looked"* if anything arrived. Same again whenever you
switch back to it.

*(iPhone/Safari: Share → Add to Home Screen. Works, but Android's install is better.)*

### 6. Run it once by hand

**Actions → Fetch jobs → Run workflow.** Populates `data/jobs.json` for the first time
without waiting for the cron. Works with no `APIFY_TOKEN` at all if you're only running
free sources.

---

## Tuning what it searches

**Settings → Secrets and variables → Actions → Variables** tab. All optional.

| Variable | Default | Notes |
|---|---|---|
| `SOURCES` | free sources (see below) | Which job boards to pull from — see below |
| `SEARCH_TERMS` | `React Developer,Frontend Developer` | Comma separated. One actor run **per term per source**. |
| `SEARCH_LOCATION` | `Chennai` | Use `Remote` for remote-only |
| `SEARCH_COUNTRY` | `IN` | ISO-2, used by the Indeed actor |
| `SEARCH_COUNTRY_NAME` | `india` | Lowercase name, used by the Wellfound/Google actors |
| `MAX_ITEMS_PER_SOURCE` | `25` | Billing cap per run — raise carefully |
| `MAX_AGE_DAYS` | `45` | Older listings get pruned |

### Sources

**Free sources run by default — no Apify credits, no account, nothing to top up.**
Apify sources are opt-in.

| id | Source | Cost |
|---|---|---|
| `greenhouse` | company boards via `boards-api.greenhouse.io` | free |
| `lever` | company boards via `api.lever.co` | free |
| `ashby` | company boards via `api.ashbyhq.com` | free |
| `smartrecruiters` | company boards | free |
| `remoteok` | global remote aggregator | free |
| `remotive` | global remote aggregator | free |
| `arbeitnow` | global aggregator | free |
| `hn` | HN "Who is Hiring" via Algolia | free |
| `jobicy` | remote aggregator | free |
| `himalayas` | remote aggregator | free |
| `wwr` | We Work Remotely (RSS) | free |
| `workday` | company tenants — needs `WORKDAY_TENANTS`, empty by default | free |
| `keka` | Indian ATS, company boards | free |

**Relevance filtering.** Greenhouse/Lever/Ashby/SmartRecruiters/Keka return *every* opening
at a company (sales, HR, finance included), and RemoteOK/Arbeitnow/Workday return their
*entire* board — none of them support a server-side search. `free.relevant()` in
`scripts/free-sources.mjs` filters all of these down to titles matching `SEARCH_TERMS`
(same word-match approach as `wwr` and `hn`). It's a title match, not a semantic one — good
enough to cut noise, not a guarantee of precision.

**Salary currency.** RemoteOK, Jobicy and Himalayas report pay in USD. `parsePay()` in
`scripts/fetch-jobs.mjs` detects `$`/USD and converts using a hardcoded `USD_INR` constant
(no live FX feed) rather than treating the number as if it were already rupees — a
$120,000/year listing showing as ₹13k/month was silently filtered out by every salary chip
before this. Update `USD_INR` occasionally; it'll drift.

**Date reliability.** Greenhouse and WWR give a real, per-listing posted date. Arbeitnow's
`created_at` and Himalayas' `pubDate` don't — checked live, both cluster within minutes of
whenever you call the API regardless of the actual listing, which reads as "last touched by
their pipeline" rather than "posted by the employer." A listing's date is set once, the
first time this app sees its URL (see the `seen` dedupe in `fetch-jobs.mjs`), so this mostly
just means an old Arbeitnow/Himalayas listing this app happens to see for the first time
today gets stamped as posted today — worth knowing if a card's freshness looks suspicious.

**Freshteam and Zoho Recruit were investigated and dropped** — both only expose job data
through an authenticated API (confirmed 401 on the real endpoint), no free JSON path exists.
**Darwinbox's endpoint is real** (verified live via curl with a browser User-Agent) but sits
behind Cloudflare bot mitigation that blocks Node's `fetch` specifically — the same client
GitHub Actions runs — so it's not wired into `SOURCES` even though the code for it exists in
`free-sources.mjs` (kept in case it's ever fetched through something Cloudflare doesn't flag).

### Adding companies

Company-board sources need a slug per company — edit `COMPANIES` in
`scripts/free-sources.mjs`. The slug is the last path segment of the careers URL:
`boards.greenhouse.io/razorpaysoftwareprivatelimited` → `razorpaysoftwareprivatelimited`.

**A wrong slug fails silently during the real fetch.** Check them with:

```bash
node scripts/verify-sources.mjs
```

That hits every free source and every slug live, prints what each returns, and lists
the dead ones. Costs nothing. Run it whenever you add companies.

### Apify budget guard

Apify sources are **off by default** and capped. `APIFY_BUDGET_USD` (default **$2.00**) is a
hard monthly ceiling, tracked in `data/usage.json` and committed with each run.

Before every paid call the script checks whether the *projected worst-case cost* still fits —
not merely whether budget remains. A call that could overshoot is skipped rather than started.
Verified: with a $2.00 cap it stops at $1.92 and never crosses.

The ledger resets on the 1st of each calendar month. Free sources are never counted and never
blocked.

```bash
gh variable set APIFY_BUDGET_USD --body "1.50"    # tighten it
```

### Apify sources (optional, cost credits)

**All off by default.** None of these run unless you explicitly add them to `SOURCES`.

| id | Actor | Why |
|---|---|---|
| `indeed` | `misceres/indeed-scraper` | Broadest coverage in India. |
| `wellfound` | `orgupdate/wellfound-jobs-scraper` | Startup roles — usually the best listings here. |
| `google` | `orgupdate/google-jobs-scraper` | Aggregates LinkedIn, Glassdoor, ZipRecruiter, careers pages. Widest net, noisiest. |
| `indeed_alt` | `borderline/indeed-scraper` | Fallback if `indeed` starts failing |
| `linkedin` | `aligned_safe/linkedin-jobs-scraper-2026` | Public listings, **no login needed**. |

Turn sources on by listing them: `gh variable set SOURCES --body "indeed,wellfound,google"`

### LinkedIn options

`aligned_safe/linkedin-jobs-scraper-2026` reads public listing pages — no cookies, no login,
nothing touching your account. Extra variables:

| Variable | Values | Notes |
|---|---|---|
| `LINKEDIN_PAGES` | `1`–`20` | 1 page ≈ 25–60 jobs |
| `LINKEDIN_EXPERIENCE` | `internship` `entry` `associate` `mid-senior` `director` `executive` | |
| `LINKEDIN_WORKPLACE` | `remote` `hybrid` `onsite` | |
| `LINKEDIN_LOW_APPLICANTS` | `true` | Only roles with under 10 applicants — fewer applicants, better odds |

Verified against a live run: it returns `job_title`, `company_name`, `job_location`,
`posted_date`, `job_url`, and sometimes `num_applicants`. **Salary is almost always empty
on LinkedIn listings**, so those cards read *Not stated* — that's LinkedIn, not a bug. Indeed
and Wellfound are where the pay figures come from.

**`apify/rag-web-browser` isn't wired in.** It's a general web fetcher, not a job scraper —
no structured job fields to normalise. Useful for other things, not this.

### Cost

The default `SOURCES` list is all free — **$0, always**, regardless of how many terms or
how often the cron runs. `MAX_ITEMS_PER_SOURCE` and Apify's billing only come into play if
you opt into a paid source (see above). Company-board and aggregator sources fetch once per
run and aren't metered at all.

If you do turn on Apify sources: each one runs once per search term, so cost scales as
sources × terms × `MAX_ITEMS_PER_SOURCE`. `APIFY_BUDGET_USD` (see below) is the actual
backstop — it stops paid calls before they'd exceed the monthly cap, independent of this math.

### Schedule

One run a day at 07:00 IST. Edit the cron in `.github/workflows/fetch-jobs.yml` — **it's UTC**,
so `30 1` is 07:00 IST.

## How it behaves

**Triage.** Swipe right to save, left to skip, or use the buttons. Apply opens the real
posting and files the job under Applied so it never resurfaces. Decisions live in
`localStorage` on your phone — they persist across sessions and survive the data
refreshing underneath them.

**Two modes.** *Swipe* for considered decisions, *Scan list* for clearing a backlog fast.
Same queue, same filters.

**Salary.** Job boards rarely populate a structured salary field — the number is usually
buried in the description text. `parsePay()` pulls it out and normalises everything to
₹/month, so a "₹5 LPA" job and a "₹12,000/month" job are actually comparable. Where nothing
parses, the card reads *Not stated* rather than guessing. The ₹ filter chips hide unknowns,
so use them deliberately.

**Applicant count.** Where a source reports it (LinkedIn does, sometimes) the card shows it,
and anything under 10 gets a *FEW APPLICANTS* badge. Low competition is worth chasing.

**Deduping.** Jobs are keyed by a hash of their URL, so the same role showing up on Indeed
and Google Jobs collapses to one card. Re-running never creates duplicates, and a listing
keeps its original `first_seen` date. Each card shows which board it came from.

---

## Cost

| | |
|---|---|
| GitHub Actions | Free (2,000 min/month on public repos; this uses ~2 min/day) |
| GitHub Pages | Free |
| Apify | $0 by default — off unless you opt into a paid source. Free tier is $5/month of credits if you do; `APIFY_BUDGET_USD` caps spend below that. |

---

## When something breaks

**Nothing updates.** Check Actions for a red run. Most common cause is step 3 — workflow
permissions still read-only, so the commit is rejected.

**Action succeeds but no new jobs.** Open the run log. If it says `HTTP 401`, the token is
wrong. If it says `0 raw results`, the actor's input schema has changed — check the actor's
page on Apify and update `buildInput()`.

**App shows old listings.** Tap ↻ in the header to bypass the cache. The service worker
serves `jobs.json` network-first, so this is usually just a stale tab.

**Everything vanished after clearing browser data.** Triage state is `localStorage`, so
clearing site data resets it. The listings come back on next load; your applied/saved
history doesn't.
