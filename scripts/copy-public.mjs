import { cpSync, existsSync } from 'node:fs';

if (existsSync('public')) {
  cpSync('public', 'dist/public', { recursive: true });
}
