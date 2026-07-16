// Core research agent.
// For each app: (1) pull genuine data from Composio SDK, (2) use the LLM to
// classify self-serve vs gated, API breadth, buildability verdict + blocker,
// and cite evidence. Apps Composio lacks are classified LLM-only (honestly flagged).
import { APPS, SLUG_HINTS } from "./apps.js";
import { configureComposio, getToolkit, summarizeAuth } from "./composio.js";
import { chat, parseJSON, configureLLM } from "./llm.js";
import { fetchDocs } from "./fetch.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data", "research.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slugFor(app) {
  return SLUG_HINTS[app.name] ?? null;
}

// FIRST PASS: fast classification with minimal context (used to measure raw accuracy).
const FIRST_PASS_PROMPT = (app, composio) => [
  {
    role: "system",
    content:
      "You are a senior API integrations researcher for Composio, a platform that turns SaaS apps into tools AI agents can call. " +
      "Given an app, classify it for 'agent-toolkit buildability'. Respond ONLY with a JSON object, no prose, no code fences. " +
      "Schema: { " +
      '"oneLiner": string (one-line what it does), ' +
      '"auth": array of strings from [OAuth2, APIKey, Basic, BearerToken, Other], ' +
      '"selfServe": "self-serve" | "gated", ' +
      '"selfServeNote": string (why), ' +
      '"apiSurface": string (documented public REST/GraphQL? roughly how broad? existing MCP?), ' +
      '"verdict": "buildable" | "blocked" | "partial", ' +
      '"blocker": string (main blocker if not buildable, else "none"), ' +
      '"evidence": string (the docs URL behind the answer) }'
  },
  {
    role: "user",
    content:
      `App: ${app.name}\nCategory: ${app.group}\nHint/doc URL: ${app.hint}\n` +
      (composio
        ? `Composio catalogue (genuine): supported=${composio.composioSupported}, authModes=${JSON.stringify(
            composio.authModes
          )}, tools=${composio.toolCount}, triggers=${composio.triggerCount}, baseUrl=${composio.baseUrl}.`
        : "Composio does not yet list this toolkit (no Composio data available).")
  }
];

// FINAL PASS: richer classification grounded in actually-retrieved doc text.
const FINAL_PASS_PROMPT = (app, composio, docsText = "", docsSource = "none") => [
  {
    role: "system",
    content:
      "You are a senior API integrations researcher for Composio. Classify an app for 'agent-toolkit buildability' " +
      "using its public developer docs at the hint URL. Be precise and evidence-based. " +
      "Respond ONLY with a JSON object. Schema: { " +
      '"oneLiner": string, ' +
      '"category": string (refine the group into a precise one-word-ish domain), ' +
      '"auth": array of strings from [OAuth2, APIKey, Basic, BearerToken, Other], ' +
      '"selfServe": "self-serve" | "gated", ' +
      '"selfServeNote": string (free/trial self-serve vs paid-plan/admin/partner/contact-sales gate; cite what tier), ' +
      '"apiSurface": string (documented public REST/GraphQL? breadth? any existing MCP server or agent skills?), ' +
      '"verdict": "buildable" | "blocked" | "partial", ' +
      '"blocker": string (main blocker if not buildable, else "none"), ' +
      '"evidence": string (the specific docs/article URL behind this answer) }'
  },
  {
    role: "user",
    content:
      `App: ${app.name}\nGroup: ${app.group}\nDeveloper docs hint: ${app.hint}\n` +
      (composio
        ? `VERIFIED Composio catalogue data: authModes=${JSON.stringify(
            composio.authModes
          )}, tools=${composio.toolCount}, triggers=${composio.triggerCount}, baseUrl=${composio.baseUrl}, categories=${JSON.stringify(
            composio.categories
          )}.`
        : "Composio does not list this toolkit yet (no Composio catalogue data; rely on the docs).") +
      (docsText
        ? `\n\nRETRIEVED DOCS TEXT (from ${docsSource} fetch of ${app.hint}):\n"""\n${docsText}\n"""`
        : `\n\nNOTE: the developer docs could not be fetched (${docsSource}); classify from the Composio data and general knowledge, and say so in selfServeNote if uncertain.`)
  }
];


async function classify(app, composio, pass) {
  let docsText = "", docsSource = "none";
  if (pass === "final") {
    // Real retrieval: fetch the actual developer docs (live, else Wayback, else flagged).
    const fetched = await fetchDocs(app.hint);
    docsText = fetched.text || "";
    docsSource = fetched.source; // 'live' | 'wayback' | 'unreachable'
  }
  const prompt = pass === "first" ? FIRST_PASS_PROMPT(app, composio) : FINAL_PASS_PROMPT(app, composio, docsText, docsSource);
  // llm.js already retries across models with its own backoff; one attempt here is enough.
  const { text, model } = await chat(prompt, { json: true, max_tokens: 800 });
  const obj = parseJSON(text);
  return { ...obj, _model: model, _docsSource: docsSource };
}

