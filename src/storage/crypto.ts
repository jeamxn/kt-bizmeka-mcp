/**
 * AES-256-GCM encryption for secrets stored in Postgres (passwords, cookie
 * jars, in-flight session state). The key comes from MASTER_KEY (base64 or hex,
 * 32 bytes). Output layout (single Buffer, stored as BYTEA):
 *
 *   [ 12-byte IV | 16-byte auth tag | ciphertext ]
 *
 * Token values (access/refresh/auth codes) are NOT encrypted — they're stored
 * as sha256 hashes via `sha256()` so a DB leak can't replay them.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const IV_LEN = 12;
const TAG_LEN = 16;

let _key: Buffer | null = null;

/** Parse MASTER_KEY (base64 or hex) into a 32-byte key. Throws if invalid. */
function masterKey(): Buffer {
  if (_key) return _key;
  const raw = process.env.MASTER_KEY;
  if (!raw) throw new Error("MASTER_KEY is required when STORAGE=db");
  let buf: Buffer | null = null;
  // Try base64 first, then hex.
  try {
    const b = Buffer.from(raw, "base64");
    if (b.length === 32) buf = b;
  } catch {
    /* not base64 */
  }
  if (!buf && /^[0-9a-fA-F]{64}$/.test(raw)) {
    buf = Buffer.from(raw, "hex");
  }
  if (!buf || buf.length !== 32) {
    throw new Error(
      "MASTER_KEY must decode to exactly 32 bytes (base64 of 32B, or 64 hex chars). " +
        "Generate one with: openssl rand -base64 32",
    );
  }
  _key = buf;
  return buf;
}

/** Encrypt a UTF-8 string. Returns IV||tag||ciphertext. */
export function encrypt(plaintext: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

/** Decrypt a Buffer produced by encrypt(). Throws on tamper/wrong key. */
export function decrypt(blob: Buffer | Uint8Array): string {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error("ciphertext too short");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
    "utf8",
  );
}

/** Encrypt any JSON-serializable value. */
export function encryptJson(value: unknown): Buffer {
  return encrypt(JSON.stringify(value));
}

/** Decrypt to a JSON value (typed by the caller). */
export function decryptJson<T>(blob: Buffer | Uint8Array): T {
  return JSON.parse(decrypt(blob)) as T;
}

/** sha256 hex digest — used to store tokens/codes without the raw secret. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
