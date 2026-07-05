export function getServerUserId() {
  return process.env.DEFAULT_USER_ID ?? "single-user";
}
