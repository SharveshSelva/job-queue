/**
 * Checks every free source and every company slug, live.
 * Run:  node scripts/verify-sources.mjs
 *
 * Nothing here costs money or needs a key. Use it after changing COMPANIES
 * in free-sources.mjs to see which slugs actually resolve — a wrong slug
 * fails silently during the real fetch, so this is how you catch it.
 */
import * as free from "./free-sources.mjs";

const ok = s => `\x1b[32m${s}\x1b[0m`;
const bad = s => `\x1b[31m${s}\x1b[0m`;
const dim = s => `\x1b[90m${s}\x1b[0m`;

async function timed(fn) {
  const t = Date.now();
  try { return { rows: await fn(), ms: Date.now() - t }; }
  catch (e) { return { err: e.message, ms: Date.now() - t }; }
}

console.log("\n=== AGGREGATORS (no company list needed) ===\n");
for (const [name, fn] of [
  ["RemoteOK",  () => free.remoteok()],
  ["Remotive",  () => free.remotive("react developer")],
  ["Arbeitnow", () => free.arbeitnow()],
  ["HN Hiring", () => free.hnWhoIsHiring("react")],
  ["Jobicy",    () => free.jobicy("react")],
  ["Himalayas", () => free.himalayas("react")],
  ["WWR",       () => free.weworkremotely("react")],
]) {
  const { rows, err, ms } = await timed(fn);
  if (err) console.log(`  ${bad("✗")} ${name.padEnd(12)} ${bad(err)} ${dim(ms + "ms")}`);
  else {
    console.log(`  ${ok("✓")} ${name.padEnd(12)} ${String(rows.length).padStart(4)} jobs ${dim(ms + "ms")}`);
    if (rows[0]) console.log(`      ${dim("e.g. " + String(rows[0].title).slice(0, 62))}`);
  }
}

console.log("\n=== COMPANY BOARDS (per slug) ===\n");
const fns = {
  greenhouse: free.greenhouse,
  lever: free.lever,
  ashby: free.ashby,
  smartrecruiters: free.smartrecruiters,
};

const dead = {};
for (const [ats, slugs] of Object.entries(free.COMPANIES)) {
  console.log(`  ${ats}`);
  dead[ats] = [];
  for (const slug of slugs) {
    const { rows, err } = await timed(() => fns[ats]([slug]));
    const n = rows ? rows.length : 0;
    if (err || n === 0) {
      dead[ats].push(slug);
      console.log(`    ${bad("✗")} ${slug.padEnd(34)} ${dim(err || "0 jobs / bad slug")}`);
    } else {
      console.log(`    ${ok("✓")} ${slug.padEnd(34)} ${String(n).padStart(3)} jobs`);
    }
  }
  console.log("");
}

console.log("=== INDIAN ATS ===\n");
// Freshteam and Zoho Recruit aren't checked here — both were confirmed to
// require an authenticated API (401 on the real endpoint, no public JSON
// alternative) and were removed from free-sources.mjs and the SOURCES
// registry in fetch-jobs.mjs entirely. See free-sources.mjs for details.
const indian = { keka: free.keka, darwinbox: free.darwinbox };
for (const [name, fn] of Object.entries(indian)) {
  const slugs = free.INDIAN_ATS[name] || [];
  if (!slugs.length) { console.log(`  ${dim("–")} ${name.padEnd(14)} ${dim("no companies configured — add slugs to INDIAN_ATS in free-sources.mjs")}`); continue; }
  const { rows, err } = await timed(() => fn(slugs));
  if (err || !rows?.length) console.log(`  ${bad("✗")} ${name.padEnd(14)} ${dim(err || "0 jobs — endpoint pattern may be wrong")}`);
  else console.log(`  ${ok("✓")} ${name.padEnd(14)} ${rows.length} jobs`);
}
console.log("");

const totalDead = Object.values(dead).flat().length;
if (totalDead) {
  console.log(dim("Slugs that returned nothing — remove or correct them in free-sources.mjs:"));
  for (const [ats, list] of Object.entries(dead)) {
    if (list.length) console.log(`  ${ats}: ${list.join(", ")}`);
  }
  console.log(dim("\nFind the right slug by opening the company's careers page and reading"));
  console.log(dim("the URL: boards.greenhouse.io/<slug>, jobs.lever.co/<slug>, etc.\n"));
} else {
  console.log(ok("All slugs live.\n"));
}
