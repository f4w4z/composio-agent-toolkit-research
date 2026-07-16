// Composio SDK wrapper. Pulls genuine catalogue data for each app:
// auth schemes, tool/trigger counts, base URL, categories, managed auth.
import { Composio } from "@composio/core";

let client = null;
export function configureComposio(apiKey) {
  client = new Composio({ apiKey });
}

// Fetch the toolkit record for a given slug. Returns null if not in Composio.
export async function getToolkit(slug) {
  if (!slug) return null;
  try {
    const tk = await client.toolkits.get(slug, {});
    return tk;
  } catch (e) {
    // 404 / not found => Composio doesn't have this toolkit yet.
    return null;
  }
}

// Given a toolkit record, derive a normalized auth summary.
export function summarizeAuth(tk) {
  if (!tk) return null;
  const schemes = tk.composioManagedAuthSchemes || [];
  const details = Array.isArray(tk.authConfigDetails) ? tk.authConfigDetails : [];
  const modes = [...new Set(details.map((d) => d.mode).filter(Boolean))];
  return {
    managedSchemes: schemes,
    authModes: modes.length ? modes : schemes,
    toolCount: tk.meta?.toolsCount ?? tk.toolsCount ?? null,
    triggerCount: tk.meta?.triggersCount ?? tk.triggersCount ?? null,
    baseUrl: tk.baseUrl ?? null,
    categories: (tk.meta?.categories || []).map((c) => c.name),
    description: tk.meta?.description ?? tk.description ?? null,
    composioSupported: true
  };
}
