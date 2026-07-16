// Vercel serverless entry.
// Reuses the existing Express app (server.js) so the same code runs locally and
// on Vercel. On Vercel only the read endpoints work (the long-running re-run jobs
// are disabled in the UI because Vercel has no long-lived process). All data ships
// pre-generated in /data, so the page renders with no job run needed.
import app from "../server.js";

export default function handler(req, res) {
  return app(req, res);
}
