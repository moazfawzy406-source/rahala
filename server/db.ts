import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { generateOpaqueToken } from './lib/crypto.ts';

export type RahhalaDb = Database.Database;

interface Migration {
  version: number;
  name: string;
  sql: string;
}

import { migrateDatabase } from './db-core.ts';
export { getSetting, setSetting, getOrCreateSigningSecret } from './db-core.ts';
export function openDatabase(dbPath: string): RahhalaDb {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }

  migrateDatabase(db);
  return db;
}
