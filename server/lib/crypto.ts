import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: 16384,
    r: 8,
    p: 1,
  });
  return `${salt}:${derived.toString('hex')}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, hexHash] = parts;
  if (!salt || !hexHash) return false;
  try {
    const expected = Buffer.from(hexHash, 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: 16384,
      r: 8,
      p: 1,
    });
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function generateOpaqueToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function signShortToken(payload: Record<string, string | number>, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyShortToken<T extends Record<string, unknown>>(
  token: string,
  secret: string
): T | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!body || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    if (typeof parsed.exp === 'number' && Date.now() > parsed.exp) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function deriveConversationMasterKey(signingSecret: string): Buffer {
  const envKey = process.env.RAHHALA_ENCRYPTION_KEY?.trim();
  const ikm = Buffer.from(envKey || signingSecret, 'utf8');
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      ikm,
      Buffer.from('rahhala-conv-salt-v1', 'utf8'),
      Buffer.from('rahhala-conv-master-v1', 'utf8'),
      32
    )
  );
}

export function computeKeyFingerprint(rawKey: Buffer, conversationId: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(rawKey)
    .update(':')
    .update(conversationId)
    .digest();
  let digits = '';
  for (let i = 0; i < 30; i++) {
    const num = hash.readUInt16BE(i % (hash.length - 1)) % 100;
    digits += String(num).padStart(2, '0');
  }
  return digits.match(/.{1,5}/g)?.join(' ') ?? digits;
}

function aesGcmEncrypt(plaintext: Buffer, key: Buffer, aad?: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) {
    cipher.setAAD(Buffer.from(aad, 'utf8'));
  }
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

function aesGcmDecrypt(payload: string, key: Buffer, aad?: string): Buffer {
  const parts = payload.split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw new Error('Unsupported ciphertext format');
  }
  const iv = Buffer.from(parts[2], 'base64url');
  const tag = Buffer.from(parts[3], 'base64url');
  const ciphertext = Buffer.from(parts[4], 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aad) {
    decipher.setAAD(Buffer.from(aad, 'utf8'));
  }
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function generateConversationKey(
  masterKey: Buffer,
  conversationId: string
): { rawKey: Buffer; wrappedKey: string; fingerprint: string } {
  const rawKey = crypto.randomBytes(32);
  const wrappedKey = aesGcmEncrypt(rawKey, masterKey, `wrap:${conversationId}`);
  const fingerprint = computeKeyFingerprint(rawKey, conversationId);
  return { rawKey, wrappedKey, fingerprint };
}

export function unwrapConversationKey(
  wrappedKey: string,
  masterKey: Buffer,
  conversationId: string
): Buffer {
  return aesGcmDecrypt(wrappedKey, masterKey, `wrap:${conversationId}`);
}

export function encryptMessageBody(
  plaintext: string,
  rawKey: Buffer,
  aadContext: string
): string {
  if (!plaintext) return '';
  return aesGcmEncrypt(Buffer.from(plaintext, 'utf8'), rawKey, aadContext);
}

export function decryptMessageBody(
  cipherPayload: string,
  rawKey: Buffer,
  aadContext: string
): string {
  if (!cipherPayload) return '';
  return aesGcmDecrypt(cipherPayload, rawKey, aadContext).toString('utf8');
}
