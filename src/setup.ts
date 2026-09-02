import fs from 'node:fs';
import readline from 'node:readline';
import { loadConfig, saveConfig, validateConfig } from './core/config.js';
import {
  getClaudeToken,
  getCodexToken,
  getOpenCodeGoToken,
} from './core/credentials.js';

export async function runSetupWizard(
  opts: { check?: boolean } = {},
): Promise<void> {
  const config = loadConfig();

  if (opts.check) {
    const allOk = await printProviderStatus();
    process.exit(allOk ? 0 : 1);
  }

  const pipedAnswers = process.stdin.isTTY
    ? null
    : fs.readFileSync(0, 'utf8').split(/\r?\n/);
  let pipedAnswerIndex = 0;
  const rl = pipedAnswers
    ? null
    : readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
  const question = (prompt: string): Promise<string> => {
    if (pipedAnswers) {
      process.stdout.write(prompt);
      return Promise.resolve(pipedAnswers[pipedAnswerIndex++] ?? '');
    }
    if (!rl) throw new Error('readline interface is closed');
    return new Promise((resolve) => rl.question(prompt, resolve));
  };

  console.log('\n🔧  llm-usage setup\n');
  console.log(
    'Provider credentials are read automatically from their local CLI auth stores.\n',
  );
  await printProviderStatus();
  console.log('');

  try {
    const intervalInput = await question(
      `Auto-refresh interval in seconds [${config.refreshIntervalSec}]: `,
    );
    const intervalSec =
      parseInt(intervalInput.trim(), 10) || config.refreshIntervalSec;

    validateConfig({ refreshIntervalSec: intervalSec });
    saveConfig({ refreshIntervalSec: intervalSec });

    console.log('\n✓  Configuration saved to ~/.llm-usage/config.json');
    console.log('  Run `llm-usage` to start the dashboard.');
  } catch (err) {
    if (err instanceof TypeError) {
      console.error(`\nValidation error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  } finally {
    rl?.close();
  }
}

async function printProviderStatus(): Promise<boolean> {
  const [claudeToken, codexToken, openCodeGoToken] = await Promise.all([
    credentialFound(getClaudeToken),
    credentialFound(getCodexToken),
    credentialFound(getOpenCodeGoToken),
  ]);

  console.log('Current status:');
  console.log(
    `  Claude         ${claudeToken ? '✓ configured' : '✗ not found — run `claude` to login'}`,
  );
  console.log(
    `  Codex          ${codexToken ? '✓ configured' : '✗ not found — run `codex login`'}`,
  );
  console.log(
    `  OpenCode Go    ${openCodeGoToken ? '✓ API key found' : '✗ not found — use `/connect` in OpenCode'}`,
  );

  return claudeToken && codexToken && openCodeGoToken;
}

async function credentialFound<T>(
  loader: () => Promise<T | null>,
): Promise<boolean> {
  try {
    return (await loader()) !== null;
  } catch {
    return false;
  }
}
