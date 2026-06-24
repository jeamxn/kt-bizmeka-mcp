"""RSA credential encryption matching bizmeka's client-side jsbn implementation.

The login page (`/loginForm.do`) ships a 2048-bit RSA public key as two hidden
inputs (`sproKeyModulus`, `sproKeyExponent`) and encrypts the username/password
with jsbn's `RSAKey.encrypt`, which is textbook RSA with PKCS#1 v1.5 (type 2)
padding, emitting a lowercase hex string.

PyCryptodome's `PKCS1_v1_5` cipher produces the byte-identical scheme, so we just
hex-encode its output. Padding is randomized per call, so ciphertext differs every
time — the server decrypts all valid paddings the same way.
"""

from __future__ import annotations

from Crypto.Cipher import PKCS1_v1_5
from Crypto.PublicKey import RSA


class RSAEncryptor:
    """Encrypts short strings with the bizmeka login public key."""

    def __init__(self, modulus_hex: str, exponent_hex: str) -> None:
        n = int(modulus_hex, 16)
        e = int(exponent_hex, 16)
        self._key = RSA.construct((n, e))
        self._cipher = PKCS1_v1_5.new(self._key)

    def encrypt(self, plaintext: str) -> str:
        """Return the PKCS#1 v1.5 ciphertext of ``plaintext`` as lowercase hex."""
        return self._cipher.encrypt(plaintext.encode("utf-8")).hex()
