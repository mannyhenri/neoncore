import { useState, useEffect } from 'react';
import { api, apiFor } from '../lib/api';
import { activeServers } from '../lib/servers';
import { mergeBurnRates, type ServerBurnRate, type FleetBurnRate } from '../lib/burnRate';
import type { ServerEntry } from '@neoncore/client';

/**
 * Fleet burn rate in the header: tokens/day and tokens/hour, with the spend beside them.
 *
 * WHY THE NUMBER HERE IS BIGGER THAN THE ONE ON A CARTRIDGE CARD. The card prints
 * `input + output` and leaves cache out (routes/activity.ts, `total:`), which for a busy
 * cartridge understates volume by roughly two orders of magnitude — 16.4M shown against
 * 10.07 BILLION cache-read tokens actually moved. This readout counts all four token
 * classes, because a rate that ignores the class carrying most of the cost is not a rate.
 * The tooltip says so, so the two figures cannot be mistaken for a contradiction.
 *
 * IT IS ALSO FLEET-WIDE, NOT SAME-ORIGIN. Every server owns its own database, so reading only
 * the server that served this page would report one machine under a label that says fleet.
 * This fans out across `activeServers` exactly as hooks/useAgents.ts does for the roster, and
 * says on the badge when a server did not answer rather than quietly reporting a smaller fleet.
 */

/** 1_034_252 → "1.0M". Rates get big; the header has one line. */
function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

function money(n: number): string {
  return n >= 1 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(2)}`;
}

const WINDOW_DAYS = 7;

export function BurnRate({ servers, onOpen }: { servers: ServerEntry[]; onOpen?: () => void }) {
  const [rate, setRate] = useState<FleetBurnRate | null>(null);

  // The URL list, not the array identity: `servers` is rebuilt on every roster poll, and
  // depending on the array itself would restart the fan-out several times a minute.
  const fleetKey = activeServers(servers).map((s) => s.url).join('|');

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const list = activeServers(servers);
      // One failing server must not take the readout down with it — settle, do not race.
      const answers = await Promise.all(
        list.map((s) =>
          (s.url ? apiFor(s.url, s.token) : api)
            .getBurnRate(WINDOW_DAYS)
            .then((r) => r as ServerBurnRate)
            .catch(() => null),
        ),
      );
      if (alive) setRate(mergeBurnRates(answers, WINDOW_DAYS));
    };
    load();
    // Five minutes. This is a trailing 7-day average — it cannot visibly move faster than
    // that, so polling harder would only add requests.
    const t = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleetKey]);

  // Nothing recorded in the window: show nothing rather than a confident "0/day".
  //
  // The type guard is not paranoia. Before this endpoint existed, `/activity/burn-rate` was
  // swallowed by `/activity/:agentId` and answered `[]` — truthy, with every field undefined,
  // which formats as "NaN tok/day". A server running older code than this bundle is the normal
  // state during a deploy, so the component has to survive the shape it gets from one.
  if (!rate || typeof rate.tokensPerDay !== 'number' || !Number.isFinite(rate.tokensPerDay)) return null;
  if (rate.samples === 0) return null;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="hidden md:inline-flex items-center gap-1.5 text-[11px] font-mono text-gray-500 border border-white/10 px-2 py-0.5 rounded-full whitespace-nowrap hover:text-gray-300 hover:border-white/25 transition-colors"
      title={
        `Fleet burn rate, trailing ${rate.days} days — ${rate.activeCartridges} cartridge(s) active, ` +
        `${rate.samples.toLocaleString()} turns across ` +
        `${rate.serversReporting}/${rate.serversAsked} server(s).\n` +
        (rate.serversReporting < rate.serversAsked
          ? 'PARTIAL: a server did not answer, so the real figure is higher.\n'
          : '') +
        'Counts input + output + cache read + cache creation, so it is larger than the ' +
        'per-cartridge figure on a card (which shows input + output only).\n\nClick for the full report.'
      }
    >
      <span className="text-gl-blue/80">{compact(rate.tokensPerDay)}</span>
      <span className="text-gray-600">tok/day</span>
      <span className="text-white/10">·</span>
      <span className="text-gl-pink/80">{compact(rate.tokensPerHour)}</span>
      <span className="text-gray-600">tok/hr</span>
      <span className="text-white/10">·</span>
      <span className="text-emerald-500/80">{money(rate.costPerDay)}</span>
      <span className="text-gray-600">/day</span>
      {rate.serversReporting < rate.serversAsked && (
        <span className="text-amber-500/80" aria-label="partial — a server did not answer">*</span>
      )}
    </button>
  );
}
