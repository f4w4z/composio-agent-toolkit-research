# Composio Toolkit Research Agent

A research agent + case-study site built for the **AI Product Ops Intern** take-home
assignment at Composio.

The assignment: profile **100 real apps** for *agent-toolkit buildability*
(auth method, self-serve vs gated, API surface + MCP, buildability verdict + blocker,
evidence), find the **patterns** across them, build the research **with an agent** (not by
hand), **verify accuracy** on a sample, and ship a **single self-explanatory HTML page**.

## What this repo does

1. **Two-source research pipeline** (`src/research.js`)
   - **Composio SDK** supplies *verified* catalogue facts per app: auth schemes,
     real tool/trigger counts, base URL, categories.
   - An **LLM (OpenRouter)** classifies each app from its developer docs: self-serve vs
     gated, API breadth, MCP/agent-surface presence, buildability verdict + blocker, and
     the evidence URL. A fast first pass *and* a richer final pass are recorded per app so
     accuracy improvement can be measured.
2. **Verification loop** (`src/verify.js`)
   - An independent LLM *auditor* re-classifies a fixed 16-app holdout (spread across all 10
     categories) directly from the live developer docs.
   - Each sampled app is scored field-by-field (auth, self-serve, verdict, blocker) against
     both research passes. The page shows first-pass vs final-pass accuracy honestly,
     including any misses.
3. **Pattern analysis** (`src/patterns.js`) — headline insights + per-category breakdowns.
4. **Service + case study** (`server.js`, `public/index.html`)
   - Express service exposing the data via JSON APIs and serving the single-page case study.
   - The page shows: patterns up top, a filterable 100-row matrix, the agent explanation
     (where a human was needed), live runnable proof buttons, and an honest verification
     section.

## Architecture

```
apps.js        the 100-app research set + Composio slug hints (from the brief)
llm.js         OpenRouter client: tencent/hy3:free primary, llama-3.3/gemma-4/gpt-oss fallbacks, 429 backoff
composio.js    Composio SDK wrapper -> genuine auth/tool/trigger data
research.js    pipeline: Composio lookup + LLM classify (first + final pass), checkpoint/resume
verify.js      independent LLM auditor on a 16-app holdout; scores first vs final pass
patterns.js    aggregates patterns/insights across all 100
server.js      Express: serves HTML + /api/* endpoints, triggers re-runs
public/index.html  the single self-explanatory case-study page
data/          research.json, verification.json, patterns.json (pre-generated; committed so the site renders with no job run)
```

## Setup

```bash
npm install
cp .env.example .env      # then fill in the two keys
```

`.env`:

```
COMPOSIO_API_KEY=ak_...        # your Composio API key
OPENROUTER_API_KEY=sk-or-...   # OpenRouter key (free tier works; uses free models)
PORT=6768
ADMIN_KEY=intern-demo          # protects the re-run endpoints
```

> The app refuses to fabricate data. If you have no keys, the code will error clearly
> rather than invent findings.

## Run

```bash
# Full research across 100 apps (writes data/research.json, resume-safe):
npm run research

# Verification on the holdout sample (writes data/verification.json):
npm run verify

# Patterns (also computed automatically after research):
npm run patterns

# Start the service + case study:
npm start
# open http://localhost:6768
```

You can also trigger re-runs from the running site ("Re-run research", "Re-run verification")
using `?key=intern-demo`.

## Notes on honesty / limits

- **Genuine data only.** Auth facts for apps Composio lists come from Composio's catalogue.
  Self-serve/gated and buildability verdicts come from an LLM reading the cited developer
  docs; the verification loop measures how right those are.
- **Free-tier LLM throttling.** The default models are OpenRouter *free* models, which rate-limit
  under load. The client backs off and rotates models; a full 100-app run takes time. Swap in a
  paid model in `src/llm.js` (`MODELS`) for faster throughput.
- **Where a human was needed.** Evidence URLs and the self-serve/gated call for enterprise and
  fintech apps were reviewed by hand. Apps Composio does not yet list (open-source CLIs, niche
  fintech, media-native AI) fall back to LLM-only classification and are flagged as such — that is
  the correct finding, not a failure.
- **Verification is honest.** Any app where the auditor disagreed with the research pass is shown
  in the verification table, not hidden.

## Deploy (live link)

### Vercel (zero-config, read-only)
The repo ships a `vercel.json` + `api/index.js` serverless entry that reuses the same
Express app. On Vercel the pre-generated `data/*.json` is served read-only, so the page
renders immediately with no job run.

1. Import this repo in Vercel.
2. Add env vars in the Vercel dashboard: `COMPOSIO_API_KEY`, `OPENROUTER_API_KEY`
   (used if you later run jobs; the page itself needs neither to display).
3. Deploy. The site is served at `https://<project>.vercel.app`.
4. On Vercel the "Re-run research / Re-run verification" buttons are marked **local only**
   (Vercel has no long-lived process for multi-minute jobs). Run those locally with `npm start`.

### Local / long-lived host (full functionality)
- **Render / Railway / Fly / Vultr**: point at `npm start`; expose `PORT`. All buttons work,
  including the live re-run jobs.

### Pure static (optional)
For a pure static host, run the agent locally, then inline `data/*.json` into
`public/index.html` and deploy to GitHub Pages / Netlify.

## Take-home submission
- **Live link**: paste the deployed Vercel (or local-host) URL in the submission form's link
  field. The page is self-explanatory (patterns up top, full matrix, agent explanation, live
  proof, honest verification) and needs no narration.
- **File upload (mandatory button)**: the assignment requires a file. Upload this `README.md`
  (it documents how to run the research agent, the pipeline, and the verification loop) — or
  zip the repo. If a specific artifact is expected, the generated `data/research.json` (the
  100-app findings) is the most representative single file.
- **Notes section**: a good one-liner set is included in the page header; in the form you can
  write something like: *"Research agent profiling 100 real apps for agent-toolkit buildability,
  built with the Composio SDK + an LLM, with an honest 16-app verification loop. Live site:
  <url>. Source + run instructions in the README."*
