import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We mock the paths module so config.ts uses our temp dir
vi.mock('./paths.js', () => {
  // Will be overridden per-test via the tmpDir variable
  return {
    configDir: () => tmpDir,
    configPath: () => path.join(tmpDir, 'config.json'),
    configExamplePath: () => path.join(tmpDir, 'config.example.json'),
  };
});

// tmpDir is set before each test
let tmpDir: string;

import {
  loadConfig,
  validateConfig,
  saveConfig,
  writeExampleConfig,
} from './config.js';

describe('config', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-usage-test-'));
  });

  afterEach(() => {
    // Clean up temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // 1. Missing config → safe defaults
  it('missing config file returns safe defaults', () => {
    // tmpDir exists but no config.json inside
    const cfg = loadConfig();
    expect(cfg).toEqual({ refreshIntervalSec: 180, port: 7878 });
  });

  // 2. Legacy scraper settings are discarded
  it('loadConfig strips legacy OpenCode workspace and cookie fields', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'config.json'),
      JSON.stringify({
        refreshIntervalSec: 180,
        port: 7878,
        opencodeWorkspaceId: 'wrk_test',
        opencodeAuthCookie: 'Fe26.2**SECRETCOOKIE',
      }),
      'utf8',
    );

    const cfg = loadConfig();
    expect(cfg).not.toHaveProperty('opencodeWorkspaceId');
    expect(cfg).not.toHaveProperty('opencodeAuthCookie');
  });

  // 3. saveConfig merge + atomic round-trip
  it('saveConfig merges fields and does not leave .tmp. files', () => {
    saveConfig({ refreshIntervalSec: 240 });
    saveConfig({ port: 8787 });

    const cfg = loadConfig();
    expect(cfg.refreshIntervalSec).toBe(240);
    expect(cfg.port).toBe(8787);

    // No leftover .tmp. files
    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);
  });

  // 4. refreshIntervalSec clamped to minimum (30)
  it('saveConfig clamps refreshIntervalSec to 30', () => {
    // validateConfig would throw for < 30, so we bypass validation by writing directly
    // and test that loadConfig clamps on read
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ refreshIntervalSec: 5, port: 7878 }),
      'utf8',
    );
    const cfg = loadConfig();
    expect(cfg.refreshIntervalSec).toBe(30);
  });

  // 5. validateConfig — valid values don't throw
  it('validateConfig does not throw for valid values', () => {
    expect(() =>
      validateConfig({ port: 7878, refreshIntervalSec: 60 }),
    ).not.toThrow();
  });

  // Bonus: writeExampleConfig creates the file
  it('writeExampleConfig writes a parseable example file', () => {
    writeExampleConfig();
    const exPath = path.join(tmpDir, 'config.example.json');
    expect(fs.existsSync(exPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(exPath, 'utf8'));
    expect(parsed).toEqual({ refreshIntervalSec: 180, port: 7878 });
  });
});
