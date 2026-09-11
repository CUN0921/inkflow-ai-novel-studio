import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
export function readEnvFile(filename) {
  const values = {};
  if (!existsSync(filename)) return values;
  for (const line of readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return values;
}
export const workspaceId = root => createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0,24);
export function servicePort(env) {
  const port = env.PORT === undefined || env.PORT === '' ? 4310 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  return port;
}
