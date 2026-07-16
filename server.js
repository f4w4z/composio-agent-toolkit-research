// Express service: runs the research agent + verification, serves the HTML case study.
// Endpoints:
//   GET  /                       -> the case study HTML (single self-explanatory page)
//   GET  /api/status             -> pipeline status / latest data summary
//   GET  /api/research           -> full research records (100 apps)
//   GET  /api/patterns           -> computed patterns/insights
//   GET  /api/verification       -> verification results (sample accuracy)
//   POST /api/research/run       -> (re)run the research pipeline (auth via ?key=ADMIN_KEY or header)
//   POST /api/verify/run         -> (re)run verification on current research
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadEnv } from "./src/env.js";
import { configureLLM } from "./src/llm.js";
import { configureComposio } from "./src/composio.js";
import { runResearch } from "./src/research.js";
import { runVerification } from "./src/verify.js";
import { analyze } from "./src/patterns.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DATA = path.join(ROOT, "data");
const PUBLIC = path.join(ROOT, "public");

loadEnv();
const PORT = process.env.PORT || 6768;
const ADMIN_KEY = process.env.ADMIN_KEY || "intern-demo";

configureLLM(process.env.OPENROUTER_API_KEY);
configureComposio(process.env.COMPOSIO_API_KEY);

const app = express();
app.use(express.json());

// Never cache the page or API responses, so the live data is always fresh.
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

function readJson(name) {
  const p = path.join(DATA, name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Running-state guard so concurrent runs don't clobber.
const state = { researching: false, verifying: false, lastRun: null };

app.get("/api/status", (req, res) => {
  const research = readJson("research.json");
  const verification = readJson("verification.json");
  res.json({
    state,
    hasResearch: !!research,
    hasVerification: !!verification,
    total: research?.records?.length ?? 0,
    generatedAt: research?.generatedAt ?? null
  });
});

app.get("/api/research", (req, res) => {
  const d = readJson("research.json");
  if (!d) return res.status(404).json({ error: "No research data. Run /api/research/run first." });
  res.json(d);
});

app.get("/api/patterns", (req, res) => {
  let p = readJson("patterns.json");
  if (!p) {
    const d = readJson("research.json");
    if (!d) return res.status(404).json({ error: "No research data." });
    p = analyze(d.records);
  }
  res.json(p);
});

app.get("/api/verification", (req, res) => {
  const d = readJson("verification.json");
  if (!d) return res.status(404).json({ error: "No verification data. Run /api/verify/run first." });
  res.json(d);
});

function authorized(req) {
  const k = req.query.key || req.headers["x-admin-key"];
  return k === ADMIN_KEY;
}

app.post("/api/research/run", async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });
  if (state.researching) return res.status(409).json({ error: "already running" });
  state.researching = true;
  res.json({ started: true });
  (async () => {
    try {
      const { records } = await runResearch({});
      analyze(records);
      state.lastRun = new Date().toISOString();
    } catch (e) {
      console.error("research run failed:", e.message);
    } finally {
      state.researching = false;
    }
  })();
});

app.post("/api/verify/run", async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });
  if (state.verifying) return res.status(409).json({ error: "already running" });
  const d = readJson("research.json");
  if (!d) return res.status(400).json({ error: "run research first" });
  state.verifying = true;
  res.json({ started: true });
  (async () => {
    try {
      await runVerification(d.records);
    } catch (e) {
      console.error("verify run failed:", e.message);
    } finally {
      state.verifying = false;
    }
  })();
});

// Serve the single-page case study.
app.get("/", (req, res) => {
  const html = path.join(PUBLIC, "index.html");
  if (!fs.existsSync(html)) return res.status(404).send("Build the HTML in public/index.html");
  res.sendFile(html);
});

// Only bind a port when running as a long-lived server (local). On Vercel the
// app is imported by api/index.js and handled per-request, so skip listening.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Composio research agent running at http://localhost:${PORT}`);
  });
}

// Exported for serverless deployments (Vercel) that reuse this Express app.
export default app;
