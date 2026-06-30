/**
 * RSA credential encryption matching bizmeka's client-side jsbn implementation.
 *
 * The login page (`/loginForm.do`) ships a 2048-bit RSA public key as two hidden
 * inputs (`sproKeyModulus`, `sproKeyExponent`) and encrypts the username/password
 * with jsbn's `RSAKey.encrypt`, which is textbook RSA with PKCS#1 v1.5 (type 2)
 * padding, emitting a lowercase hex string.
 *
 * Node/Bun's `crypto.publicEncrypt` with `RSA_PKCS1_PADDING` produces the same
 * RSAES-PKCS1-v1_5 scheme. We build a public KeyObject from the raw
 * modulus/exponent via a JWK, encrypt, and hex-encode the output.
 *
 * Note: jsbn emits the ciphertext as a BigInteger hex (no fixed-width zero
 * padding), whereas Node emits the full modulus-width buffer. Both decode to the
 * same integer mod n, so the server decrypts them identically — the extra
 * leading zero bytes are harmless.
 */

import { createPublicKey, publicEncrypt, constants } from "node:crypto";

/** Strip optional 0x, lowercase, left-pad to an even number of hex digits. */
function normalizeHex(hex: string): string {
  let h = hex.trim().toLowerCase();
  if (h.startsWith("0x")) h = h.slice(2);
  if (h.length % 2 !== 0) h = "0" + h;
  return h;
}

/** Hex string -> Buffer, with leading zero bytes stripped (big-endian magnitude). */
function hexToBufferTrimmed(hex: string): Buffer {
  let h = normalizeHex(hex);
  // Drop leading "00" byte pairs so the JWK base64url has no spurious leading zeros.
  while (h.length > 2 && h.startsWith("00")) {
    h = h.slice(2);
  }
  return Buffer.from(h, "hex");
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export class RSAEncryptor {
  private readonly key: ReturnType<typeof createPublicKey>;

  constructor(modulusHex: string, exponentHex: string) {
    const n = base64url(hexToBufferTrimmed(modulusHex));
    const e = base64url(hexToBufferTrimmed(exponentHex));
    this.key = createPublicKey({
      key: { kty: "RSA", n, e },
      format: "jwk",
    });
  }

  /** Return the PKCS#1 v1.5 ciphertext of `plaintext` as lowercase hex. */
  encrypt(plaintext: string): string {
    const ct = publicEncrypt(
      { key: this.key, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(plaintext, "utf-8"),
    );
    return ct.toString("hex");
  }
}
