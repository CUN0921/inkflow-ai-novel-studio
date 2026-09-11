import { createHash } from 'node:crypto';
export const workspaceId = root => createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0,24);
export function servicePort(env) {
  const port = env.PORT === undefined || env.PORT === '' ? 4310 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  return port;
}
