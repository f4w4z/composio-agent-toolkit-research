// OpenRouter LLM client with a primary model and automatic fallback across several
// free models, with exponential backoff on rate limits (free tier throttles hard).
import fetch from "node-fetch";

// Ordered preference. Primary first, then strong free fallbacks.
const MODELS = [
  "tencent/hy3:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemma-4-31b-it:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "openai/gpt-oss-20b:free"
];

// Some free models reject the json_object response_format. Only request it from models
// that are known to support structured output; for the rest we parse JSON from plain text.
const JSON_SUPPORTED = new Set([
  "tencent/hy3:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemma-4-31b-it:free",
  "openai/gpt-oss-20b:free"
]);

let apiKey = null;
export function configureLLM(key) {
  apiKey = key;
}

async function callModel(model, messages, opts) {
  const useJson = opts.json && JSON_SUPPORTED.has(model);
  const body = {
    model,
    messages,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.max_tokens ?? 800
  };
  if (useJson) body.response_format = { type: "json_object" };
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://composio-intern.local",
      "X-Title": "Composio Toolkit Research Agent"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    // Some models reject response_format (e.g. tencent/hy3). Retry once without it.
    if (res.status === 400 && useJson) {
      const body2 = { ...body, response_format: undefined };
      const res2 = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://composio-intern.local",
          "X-Title": "Composio Toolkit Research Agent"
        },
        body: JSON.stringify(body2)
      });
      if (res2.ok) {
        const data2 = await res2.json();
        return data2.choices?.[0]?.message?.content ?? "";
      }
    }
    const txt = await res.text();
    const err = new Error(`LLM HTTP ${res.status}: ${txt.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// Try models in order; on rate-limit (429) back off and try the next model.
// Overall retries per call with growing backoff so transient throttling recovers.
export async function chat(messages, opts = {}) {
  if (!apiKey) throw new Error("LLM not configured: set OPENROUTER_API_KEY");
  const models = opts.model ? [opts.model] : MODELS;
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const model = models[attempt % models.length];
    try {
      const text = await callModel(model, messages, opts);
      if (text && text.trim()) return { text, model };
      lastErr = new Error("empty response");
    } catch (e) {
      lastErr = e;
      // 429 / 5xx => back off and rotate model
      const wait = 800 * Math.pow(1.5, attempt) + Math.random() * 400;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr || new Error("LLM failed after retries");
}

// Extract a JSON object from a model response that may wrap it in prose/code fences.
export function parseJSON(text) {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}
