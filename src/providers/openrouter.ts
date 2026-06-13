/**
 * Phase-2 stub: OpenRouter provider.
 *
 * Future data source: GET https://openrouter.ai/api/v1/key
 *   Auth: Authorization: Bearer <api-key>
 *   Returns: usage, usage_daily/weekly/monthly, limit, limit_remaining, is_free_tier
 *
 * NOT in the active Phase-1 aggregator list.
 */
import type { IProviderAdapter, UsageData } from '../core/types.js';

export class OpenRouterAdapter implements IProviderAdapter {
  readonly id = 'openrouter' as const;
  readonly displayName = 'OpenRouter';

  async fetch(): Promise<UsageData> {
    return {
      providerId: this.id,
      displayName: this.displayName,
      state: 'not_implemented',
      windows: [],
      fetchedAt: new Date().toISOString(),
    };
  }
}
