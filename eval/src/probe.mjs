// Gateway reachability probe.
//
// Runs BEFORE the suite so we can tell an infra failure (Gridlight gateway
// down) apart from a model failure (gateway up, model got the task wrong). A
// down gateway would make every task fail and be scored as a confident 0%
// blamed on the model — the exact false signal this probe exists to prevent.
//
// Backend-aware:
//   - gridlight (default): the terminal talks to the local Gridlight gateway
//     (default http://localhost:8080), which selects the model server-side.
//     We can only check liveness — GET /health (any HTTP response = listening).
//   - openai-compatible: the terminal talks to an external local server
//     (Ollama / LM Studio / vLLM) where the model id is explicit, so we also
//     verify GRIDLIGHT_MODEL actually appears in GET /v1/models.

/**
 * @param {string} gatewayUrl  e.g. http://localhost:8080 (Gridlight) or :11434 (Ollama)
 * @param {string} model       the model id the run will request
 * @param {'gridlight'|'openai-compatible'} backendMode
 * @param {number} timeoutMs
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function probeGateway(gatewayUrl, model, backendMode = 'gridlight', timeoutMs = 4000) {
  const base = gatewayUrl.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    if (backendMode === 'openai-compatible') {
      const url = `${base}/v1/models`;
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return { ok: false, detail: `gateway returned ${res.status} at ${url}` };
      let ids = [];
      try {
        ids = ((await res.json())?.data || []).map((m) => m?.id).filter(Boolean);
      } catch {
        return { ok: true, detail: `gateway up at ${url} (model list unparseable — could not verify "${model}")` };
      }
      if (model && ids.length && !ids.some((id) => id === model || id.startsWith(model) || model.startsWith(id))) {
        return { ok: false, detail: `model "${model}" not served (has: ${ids.slice(0, 8).join(', ') || 'none'})` };
      }
      return { ok: true, detail: `gateway up at ${url}, serving "${model}"` };
    }

    // gridlight backend: liveness only (model is chosen server-side).
    const url = `${base}/health`;
    const headers = {};
    if (process.env.GRIDLIGHT_API_TOKEN) headers.Authorization = `Bearer ${process.env.GRIDLIGHT_API_TOKEN}`;
    const res = await fetch(url, { method: 'GET', headers, signal: ctrl.signal });
    // Any HTTP status means the gateway is listening (401/404 included) — enough
    // to rule out "server down". Model correctness is what the suite measures.
    return { ok: true, detail: `Gridlight gateway responded ${res.status} at ${url}` };
  } catch (err) {
    const msg = err?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : String(err?.message || err);
    return { ok: false, detail: `gateway unreachable at ${base}: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}