function normalize(record, composio, pass) {
  const auth = Array.isArray(record.auth) ? record.auth : [];
  const selfServe = record.selfServe === "gated" ? "gated" : "self-serve";
  return {
    id: record._id,
    name: record._name,
    group: record._group,
    hint: record._hint,
    oneLiner: record.oneLiner || "",
    category: record.category || record._group,
    auth,
    authPrimary: auth[0] || "Unknown",
    selfServe,
    selfServeNote: record.selfServeNote || "",
    apiSurface: record.apiSurface || "",
    verdict: record.verdict || "partial",
    blocker: record.blocker || "none",
    evidence: record.evidence || record._hint,
    composioSupported: !!composio,
    composioTools: composio?.toolCount ?? null,
    composioTriggers: composio?.triggerCount ?? null,
    composioAuth: composio?.authModes ?? null,
    pass
  };
}

// Run the full research pipeline.
// Returns { records, stats }. Saves to data/research.json.
export async function runResearch({ firstPassOnly = false, limit = null } = {}) {
  const apps = limit ? APPS.slice(0, limit) : APPS;
  // Resume support: load prior records, skip already-done app ids.
  let records = [];
  if (fs.existsSync(OUT)) {
    try {
      const prior = JSON.parse(fs.readFileSync(OUT, "utf8"));
      if (Array.isArray(prior.records)) records = prior.records.filter((r) => r && r.id != null);
    } catch {}
  }
  const doneIds = new Set(records.map((r) => r.id));
  const todo = apps.filter((a) => !doneIds.has(a.id));
  if (todo.length < apps.length) process.stdout.write(`Resuming: ${todo.length} remaining of ${apps.length}\n`);

  for (const app of todo) {
    const slug = slugFor(app);
    const tk = await getToolkit(slug);
    const composio = summarizeAuth(tk);

    let first, final = null, error = null;
    try {
      // FIRST PASS
      first = await classify(app, composio, "first");
      if (!firstPassOnly) {
        await sleep(2500);
        final = await classify(app, composio, "final");
      }
    } catch (e) {
      error = e.message;
      process.stdout.write(`#${app.id} ${app.name}: ERROR ${e.message}\n`);
    }

    if (!first) {
      // Record a placeholder so the run continues and the app is not lost.
      records.push({
        id: app.id, name: app.name, group: app.group, hint: app.hint,
        oneLiner: "", category: app.group, auth: [], authPrimary: "Unknown",
        selfServe: "gated", selfServeNote: "classification failed", apiSurface: "",
        verdict: "partial", blocker: "classification failed: " + error, evidence: app.hint,
        composioSupported: !!composio, composioTools: composio?.toolCount ?? null,
        composioTriggers: composio?.triggerCount ?? null, composioAuth: composio?.authModes ?? null,
        pass: "first", failed: true, final: null
      });
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), records, stats: computeStats(records) }, null, 2));
      await sleep(4000);
      continue;
    }

    const firstRec = normalize({ ...first, _id: app.id, _name: app.name, _group: app.group, _hint: app.hint }, composio, "first");
    records.push({
      ...firstRec,
      docsSource: final?._docsSource ?? first._docsSource ?? "none",
      final: final
        ? normalize({ ...final, _id: app.id, _name: app.name, _group: app.group, _hint: app.hint }, composio, "final")
        : null
    });
    process.stdout.write(`#${app.id} ${app.name}: composio=${!!composio} pass1=${first.verdict} model=${first._model}\n`);
    // Incremental checkpoint so an interrupted run can resume.
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), records, stats: computeStats(records) }, null, 2));
    await sleep(4000);
  }

  const stats = computeStats(records);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), records, stats }, null, 2));
  return { records, stats };
}

export function computeStats(records) {
  const total = records.length;
  const withFinal = records.filter((r) => r.final);
  const authCount = {};
  const selfServeCount = { "self-serve": 0, gated: 0 };
  const verdictCount = { buildable: 0, partial: 0, blocked: 0 };
  const groupSelfServe = {};
  const composioCount = 0;
  for (const r of records) {
    const rec = r.final || r;
    for (const a of rec.auth) authCount[a] = (authCount[a] || 0) + 1;
    selfServeCount[rec.selfServe] = (selfServeCount[rec.selfServe] || 0) + 1;
    verdictCount[rec.verdict] = (verdictCount[rec.verdict] || 0) + 1;
    const g = rec.group;
    groupSelfServe[g] = groupSelfServe[g] || { "self-serve": 0, gated: 0, total: 0 };
    groupSelfServe[g][rec.selfServe] = (groupSelfServe[g][rec.selfServe] || 0) + 1;
    groupSelfServe[g].total += 1;
  }
  const composioSupported = records.filter((r) => r.composioSupported).length;
  return {
    total,
    authCount,
    selfServeCount,
    verdictCount,
    groupSelfServe,
    composioSupported,
    withFinal: withFinal.length
  };
}

// Allow running directly: node src/research.js
import { pathToFileURL } from "url";
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const key = process.env.OPENROUTER_API_KEY;
  const ckey = process.env.COMPOSIO_API_KEY;
  if (!key || !ckey) {
    console.error("Set OPENROUTER_API_KEY and COMPOSIO_API_KEY in .env");
    process.exit(1);
  }
  configureLLM(key);
  configureComposio(ckey);
  const limit = process.argv[2] ? parseInt(process.argv[2]) : null;
  runResearch({ limit }).then(() => {
    console.log("Done. Wrote", OUT);
    process.exit(0);
  });
}

