// Pattern analysis across all 100 researched apps.
// Produces headline insights (the "patterns" the assignment asks for) from the
// genuine research records, plus per-category breakdowns.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data", "patterns.json");

export function analyze(records) {
  // Use the top-level (canonical) record fields, not r.final. The matrix and the
  // patterns must read the exact same fields, otherwise the headline disagrees
  // with the findings table. r.final is LLM output and is intentionally ignored
  // here so the numbers shown up top always match the rows below.
  const recs = records;
  const total = recs.length;

  // Auth distribution (count apps, an app may list multiple auth methods)
  const authCount = {};
  for (const r of recs) for (const a of r.auth) authCount[a] = (authCount[a] || 0) + 1;

  // Self-serve vs gated overall and by group
  const ss = { "self-serve": 0, gated: 0 };
  const byGroup = {};
  for (const r of recs) {
    ss[r.selfServe] = (ss[r.selfServe] || 0) + 1;
    const g = (byGroup[r.group] = byGroup[r.group] || { total: 0, "self-serve": 0, gated: 0, buildable: 0, partial: 0, blocked: 0, apps: [] });
    g.total++;
    g[r.selfServe]++;
    g[r.verdict]++;
    g.apps.push({ name: r.name, selfServe: r.selfServe, verdict: r.verdict, blocker: r.blocker });
  }

  // Verdict distribution
  const verdict = { buildable: 0, partial: 0, blocked: 0 };
  for (const r of recs) verdict[r.verdict] = (verdict[r.verdict] || 0) + 1;

  // Blockers: most common
  const blockers = {};
  for (const r of recs) {
    if (r.verdict !== "buildable") {
      // normalize blocker text to a short tag
      const b = normalizeBlocker(r.blocker);
      blockers[b] = (blockers[b] || 0) + 1;
    }
  }

  // Composio coverage
  const composioCount = recs.filter((r) => r.composioSupported).length;

  // Doc retrieval source distribution (live / wayback / unreachable)
  const docSources = {};
  for (const r of recs) {
    const s = r.docsSource || "none";
    docSources[s] = (docSources[s] || 0) + 1;
  }

  // Easy wins (self-serve + buildable) vs needs outreach (gated/blocked)
  const easyWins = recs.filter((r) => r.selfServe === "self-serve" && r.verdict === "buildable");
  const needsOutreach = recs.filter((r) => r.selfServe === "gated" || r.verdict === "blocked");

  const insights = [
    {
      title: "OAuth2 dominates auth",
      detail: `${authCount.OAuth2 || 0} of ${total} apps expose OAuth2 as a primary auth method, with API keys the main fallback (${
        authCount.APIKey || 0
      }). Basic auth is rare (${authCount.Basic || 0}). This means managed OAuth is the highest-leverage capability for a toolkit platform.`
    },
    {
      title: "Most apps are self-serve",
      detail: `${ss["self-serve"]} of ${total} apps let a developer get credentials themselves (free or trial); ${ss.gated} are gated behind a paid plan, admin approval, or contact-sales. The gated cluster is concentrated in enterprise/fintech categories.`
    },
    {
      title: "Buildability is high but rarely zero-effort",
      detail: `${verdict.buildable} buildable today, ${verdict.partial} partial (need a connector but the API exists), ${verdict.blocked} blocked. The most common blocker is "${topBlocker(
        blockers
      )}".`
    },
    {
      title: "Composio already covers the bulk of demand",
      detail: `${composioCount} of ${total} apps already have a Composio toolkit with genuine tool/trigger counts. The long tail (open-source CLI tools, niche fintech, media-native AI apps) is where new build work lives.`
    },
    {
      title: "Easy wins vs outreach",
      detail: `${easyWins.length} apps are immediate easy wins (self-serve + buildable). ${needsOutreach.length} need partnership/outreach or have a real blocker. Prioritize the former for fast toolkit parity.`
    }
  ];

  const result = {
    total,
    authCount,
    selfServe: ss,
    verdict,
    blockers,
    composioCount,
    docSources,
    byGroup,
    easyWins: easyWins.map((r) => ({ id: r.id, name: r.name, group: r.group })),
    needsOutreach: needsOutreach.map((r) => ({ id: r.id, name: r.name, group: r.group, verdict: r.verdict, blocker: r.blocker })),
    insights
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  return result;
}

function normalizeBlocker(b) {
  const t = (b || "").toLowerCase();
  if (t.includes("partner") || t.includes("contact sales") || t.includes("enterprise") || t.includes("approval"))
    return "Partner / contact-sales gate";
  if (t.includes("oauth") && (t.includes("partner") || t.includes("restricted"))) return "Restricted OAuth scope";
  if (t.includes("no public") || t.includes("no doc") || t.includes("undocumented") || t.includes("private"))
    return "No public / undocumented API";
  if (t.includes("pay") || t.includes("paid") || t.includes("subscription") || t.includes("plan"))
    return "Paid plan required for API";
  if (t.includes("mcp") || t.includes("agent")) return "No MCP / agent surface yet";
  if (t.includes("none")) return "No blocker";
  return (b || "Other").slice(0, 60);
}

function topBlocker(blockers) {
  const entries = Object.entries(blockers).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries[0][0] : "n/a";
}

export { topBlocker, normalizeBlocker };

import { pathToFileURL } from "url";
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "research.json"), "utf8"));
  const r = analyze(data.records);
  console.log("Patterns written. Insights:", r.insights.length);
  process.exit(0);
}
