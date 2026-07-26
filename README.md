# The queue

A job feed that updates itself. GitHub Actions runs the scrape twice a day and commits
the results; GitHub Pages serves the app. Install it to your phone's home screen and it
behaves like a native app — including offline.

No server. No monthly bill. Nothing to keep running.

```
GitHub Actions (cron, twice daily)
        │  runs an Apify job-scraper actor
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

### 2. Add your Apify token

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

**Actions → Fetch jobs → Run workflow.** Confirms the token works without waiting for the cron.

---

## Tuning what it searches

**Settings → Secrets and variables → Actions → Variables** tab. All optional.

| Variable | Default | Notes |
|---|---|---|
| `SOURCES` | `indeed,wellfound,linkedin` | Which job boards to pull from — see below |
| `SEARCH_TERMS` | `React Developer,Frontend Developer` | Comma separated. One actor run **per term per source**. |
| `SEARCH_LOCATION` | `Chennai` | Use `Remote` for remote-only |
| `SEARCH_COUNTRY` | `IN` | ISO-2, used by the Indeed actor |
| `SEARCH_COUNTRY_NAME` | `india` | Lowercase name, used by the Wellfound/Google actors |
| `MAX_ITEMS_PER_SOURCE` | `25` | Billing cap per run — raise carefully |
| `MAX_AGE_DAYS` | `45` | Older listings get pruned |

### Sources

| id | Actor | Why |
|---|---|---|
| `indeed` | `misceres/indeed-scraper` | Broadest coverage in India. **On by default.** |
| `wellfound` | `orgupdate/wellfound-jobs-scraper` | Startup roles — usually the best listings here. **On by default.** |
| `google` | `orgupdate/google-jobs-scraper` | Aggregates LinkedIn, Glassdoor, ZipRecruiter, careers pages. Widest net, noisiest. |
| `indeed_alt` | `borderline/indeed-scraper` | Fallback if `indeed` starts failing |
| `linkedin` | `aligned_safe/linkedin-jobs-scraper-2026` | Public listings, **no login needed**. **On by default.** |

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

Every source runs once per search term. With the defaults — 3 sources × 2 terms × 25 items
— that's about 150 results a day, comfortably inside Apify's $5/month free credit.

Adding sources or terms multiplies this. 4 sources × 4 terms × 50 items is 800 results/day,
which will burn through the free tier. `MAX_ITEMS_PER_SOURCE` is passed to Apify as a hard
billing cap, so raising it is the main lever to watch.

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
| Apify | Free tier is $5/month of credits. Defaults sit well inside it — see Cost above before adding sources. |

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
