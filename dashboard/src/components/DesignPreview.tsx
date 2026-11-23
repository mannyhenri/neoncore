/**
 * A DESIGN DIRECTION, DRAWN — a small piece of real interface (a bar, a headline, buttons, a
 * field, a card with a number, a list, tags) built from nothing but the direction's tokens. The
 * same specimen for every direction, so what differs between two previews IS the design.
 */
import type { CSSProperties } from 'react';
import type { DesignTokens } from '../types';
import { fontStack } from '../lib/design/designer';

const PAD = { compact: 10, cozy: 14, roomy: 20 } as const;
const SCALE = { compact: 0.92, cozy: 1, roomy: 1.08 } as const;

/** How this direction tells a surface from the page. */
export function surfaceStyle(t: DesignTokens): CSSProperties {
  const c = t.colors;
  if (t.surface === 'soft') return { background: c.surface, border: `1px solid ${c.border}66`, boxShadow: t.dark ? '0 8px 22px rgba(0,0,0,0.5)' : '0 8px 22px rgba(20,30,60,0.10)' };
  if (t.surface === 'glass') return { background: `${c.surface}b3`, border: `1px solid ${c.border}`, backdropFilter: 'blur(10px)', boxShadow: `inset 0 1px 0 ${c.text}14` };
  if (t.surface === 'outline') return { background: c.surface, border: `2px solid ${c.text}`, boxShadow: `4px 4px 0 ${c.text}` };
  return { background: c.surface, border: `1px solid ${c.border}` };
}

export function DesignPreview({ tokens: t, compact = false }: { tokens: DesignTokens; compact?: boolean }) {
  const c = t.colors;
  const pad = PAD[t.density];
  const k = SCALE[t.density] * (compact ? 0.86 : 1);
  const heading: CSSProperties = { fontFamily: fontStack(t.fontHeading), color: c.text, margin: 0 };
  const card = { ...surfaceStyle(t), borderRadius: t.radius, padding: pad };
  const button = (primary: boolean): CSSProperties => ({
    fontFamily: fontStack(t.fontBody), fontSize: 12 * k, fontWeight: 600, padding: `${6 * k}px ${12 * k}px`, borderRadius: t.surface === 'soft' ? Math.max(t.radius, 10) : t.radius,
    background: primary ? c.primary : 'transparent', color: primary ? c.onPrimary : c.text,
    border: primary ? `${t.surface === 'outline' ? 2 : 1}px solid ${t.surface === 'outline' ? c.text : c.primary}` : `${t.surface === 'outline' ? 2 : 1}px solid ${t.surface === 'outline' ? c.text : c.border}`,
    boxShadow: primary && t.surface === 'outline' ? `3px 3px 0 ${c.text}` : primary && t.dark ? `0 0 14px ${c.primary}80` : undefined, whiteSpace: 'nowrap',
  });
  return (
    <div data-design-preview data-heading-font={t.fontHeading} data-mode={t.dark ? 'dark' : 'light'} data-surface={t.surface} data-radius={t.radius} data-primary={c.primary} aria-hidden="true" style={{
      background: t.surface === 'glass' ? `radial-gradient(120% 90% at 85% 0%, ${c.primary}40, transparent 60%), radial-gradient(90% 70% at 0% 100%, ${c.accent}2e, transparent 60%), ${c.bg}` : c.bg,
      color: c.text, fontFamily: fontStack(t.fontBody), fontSize: 12 * k, lineHeight: 1.45, borderRadius: 10, overflow: 'hidden', border: `1px solid ${c.border}`,
    }}>
      {/* the bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: `${8 * k}px ${pad}px`, borderBottom: `${t.surface === 'outline' ? 2 : 1}px solid ${t.surface === 'outline' ? c.text : c.border}` }}>
        <span style={{ width: 14, height: 14, borderRadius: Math.min(t.radius, 7), background: c.primary }} />
        <span style={{ ...heading, fontSize: 13 * k, fontWeight: 700, letterSpacing: t.fontHeading === 'Futura' ? '0.06em' : 0 }}>Northwind</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 12, color: c.muted, fontSize: 11 * k }}><span style={{ color: c.text, borderBottom: `2px solid ${c.primary}` }}>Overview</span><span>Orders</span><span>Team</span></span>
      </div>
      <div style={{ padding: pad, display: 'grid', gap: pad }}>
        {/* the headline */}
        <div>
          <p style={{ margin: 0, color: c.accent, fontSize: 10 * k, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>This week</p>
          <h4 style={{ ...heading, fontSize: (t.density === 'roomy' ? 26 : 21) * k, fontWeight: t.fontHeading === 'Didot' || t.fontHeading === 'Iowan Old Style' ? 500 : 700, lineHeight: 1.12, letterSpacing: t.fontHeading === 'Futura' ? '0.01em' : '-0.01em', textTransform: t.fontHeading === 'Futura' ? 'uppercase' : undefined }}>Orders are up, returns are down</h4>
          <p style={{ margin: `${4 * k}px 0 0`, color: c.muted }}>A quick read of how the shop is doing, and the two things that need you today.</p>
        </div>
        {/* buttons and a field */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={button(true)}>Review orders</span>
          <span style={button(false)}>Export</span>
          <span style={{ flex: 1, minWidth: 90, padding: `${6 * k}px ${10 * k}px`, borderRadius: t.radius, border: `${t.surface === 'outline' ? 2 : 1}px solid ${t.surface === 'outline' ? c.text : c.border}`, background: t.surface === 'glass' ? `${c.surface}99` : c.surface, color: c.muted, fontSize: 11 * k }}>Search orders…</span>
        </div>
        {/* a number, and a list */}
        <div style={{ display: 'grid', gridTemplateColumns: '0.9fr 1.3fr', gap: pad }}>
          <div style={card}>
            <p style={{ margin: 0, color: c.muted, fontSize: 10 * k }}>Revenue</p>
            <p style={{ ...heading, fontSize: 22 * k, fontWeight: 700 }}>$48,290</p>
            <div style={{ height: 5, borderRadius: 99, background: `${c.text}1f`, marginTop: 6, overflow: 'hidden' }}><div style={{ width: '68%', height: '100%', background: c.primary }} /></div>
            <p style={{ margin: `${5 * k}px 0 0`, color: c.accent, fontSize: 10 * k, fontWeight: 600 }}>▲ 12% on last week</p>
          </div>
          <div style={{ ...card, padding: 0 }}>
            {[['Ada Chen', 'Paid', c.primary], ['Marco Ruiz', 'Shipped', c.accent], ['Lena Vogt', 'Refund', c.muted]].map(([who, state, colour], i) => (
              <div key={who} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: `${6 * k}px ${pad}px`, borderTop: i ? `1px solid ${c.border}` : undefined }}>
                <span style={{ width: 18, height: 18, borderRadius: t.radius > 8 ? 99 : Math.min(t.radius, 4), background: `${colour}33`, border: `1px solid ${colour}` }} />
                <span style={{ flex: 1 }}>{who}</span>
                <span style={{ fontSize: 10 * k, fontWeight: 600, padding: '1px 7px', borderRadius: t.radius > 8 ? 99 : t.radius, color: colour, border: `1px solid ${colour}`, background: `${colour}1a` }}>{state}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
