import { openDatabase } from './db.ts';
import { loadConfig, type RahhalaConfig } from './config.ts';
import { setupWebSocketHub } from './ws.ts';
import { createRahhalaCore } from './app-core.ts';
export type { RahhalaServerContext } from './app-core.ts';
export function createRahhalaApp(overrides?: Partial<RahhalaConfig>) {
 const config=loadConfig(overrides);
 return createRahhalaCore(overrides,{db:openDatabase(config.dbPath),setupHub:setupWebSocketHub});
}
