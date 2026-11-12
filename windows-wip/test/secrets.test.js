const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const secrets = require("../src/secrets");

const windowsOnly = { skip: process.platform !== "win32" && "DPAPI is Windows-only" };

// Chromium's Windows format: "v10", 12-byte nonce, ciphertext, 16-byte tag.
function chromiumEncrypt(key, plain) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), nonce, body, cipher.getAuthTag()]);
}

function localStateFor(t, key) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcdp-secrets-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wrapped = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($env:VCDP_TEST_KEY), $null, 'CurrentUser'))"],
  { env: { ...process.env, VCDP_TEST_KEY: key.toString("base64") }, encoding: "utf8" }).trim();
  const blob = Buffer.concat([Buffer.from("DPAPI"), Buffer.from(wrapped, "base64")]);
  const file = path.join(dir, "Local State");
  fs.writeFileSync(file, JSON.stringify({ os_crypt: { audit_enabled: true, encrypted_key: blob.toString("base64") } }));
  return file;
}

test("a value encrypted with the stored key decrypts again", () => {
  const key = crypto.randomBytes(32);
  const encrypted = secrets.encryptWithKey(key, "sk-example-1234");
  assert.equal(secrets.decryptWithKey(key, encrypted), "sk-example-1234");
});

test("encryption uses the same format Electron's safeStorage writes", () => {
  const key = crypto.randomBytes(32);
  assert.equal(secrets.decryptWithKey(key, chromiumEncrypt(key, "from-safe-storage")), "from-safe-storage");
  const ours = secrets.encryptWithKey(key, "ours");
  assert.equal(ours.subarray(0, 3).toString(), "v10");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, ours.subarray(3, 15));
  decipher.setAuthTag(ours.subarray(ours.length - 16));
  assert.equal(Buffer.concat([decipher.update(ours.subarray(15, ours.length - 16)), decipher.final()]).toString(), "ours");
});

test("a value encrypted with another key reads as unreadable, not as garbage", () => {
  const encrypted = secrets.encryptWithKey(crypto.randomBytes(32), "sk-example-1234");
  assert.equal(secrets.decryptWithKey(crypto.randomBytes(32), encrypted), null);
});

test("an unknown format reads as unreadable", () => {
  const key = crypto.randomBytes(32);
  assert.equal(secrets.decryptWithKey(key, Buffer.from("v20-something-else-entirely-0123456789")), null);
  assert.equal(secrets.decryptWithKey(key, Buffer.alloc(0)), null);
});

test("the stored key is read from the app's Local State file", windowsOnly, async (t) => {
  const key = crypto.randomBytes(32);
  const loaded = await secrets.loadDiskKey(localStateFor(t, key));
  assert.ok(loaded, "key should load");
  assert.equal(loaded.toString("hex"), key.toString("hex"));
  assert.equal(secrets.decryptWithKey(loaded, chromiumEncrypt(key, "sk-round-trip")), "sk-round-trip");
});

test("a missing or malformed Local State yields no key instead of throwing", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcdp-secrets-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(await secrets.loadDiskKey(path.join(dir, "Local State")), null);
  fs.writeFileSync(path.join(dir, "Local State"), "{ not json");
  assert.equal(await secrets.loadDiskKey(path.join(dir, "Local State")), null);
  fs.writeFileSync(path.join(dir, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: Buffer.from("XXXXXnot-dpapi").toString("base64") } }));
  assert.equal(await secrets.loadDiskKey(path.join(dir, "Local State")), null);
});
