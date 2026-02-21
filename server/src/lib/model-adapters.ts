import OpenAI from 'openai';
import db from '../db.js';

export interface ModelAdapter {
  call(prompt: string, systemPrompt?: string): Promise<string>;
}

function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

// ─── OpenAI Adapter ──────────────────────────────────

export function createOpenAIAdapter(modelId: string): ModelAdapter {
  return {
    async call(prompt: string, systemPrompt?: string): Promise<string> {
      const apiKey = getSetting('openai_api_key');
      if (!apiKey) throw new Error('OpenAI API key not configured. Set it in Settings.');

      const client = new OpenAI({ apiKey });
      const messages: OpenAI.ChatCompletionMessageParam[] = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      messages.push({ role: 'user', content: prompt });

      const response = await client.chat.completions.create({
        model: modelId,
        messages,
        max_tokens: 4096,
      });

      return response.choices[0]?.message?.content ?? '';
    },
  };
}

// ─── GridLight Gateway Adapter ───────────────────────

export function createGridLightAdapter(modelId: string): ModelAdapter {
  return {
    async call(prompt: string, systemPrompt?: string): Promise<string> {
      const gatewayUrl = getSetting('gridlight_gateway_url') || 'http://localhost:8080';

      const messages: { role: string; content: string }[] = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      messages.push({ role: 'user', content: prompt });

      const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId, messages, max_tokens: 4096 }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`GridLight gateway error (${res.status}): ${text}`);
      }

      const data = await res.json() as { choices: { message: { content: string } }[] };
      return data.choices?.[0]?.message?.content ?? '';
    },
  };
}

// ─── Helpers ─────────────────────────────────────────

export function getFirstGridlightModel(): string | null {
  const models = getSetting('gridlight_models');
  if (!models) return null;
  const first = models.split(',').map((m) => m.trim()).filter(Boolean)[0];
  return first || null;
}

// ─── Factory ─────────────────────────────────────────

export function getAdapter(playerType: 'openai' | 'gridlight-gateway', modelId: string): ModelAdapter {
  if (playerType === 'openai') return createOpenAIAdapter(modelId);
  return createGridLightAdapter(modelId);
}
