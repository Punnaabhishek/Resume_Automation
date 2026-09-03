/**
 * Envelope encryption for portal and proxy passwords.
 *
 *   secret  --AES-256-GCM(DEK)-->        ciphertext
 *   DEK     --AES-256-GCM(master key)--> wrapped_dek
 *
 * A fresh 32-byte data key (DEK) per secret means a single leaked DEK exposes one
 * credential, not the whole table, and rotating the master key only requires re-wrapping
 * DEKs rather than re-encrypting every secret.
 *
 * The master key lives in env for local development. In production it should come from
 * Azure Key Vault at boot — swap `loadMasterKey` and nothing else changes.
 *
 * Decrypt is deliberately awkward to reach: it lives behind `credentials.service`, which
 * writes a credential_access_log row on every call, and no HTTP route returns plaintext.
 */
import crypto from 'node:crypto';
import { env } from '../config/env';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // GCM standard nonce length

export interface SealedSecret {
  wrappedDek: Buffer;
  dekIv: Buffer;
  dekTag: Buffer;
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

let cachedMasterKey: Buffer | null = null;

function loadMasterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;

  const raw = env.vault.masterKey;
  if (!raw) {
    throw new Error(
      'CREDENTIAL_MASTER_KEY is not set. Generate one with `npm run keygen`. ' +
        'The vault refuses to operate rather than fall back to storing anything readable.',
    );
  }

  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`CREDENTIAL_MASTER_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}.`);
  }

  cachedMasterKey = key;
  return key;
}

/** Fails fast at boot rather than at first credential write. */
export function assertVaultReady(): void {
  loadMasterKey();
}

export function seal(plaintext: string): SealedSecret {
  const masterKey = loadMasterKey();

  const dek = crypto.randomBytes(KEY_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, dek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const dekIv = crypto.randomBytes(IV_BYTES);
  const keyCipher = crypto.createCipheriv(ALGORITHM, masterKey, dekIv);
  const wrappedDek = Buffer.concat([keyCipher.update(dek), keyCipher.final()]);
  const dekTag = keyCipher.getAuthTag();

  dek.fill(0);

  return { wrappedDek, dekIv, dekTag, ciphertext, iv, authTag, keyVersion: env.vault.keyVersion };
}

export function open(sealed: SealedSecret): string {
  const masterKey = loadMasterKey();

  const keyDecipher = crypto.createDecipheriv(ALGORITHM, masterKey, sealed.dekIv);
  keyDecipher.setAuthTag(sealed.dekTag);
  const dek = Buffer.concat([keyDecipher.update(sealed.wrappedDek), keyDecipher.final()]);

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, dek, sealed.iv);
    decipher.setAuthTag(sealed.authTag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
  } finally {
    dek.fill(0);
  }
}

/**
 * Re-wrap an existing DEK under the current master key. Used by key rotation: the secret
 * itself is never decrypted, only the small key protecting it.
 */
export function rewrap(sealed: SealedSecret, previousMasterKey: Buffer): SealedSecret {
  const keyDecipher = crypto.createDecipheriv(ALGORITHM, previousMasterKey, sealed.dekIv);
  keyDecipher.setAuthTag(sealed.dekTag);
  const dek = Buffer.concat([keyDecipher.update(sealed.wrappedDek), keyDecipher.final()]);

  try {
    const dekIv = crypto.randomBytes(IV_BYTES);
    const keyCipher = crypto.createCipheriv(ALGORITHM, loadMasterKey(), dekIv);
    const wrappedDek = Buffer.concat([keyCipher.update(dek), keyCipher.final()]);
    return { ...sealed, wrappedDek, dekIv, dekTag: keyCipher.getAuthTag(), keyVersion: env.vault.keyVersion };
  } finally {
    dek.fill(0);
  }
}

export function generateMasterKey(): string {
  return crypto.randomBytes(KEY_BYTES).toString('base64');
}
