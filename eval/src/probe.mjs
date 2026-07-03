// Gateway + model reachability probe.
//
// Runs BEFORE the suite so we can tell an infra failure (server down, or the
// requested model not loaded) apart from a model failure (server up, model got
// the task wrong). A server that is up but is NOT serving `model` would make
// every task fail and be scored as a confident 0% blamed on the model — the
// exact false signal this probe exists to prevent — so we check both.

/**
 * @param {string} gatewayUrl e.g. http://localhost:11434 (Ollama) or :8080
 * @param {string} model      the model id the run will request
 * @param {number} timeoutMs
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function probeGateway(gatewayUrl, model, timeoutMs = 4000) {
  const url = gatewayUrl.replace(/\/+$/, '') + '/v1/models';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      return { ok: false, detail: `gateway returned ${res.status} at ${url}` };
    }
    // Verify the requested model is actually served. Tolerate tag/prefix
    // differences (Ollama lists "qwen2.5-coder:7b"; a user may pass either form).
    let ids = [];
    try {
      const body = await res.json();
      ids = (body?.data || []).map((m) => m?.id).filter(Boolean);
    } catch {
      // Non-JSON but 200 — can't verify the model list; allow with a warning.
      return { ok: true, detail: `gateway up at ${url} (model list unparseable — could not verify "${model}")` };
    }
    if (model && ids.length && !ids.some((id) => id === model || id.startsWith(model) || model.startsWith(id))) {
      return { ok: false, detail: `model "${model}" not served by gateway (has: ${ids.slice(0, 8).join(', ') || 'none'})` };
    }
    return { ok: true, detail: `gateway up at ${url}, serving "${model}"` };
  } catch (err) {
    const msg = err?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : String(err?.message || err);
    return { ok: false, detail: `gateway unreachable at ${url}: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}
