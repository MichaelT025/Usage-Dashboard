import type { IProviderAdapter, StatusResponse, UsageData } from './types.js';
import { redactSecrets } from './redact.js';

/**
 * Run all adapters with Promise.allSettled — ONE failure never affects others.
 * Any thrown error is wrapped into a redacted 'unavailable' UsageData.
 * Returns a StatusResponse with generatedAt ISO timestamp.
 */
export async function aggregate(adapters: IProviderAdapter[]): Promise<StatusResponse> {
  const results = await Promise.allSettled(adapters.map(adapter => adapter.fetch()));

  const providers: UsageData[] = results.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;

    const adapter = adapters[index]!;
    const errorMessage = result.reason instanceof Error
      ? result.reason.message
      : String(result.reason);

    return {
      providerId: adapter.id,
      displayName: adapter.displayName,
      state: 'unavailable',
      windows: [],
      error: {
        code: 'UNKNOWN',
        message: String(redactSecrets(errorMessage)),
        hint: 'An unexpected error occurred — check logs',
      },
      fetchedAt: new Date().toISOString(),
    };
  });

  return {
    providers,
    generatedAt: new Date().toISOString(),
  };
}
