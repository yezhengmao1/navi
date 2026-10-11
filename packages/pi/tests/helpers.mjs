import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const install = join(homedir(), '.pi/agent/install');
export const root = process.env.PI_PACKAGE_ROOT ?? join(install, 'releases',
  readFileSync(join(install, 'current-version'), 'utf8').trim(), 'node_modules/@earendil-works/pi-coding-agent');
const require = createRequire(join(root, 'package.json'));
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': join(root, 'dist/index.js'),
  '@earendil-works/pi-tui': require.resolve('@earendil-works/pi-tui'),
  'typebox': require.resolve('typebox'),
} });
export const load = name => jiti.import(fileURLToPath(new URL(`../extensions/magic-ui/${name}.ts`, import.meta.url)));
export const tui = await import(require.resolve('@earendil-works/pi-tui'));
