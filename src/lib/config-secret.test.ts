import { describe, expect, it } from "vitest";
import { decryptConfigSecret, encryptConfigSecret, isEncryptedConfigSecret } from "./config-secret";

describe("configuration encryption", () => {
  it("round-trips a value with authenticated encryption", () => {
    const encrypted = encryptConfigSecret("provider-key", "test-master-secret");
    expect(isEncryptedConfigSecret(encrypted)).toBe(true);
    expect(encrypted).not.toContain("provider-key");
    expect(decryptConfigSecret(encrypted, "test-master-secret")).toBe("provider-key");
  });

  it("continues to read legacy plaintext rows", () => {
    expect(decryptConfigSecret("legacy-value", "test-master-secret")).toBe("legacy-value");
  });

  it("rejects an incorrect encryption key", () => {
    const encrypted = encryptConfigSecret("provider-key", "test-master-secret");
    expect(() => decryptConfigSecret(encrypted, "other-master-secret")).toThrow("Unable to decrypt");
  });
});
