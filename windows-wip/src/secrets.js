// Saved API keys are encrypted with the AES key Chromium keeps, DPAPI-wrapped,
// in the app's "Local State" file. Electron's safeStorage uses the same key,
// but when it cannot read Local State at startup it silently encrypts with a
// throwaway key instead: a key saved in such a session can never be read again
// (Nov 2026: DeepSeek and Qwen keys lost this way after a quick relaunch).
// Reading the stored key ourselves makes a save either durable or an error.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

// Chromium's Windows format: "v10", 12-byte nonce, ciphertext, 16-byte tag.
const VERSION = Buffer.from("v10");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DPAPI_PREFIX = Buffer.from("DPAPI");
const KEY_BYTES = 32;

// The unwrapped key is XORed with a one-time mask before PowerShell prints it,
// so a machine that records PowerShell output never records the key itself.
const UNWRAP_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "$key = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:VCDP_DPAPI_BLOB), $null, 'CurrentUser')",
  "$mask = [Convert]::FromBase64String($env:VCDP_DPAPI_MASK)",
  "if ($key.Length -ne $mask.Length) { exit 3 }",
  "for ($i = 0; $i -lt $key.Length; $i++) { $key[$i] = $key[$i] -bxor $mask[$i] }",
  "[Convert]::ToBase64String($key)"
].join("; ");

function powershellPath() {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function encryptWithKey(key, plain) {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return Buffer.concat([VERSION, nonce, body, cipher.getAuthTag()]);
}

// Returns the plaintext, or null when `encrypted` was not made with `key`.
function decryptWithKey(key, encrypted) {
  if (!Buffer.isBuffer(encrypted) || encrypted.length < VERSION.length + NONCE_BYTES + TAG_BYTES) return null;
  if (!encrypted.subarray(0, VERSION.length).equals(VERSION)) return null;
  try {
    const nonce = encrypted.subarray(VERSION.length, VERSION.length + NONCE_BYTES);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(encrypted.subarray(encrypted.length - TAG_BYTES));
    const body = encrypted.subarray(VERSION.length + NONCE_BYTES, encrypted.length - TAG_BYTES);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function wrappedKeyFrom(localStatePath) {
  try {
    const state = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
    const blob = Buffer.from(String(state?.os_crypt?.encrypted_key || ""), "base64");
    if (blob.length <= DPAPI_PREFIX.length || !blob.subarray(0, DPAPI_PREFIX.length).equals(DPAPI_PREFIX)) return null;
    return blob.subarray(DPAPI_PREFIX.length);
  } catch {
    return null;
  }
}

// Resolves to the 32-byte key, or null when Local State is missing, locked,
// in another format, or Windows will not unwrap it. Never rejects.
function loadDiskKey(localStatePath) {
  const wrapped = wrappedKeyFrom(localStatePath);
  if (!wrapped) return Promise.resolve(null);
  const mask = crypto.randomBytes(KEY_BYTES);
  return new Promise((resolve) => {
    execFile(powershellPath(), ["-NoProfile", "-NonInteractive", "-Command", UNWRAP_SCRIPT], {
      env: { ...process.env, VCDP_DPAPI_BLOB: wrapped.toString("base64"), VCDP_DPAPI_MASK: mask.toString("base64") },
      windowsHide: true,
      timeout: 20000
    }, (error, stdout) => {
      if (error) return resolve(null);
      const masked = Buffer.from(String(stdout).trim(), "base64");
      if (masked.length !== KEY_BYTES) return resolve(null);
      resolve(Buffer.from(masked.map((byte, index) => byte ^ mask[index])));
    });
  });
}

module.exports = { encryptWithKey, decryptWithKey, loadDiskKey };
