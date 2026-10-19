import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { CreditsInfo } from './core/types.js';
import { parseCommandCodeCredits } from './providers/command-code.js';
import { renderProviderBlock } from './render.js';

// Exercise the shipped browser formatter without booting dashboard polling.
const source = readFileSync(
  new URL('../public/app.js', import.meta.url),
  'utf8',
);
const formatter = source.match(
  /function renderCredits\(credits\) \{[\s\S]*?\n\}/,
);
if (!formatter) throw new Error('Browser credit formatter not found');
const browser = runInNewContext(`(${formatter[0]})`, {
  escHtml: (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
}) as (credits: CreditsInfo) => string;
const terminal = (credits: CreditsInfo) =>
  renderProviderBlock(
    {
      providerId: 'command-code',
      displayName: 'Command Code',
      state: 'ok',
      windows: [],
      fetchedAt: '2026-10-19T00:00:00.000Z',
      credits,
    },
    { cols: 100, color: false },
  );

describe('browser and terminal credit pool parity', () => {
  it('separates plan and purchased pools without counting aliases twice', () => {
    const credits = parseCommandCodeCredits(
      {
        credits: {
          monthlyCredits: 56,
          monthly_credits: 56,
          purchasedCredits: 100,
        },
      },
      null,
      { totalCost: 3 },
    )!;
    expect(credits.balanceUsd).toBe(156);
    for (const output of [browser(credits), terminal(credits)]) {
      expect(output).toContain('Plan credits: Monthly: $56.00');
      expect(output).toContain('Extra/API credits: $100.00');
      expect(output).toContain('Spend: $3.00');
      expect(output).not.toContain('$156.00');
    }
  });

  it('shows spend-only responses in both renderers', () => {
    const credits = parseCommandCodeCredits(null, null, { totalCost: 9 })!;
    expect(credits).toMatchObject({ spendUsd: 9 });
    expect(credits.balanceUsd).toBeUndefined();
    for (const output of [browser(credits), terminal(credits)]) {
      expect(output).toContain('Spend: $9.00');
      expect(output).not.toContain('Plan credits');
      expect(output).not.toContain('Extra/API credits');
    }
  });

  it('renders known zero pools and spend rather than hiding them', () => {
    const credits: CreditsInfo = {
      label: 'Balance',
      monthlyCredits: 0,
      freeCredits: 0,
      purchasedCredits: 0,
      spendUsd: 0,
    };
    for (const output of [browser(credits), terminal(credits)]) {
      expect(output).toContain('Monthly: $0.00');
      expect(output).toContain('Free: $0.00');
      expect(output).toContain('Extra/API credits: $0.00');
      expect(output).toContain('Spend: $0.00');
    }
  });

  it('does not fabricate missing pools', () => {
    const credits = parseCommandCodeCredits(
      { credits: { monthlyCredits: 5 } },
      null,
    )!;
    for (const output of [browser(credits), terminal(credits)]) {
      expect(output).toContain('Monthly: $5.00');
      expect(output).not.toContain('Extra/API credits');
      expect(output).not.toContain('Free:');
    }
  });

  it('preserves generic credit rendering and escapes browser labels', () => {
    const credits: CreditsInfo = {
      label: 'Extra usage',
      balanceUsd: 20,
      valueUsd: 5,
    };
    for (const output of [browser(credits), terminal(credits)]) {
      expect(output).toContain('Extra usage: $20.00 · Used: $5.00');
    }
    expect(browser({ label: '<b>', balanceUsd: 1 })).toContain('&lt;b&gt;');
  });
});
