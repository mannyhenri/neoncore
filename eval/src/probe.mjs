// Gateway/model reachability probe.
//
// Runs BEFORE the suite so we can tell an infra failure (model server down,
// wrong URL) apart from a model failure (server up, model got the task wrong).
// Without this, "all tasks failed" is ambiguous and the score is meaningless.

/**
 * Check that the OpenAI-compatible gateway Gridlight will call is reachable.
 * We hit the models endpoint with a short timeout; any HTTP response (even 404)
 * proves something is listening, which is enough to distinguish "server down".
 *
 * @param {string} gatewayUrl e.g. http://localhost:11434 (Ollama) or :8080
 * @param {number} timeoutMs
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function probeGateway(gatewayUrl, timeoutMs = 4000) {
  const url = gatewayUrl.replace(/\/+$/, '') + '/v1/models';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    // Any answer (200 with a model list, or even 404) means a server is up.
    return { ok: true, detail: `gateway responded ${res.status} at ${url}` };
  } catch (err) {
    const msg = err?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : String(err?.message || err);
    return { ok: false, detail: `gateway unreachable at ${url}: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}
