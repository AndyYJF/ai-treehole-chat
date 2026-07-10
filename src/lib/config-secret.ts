import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const encryptedPrefix = "enc:v1:";

export function encryptConfigSecret(value: string, masterSecret = configEncryptionSecret()) {
  if (!value || !masterSecret) return value;
  const key = createHash("sha256").update(masterSecret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${encryptedPrefix}${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptConfigSecret(value: string, masterSecret = configEncryptionSecret()) {
  if (!value.startsWith(encryptedPrefix)) return value;
  if (!masterSecret) {
    throw new Error("Encrypted configuration requires TREEHOLE_CONFIG_ENCRYPTION_KEY or TREEHOLE_SESSION_SECRET");
  }

  const [ivEncoded, tagEncoded, ciphertextEncoded] = value.slice(encryptedPrefix.length).split(".");
  if (!ivEncoded || !tagEncoded || !ciphertextEncoded) throw new Error("Stored encrypted configuration is malformed");

  try {
    const key = createHash("sha256").update(masterSecret).digest();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivEncoded, "base64url"));
    decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextEncoded, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Unable to decrypt stored configuration with the current encryption key");
  }
}

export function configEncryptionSecret() {
  return process.env.TREEHOLE_CONFIG_ENCRYPTION_KEY?.trim() || process.env.TREEHOLE_SESSION_SECRET?.trim() || "";
}

export function isEncryptedConfigSecret(value: string) {
  return value.startsWith(encryptedPrefix);
}
