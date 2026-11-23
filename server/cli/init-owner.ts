import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.ts';
import { openDatabase } from '../db.ts';
import { hashPassword } from '../lib/crypto.ts';
import {
  displayNameSchema,
  emailSchema,
  passwordSchema,
  usernameSchema,
} from '../lib/validation.ts';

function readArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

const config = loadConfig();
const db = openDatabase(config.dbPath);

const rawUsername = readArg('--username') || process.env.RAHHALA_OWNER_USERNAME || '';
const rawName = readArg('--name') || process.env.RAHHALA_OWNER_NAME || '';
const rawEmail = readArg('--email') || process.env.RAHHALA_OWNER_EMAIL || '';
const rawPassword = readArg('--password') || process.env.RAHHALA_OWNER_PASSWORD || '';

const uRes = usernameSchema.safeParse(rawUsername);
const nRes = displayNameSchema.safeParse(rawName);
const eRes = emailSchema.safeParse(rawEmail);
const pRes = passwordSchema.safeParse(rawPassword);

if (!uRes.success || !nRes.success || !eRes.success || !pRes.success) {
  console.error('Usage: npm run init-owner -- --username <user> --name "<Full Name>" --email <email> --password <password>');
  console.error('Or set RAHHALA_OWNER_USERNAME, RAHHALA_OWNER_NAME, RAHHALA_OWNER_EMAIL, RAHHALA_OWNER_PASSWORD.');
  process.exit(1);
}

const existingOwner = db.prepare("SELECT id FROM users WHERE role = 'owner'").get() as
  | { id: string }
  | undefined;

if (existingOwner) {
  console.error('An owner account already exists in this database.');
  process.exit(1);
}

const now = Date.now();
const id = `usr_${randomUUID()}`;
db.prepare(
  `INSERT INTO users (id, display_name, username, email, password_hash, role, approval_status, history_granted, bio, avatar_asset_id, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, 'owner', 'approved', 1, '', NULL, ?, ?)`
).run(id, nRes.data, uRes.data, eRes.data, hashPassword(pRes.data), now, now);

console.log(`Owner account '${uRes.data}' initialized successfully.`);
db.close();
