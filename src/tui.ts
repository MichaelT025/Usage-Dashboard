import type { IProviderAdapter, StatusResponse } from './core/types.js';
import { Poller } from './core/poller.js';
import { renderFrame } from './render.js';
import process from 'node:process';

export function startTui(adapters: IProviderAdapter[], opts: { intervalSec: number }): void {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  const poller = new Poller({ adapters, intervalSec: opts.intervalSec });
  poller.start();

  let cached: StatusResponse | null = null;
  let restored = false;
  let lastFrameHeight = 0;

  function draw(): void {
    const cols = process.stdout.columns ?? 80;
    const color = process.env.NO_COLOR === undefined;
    const frame = cached
      ? renderFrame(cached, { cols, color })
      : 'Fetching…';
    const lines = (frame + '\n\n[q] quit  [r] refresh\n').split('\n');

    // Move cursor back to the top of the previous frame
    if (lastFrameHeight > 0) {
      process.stdout.write(`\x1b[${lastFrameHeight}A`);
    }

    // Clear each line and write new content
    for (const line of lines) {
      process.stdout.write('\x1b[2K' + line + '\n');
    }

    // If the previous frame was taller, clear leftover lines
    if (lastFrameHeight > lines.length) {
      const extra = lastFrameHeight - lines.length;
      for (let i = 0; i < extra; i++) {
        process.stdout.write('\x1b[2K\n');
      }
      // Move cursor back up to the end of the new frame
      process.stdout.write(`\x1b[${extra}A`);
    }

    lastFrameHeight = lines.length;
  }

  poller.refreshNow().then(r => { cached = r; draw(); }).catch(() => {});
  draw();

  const tick = setInterval(() => {
    const latest = poller.getLatest();
    if (latest) cached = latest;
    draw();
  }, 60000);

  process.stdin.on('data', (key: string) => {
    if (key === 'q' || key === '\u0003') quit();
    else if (key === 'r') {
      poller.refreshNow().then(r => { cached = r; draw(); }).catch(() => {});
    }
  });

  process.stdout.on('resize', draw);

  function restoreTerminal(): void {
    if (restored) return;
    restored = true;
    clearInterval(tick);
    poller.stop();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  function quit(): void {
    restoreTerminal();
    process.stdout.write('\n');
    process.exit(0);
  }

  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  process.on('uncaughtException', (e: unknown) => {
    restoreTerminal();
    console.error((e instanceof Error ? e.message : String(e)));
    process.exit(1);
  });
}
