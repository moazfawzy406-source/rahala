// No native addon or local filesystem in Workers.
export type RahhalaDb = any;
export { getSetting, setSetting, getOrCreateSigningSecret } from '../server/db-core.ts';
export function openDatabase(): never { throw new Error('Cloudflare requires the bound SQLite Durable Object'); }
