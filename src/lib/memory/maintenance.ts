import { getMemoryRepository } from "./repository";

const defaultMaintenanceIntervalMs = 6 * 60 * 60 * 1000;
const lastMaintenanceByUser = new Map<string, number>();
const runningUsers = new Set<string>();

export async function maybeMaintainMemories(input: {
  userId: string;
  force?: boolean;
  intervalMs?: number;
}) {
  const intervalMs = input.intervalMs ?? defaultMaintenanceIntervalMs;
  const now = Date.now();
  const lastMaintenance = lastMaintenanceByUser.get(input.userId) ?? 0;

  if (!input.force && now - lastMaintenance < intervalMs) return;
  if (runningUsers.has(input.userId)) return;

  runningUsers.add(input.userId);

  try {
    const repository = getMemoryRepository();
    await repository.maintainMemories(input.userId);
    lastMaintenanceByUser.set(input.userId, Date.now());
  } catch {
    // Maintenance must never block chat or import flows.
  } finally {
    runningUsers.delete(input.userId);
  }
}
