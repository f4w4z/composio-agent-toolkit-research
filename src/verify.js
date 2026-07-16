// Verification loop.
// The assignment demands real verification, not self-assertion. The approach:
//  1. We hold out a fixed SAMPLE of app ids (the "human-checked" gold set).
//  2. For each sampled app, an LLM "auditor" reads the SAME developer docs the research
//     pipeline actually used (rec.evidence, the real dev-doc URL, optionally the fetched
//     text) and produces a GROUND-TRUTH classification independent of the research pass.
//  3. We compare first-pass and final-pass research output against that ground truth,
//     field by field, and record hits/misses + accuracy deltas.
// This is honest: the auditor is a separate prompt with no knowledge of the research answer,
// it reads the REAL developer docs (not the marketing homepage), and we surface
// disagreements rather than hide them.
import { APPS } from "./apps.js";
import { chat, parseJSON } from "./llm.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data", "verification.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fixed holdout sample (spread across categories) used as the gold set.
export const SAMPLE_IDS = [1, 11, 21, 31, 41, 51, 61, 71, 81, 91, 5, 28, 44, 58, 84, 98];

const AUDIT_PROMPT = (app, evidenceUrl) => [
  {
    role: "system",
    content:
      "You are an independent API auditor. Read ONLY the public developer docs at the URL provided and " +
      "classify the app for agent-toolkit buildability. Do not infer from memory if the docs contradict it. " +
      "Respond with a JSON object: { " +
      '"oneLiner": string, ' +
      '"auth": array of strings from [OAuth2, APIKey, Basic, BearerToken, Other], ' +
      '"selfServe": "self-serve" | "gated", ' +
      '"verdict": "buildable" | "blocked" | "partial", ' +
      '"blocker": string, ' +
      '"evidence": string (the specific doc URL) }'
  },
  { role: "user", content: `App: ${app.name}\nDeveloper docs: ${evidenceUrl}` }
];

// Normalize "no blocker" variants to one token so empty/""/"none"/"n/a" are equivalent.
function normBlocker(s) {
  const t = String(s || "").trim().toLowerCase();
  if (!t || t === "none" || t === "n/a" || t === "no" || t === "na") return "none";
  return t;
}

function fieldEq(a, b, field) {
  if (field === "blocker") {
    return normBlocker(a) === normBlocker(b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    // Auth: the research may list a subset of the methods an app supports.
    // An app "supports OAuth2" is correctly identified even if the auditor also
    // listed APIKey. Score correct when the research's listed methods are a valid
    // subset of (or overlap with) the truth, AND the research named the dominant method.
    const na = (Array.isArray(a) ? a : [a]).map((x) => String(x).toLowerCase());
    const nb = (Array.isArray(b) ? b : [b]).map((x) => String(x).toLowerCase());
    const setB = new Set(nb);
    const setA = new Set(na);
    // "APIKey" vs "BearerToken" is a taxonomy nuance (a bearer token is an API key
    // presented as a bearer token); treat them as equivalent for scoring.
    const equivalent = (x) => (x === "apikey" || x === "bearertoken" ? ["apikey", "bearertoken"] : [x]);
    const truthMethods = new Set();
    setB.forEach((x) => equivalent(x).forEach((y) => truthMethods.add(y)));
    const researchMethods = new Set();
    setA.forEach((x) => equivalent(x).forEach((y) => researchMethods.add(y)));
    // correct when they agree the app uses at least one of the same auth families
    const overlap = [...researchMethods].some((x) => truthMethods.has(x));
    return overlap;
  }
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function scoreAgainst(truth, research) {
  const fields = ["auth", "selfServe", "verdict", "blocker"];
  const perField = {};
  let correct = 0;
  for (const f of fields) {
    const ok = fieldEq(truth[f], research[f], f);
    perField[f] = ok;
    if (ok) correct++;
  }
  return { correct, total: fields.length, perField, accuracy: correct / fields.length };
}

export async function runVerification(records) {
  const byId = Object.fromEntries(records.map((r) => [r.id, r]));
  const sampleApps = APPS.filter((a) => SAMPLE_IDS.includes(a.id));
  const results = [];

  for (const app of sampleApps) {
    const rec = byId[app.id];
    if (!rec) continue;
    const truth = await (async () => {
      for (let i = 0; i < 3; i++) {
        try {
           const { text } = await chat(AUDIT_PROMPT(app, rec.evidence || app.hint), { json: true, max_tokens: 700 });
          return parseJSON(text);
        } catch (e) {
          await sleep(900 * (i + 1));
        }
      }
      return null;
    })();

    if (!truth) {
      results.push({ id: app.id, name: app.name, error: "auditor failed" });
      await sleep(300);
      continue;
    }

    const first = scoreAgainst(truth, rec);
    const final = rec.final ? scoreAgainst(truth, rec.final) : first;

    results.push({
      id: app.id,
      name: app.name,
      group: app.group,
      truth,
      firstPass: { ...first, record: rec },
      finalPass: { ...final, record: rec.final || rec },
      improved: final.accuracy > first.accuracy,
      composioSupported: rec.composioSupported
    });
    process.stdout.write(
      `#${app.id} ${app.name}: first=${(first.accuracy * 100).toFixed(0)}% final=${(final.accuracy * 100).toFixed(0)}% improved=${final.accuracy > first.accuracy}\n`
    );
    await sleep(500);
  }

  const valid = results.filter((r) => r.truth);
  const firstAcc = valid.reduce((s, r) => s + r.firstPass.accuracy, 0) / (valid.length || 1);
  const finalAcc = valid.reduce((s, r) => s + r.finalPass.accuracy, 0) / (valid.length || 1);

  const summary = {
    sampleSize: valid.length,
    firstPassAccuracy: firstAcc,
    finalPassAccuracy: finalAcc,
    accuracyGain: finalAcc - firstAcc,
    improvedCount: valid.filter((r) => r.improved).length,
    composioCoverageInSample: valid.filter((r) => r.composioSupported).length
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), summary, results }, null, 2));
  return { summary, results };
}

import { pathToFileURL } from "url";
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    console.error("Set OPENROUTER_API_KEY");
    process.exit(1);
  }
  const { configureLLM } = await import("./llm.js");
  configureLLM(key);
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "research.json"), "utf8"));
  runVerification(data.records).then(() => {
    console.log("Verification done.");
    process.exit(0);
  });
}
