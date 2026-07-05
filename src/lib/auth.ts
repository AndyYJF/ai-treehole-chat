export const SESSION_COOKIE_NAME = "treehole_session";

export function isAccessGateEnabled() {
  return Boolean(process.env.TREEHOLE_ACCESS_TOKEN);
}

export async function createSessionValue() {
  const token = process.env.TREEHOLE_ACCESS_TOKEN;
  if (!token) return "";

  const secret = process.env.TREEHOLE_SESSION_SECRET ?? token;
  return sha256Hex(`${token}:${secret}`);
}

export async function isValidSession(value?: string) {
  if (!isAccessGateEnabled()) return true;
  if (!value) return false;

  return value === (await createSessionValue());
}

export async function isValidAccessToken(value: string) {
  const token = process.env.TREEHOLE_ACCESS_TOKEN;
  if (!token) return true;

  return value === token;
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
