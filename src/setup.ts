import fs from 'node:fs';
import readline from 'node:readline';
import { loadConfig, saveConfig, validateConfig } from './core/config.js';
import { getClaudeToken, getCodexToken } from './core/credentials.js';

type LoadedConfig = ReturnType<typeof loadConfig>;
type ProbeResult = 'ok' | 'COOKIE_EXPIRED' | 'error';

/**
 * Run the interactive setup wizard.
 * Prompts for OpenCode Go config. Probes Claude + Codex tokens automatically.
 * On confirm: saves via saveConfig(). NEVER echoes the cookie or tokens.
 */
export async function runSetupWizard(opts: { check?: boolean; noValidate?: boolean } = {}): Promise<void> {
  const config = loadConfig();

  if (opts.check) {
    await printProviderStatus(config);
    const allOk = await checkAllProviders(config);
    process.exit(allOk ? 0 : 1);
  }

  const pipedAnswers = process.stdin.isTTY ? null : fs.readFileSync(0, 'utf8').split(/\r?\n/);
  let pipedAnswerIndex = 0;
  let rl: readline.Interface | null = pipedAnswers
    ? null
    : readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (prompt: string): Promise<string> => {
    if (pipedAnswers) {
      process.stdout.write(prompt);
      return Promise.resolve(pipedAnswers[pipedAnswerIndex++] ?? '');
    }
    if (!rl) throw new Error('readline interface is closed');
    return new Promise(resolve => rl!.question(prompt, resolve));
  };

  console.log('\n🔧  llm-usage setup\n');
  console.log('Claude and Codex tokens are read automatically from your local login files.');
  console.log('Only OpenCode Go requires manual configuration (workspace ID + auth cookie).\n');

  await printProviderStatus(config);
  console.log('');

  try {
    const currentWsId = config.opencodeWorkspaceId;
    const wsPrompt = currentWsId
      ? 'OpenCode workspace ID [current: configured, press Enter to keep]: '
      : 'OpenCode workspace ID (from opencode.ai URL: /workspace/{ID}/go): ';
    const wsInput = await question(wsPrompt);
    const workspaceId = wsInput.trim() || currentWsId || '';

    const currentCookieSet = !!config.opencodeAuthCookie;
    const cookiePrompt = currentCookieSet
      ? 'OpenCode auth cookie [current: configured, press Enter to keep]: '
      : 'OpenCode auth cookie (copy from opencode.ai browser cookies → auth): ';

    const usedRawCookiePrompt = !pipedAnswers && process.stdin.isTTY && typeof process.stdin.setRawMode === 'function';
    const authCookie = pipedAnswers ? await question(cookiePrompt) : await questionMasked(rl, cookiePrompt);
    if (usedRawCookiePrompt) {
      rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    }
    const finalCookie = authCookie.trim() || config.opencodeAuthCookie || '';

    const intervalInput = await question(`Auto-refresh interval in seconds [${config.refreshIntervalSec}]: `);
    const intervalSec = parseInt(intervalInput.trim(), 10) || config.refreshIntervalSec;

    rl?.close();
    rl = null;

    try {
      validateConfig({
        opencodeWorkspaceId: workspaceId || undefined,
        opencodeAuthCookie: finalCookie || undefined,
        refreshIntervalSec: intervalSec,
      });
    } catch (err) {
      if (err instanceof TypeError) {
        console.error(`\nValidation error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }

    if (!opts.noValidate && workspaceId && finalCookie) {
      console.log('\n🔍  Probing OpenCode Go...');
      const result = await probeGoAdapter(workspaceId, finalCookie);
      if (result === 'COOKIE_EXPIRED') {
        console.error('  ⚠  Cookie appears expired. Save anyway? [y/N]');
        const confirm = await askLine('');
        if (!confirm.toLowerCase().startsWith('y')) {
          console.log('Aborted.');
          process.exit(1);
        }
      } else if (result === 'ok') {
        console.log('  ✓  OpenCode Go connection verified');
      } else {
        console.log('  ⚠  Could not reach OpenCode Go. Saving local configuration only.');
      }
    }

    const toSave: Parameters<typeof saveConfig>[0] = {};
    if (workspaceId) toSave.opencodeWorkspaceId = workspaceId;
    if (finalCookie) toSave.opencodeAuthCookie = finalCookie;
    toSave.refreshIntervalSec = intervalSec;

    saveConfig(toSave);
    console.log('\n✓  Configuration saved to ~/.llm-usage/config.json');
    console.log('  Run `llm-usage` to start the dashboard.');
  } catch (err) {
    rl?.close();
    throw err;
  }
}

async function checkAllProviders(config: LoadedConfig): Promise<boolean> {
  const claudeToken = await findClaudeToken();
  const codexToken = await findCodexToken();
  const hasGo = !!(config.opencodeWorkspaceId && config.opencodeAuthCookie);

  const rows = [
    ['Claude', claudeToken ? '✓ token found' : '✗ not found — run `claude` to login'],
    ['Codex', codexToken ? '✓ token found' : '✗ not found — run `codex login`'],
    ['OpenCode Go', hasGo ? '✓ configured' : '✗ not configured — run `llm-usage setup`'],
  ] as const;

  for (const [name, status] of rows) {
    console.log(`  ${name.padEnd(16)} ${status}`);
  }

  return !!(claudeToken && codexToken && hasGo);
}

async function printProviderStatus(config: LoadedConfig): Promise<void> {
  const claudeToken = await findClaudeToken();
  const codexToken = await findCodexToken();
  console.log('Current status:');
  console.log(`  Claude         ${claudeToken ? '✓ configured' : '✗ not found'}`);
  console.log(`  Codex          ${codexToken ? '✓ configured' : '✗ not found'}`);
  console.log(`  OpenCode Go    ${config.opencodeWorkspaceId ? '✓ workspace set' : '✗ not configured'} / ${config.opencodeAuthCookie ? '✓ cookie set' : '✗ no cookie'}`);
}

async function findClaudeToken(): Promise<string | null> {
  try {
    return await getClaudeToken();
  } catch {
    return null;
  }
}

async function findCodexToken(): Promise<Awaited<ReturnType<typeof getCodexToken>>> {
  try {
    return await getCodexToken();
  } catch {
    return null;
  }
}

async function probeGoAdapter(workspaceId: string, cookie: string): Promise<ProbeResult> {
  try {
    const url = `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;
    const res = await fetch(url, {
      headers: {
        Cookie: `auth=${cookie}`,
        Accept: 'text/html',
        'User-Agent': 'llm-usage',
      },
      redirect: 'follow',
    });
    const html = await res.text();
    if (!html.includes('rollingUsage') && !html.includes('weeklyUsage')) return 'COOKIE_EXPIRED';
    return 'ok';
  } catch {
    return 'error';
  }
}

async function questionMasked(rl: readline.Interface | null, prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return new Promise(resolve => {
      if (!rl) {
        const fallback = readline.createInterface({ input: process.stdin, output: process.stdout });
        fallback.question(prompt, answer => {
          fallback.close();
          resolve(answer);
        });
        return;
      }
      rl.question(prompt, resolve);
    });
  }

  rl?.close();

  return new Promise(resolve => {
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    let input = '';

    const finish = (): void => {
      process.stdin.setRawMode(false);
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(input);
    };

    const onData = (chunk: Buffer): void => {
      const chars = chunk.toString('utf8');
      for (const char of chars) {
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\x7f' || char === '\b') {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
          continue;
        }
        if (char === '\x03') {
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          process.exit(1);
        }
        input += char;
        process.stdout.write('*');
      }
    };

    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

function askLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(prompt, answer => {
      rl.close();
      resolve(answer);
    });
  });
}
