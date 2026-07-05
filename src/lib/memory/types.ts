import { z } from "zod";

export const memoryTypeSchema = z.enum([
  "semantic",
  "episodic",
  "procedural",
  "affect",
  "safety",
  "preference",
  "boundary",
]);

export const sensitivitySchema = z.enum(["normal", "sensitive", "private"]);

export const memoryRecordSchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: memoryTypeSchema,
  content: z.string(),
  confidence: z.number().min(0).max(1),
  importance: z.number().int().min(0).max(100),
  sensitivity: sensitivitySchema,
  sourceMessageIds: z.array(z.string()),
  userConfirmed: z.boolean(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
});

export type MemoryType = z.infer<typeof memoryTypeSchema>;
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

export type MemoryCandidate = Pick<
  MemoryRecord,
  "type" | "content" | "confidence" | "importance" | "sensitivity" | "validFrom" | "validUntil"
> & {
  sourceMessageIds: string[];
};

export type MemoryUpdate = Pick<MemoryRecord, "type" | "content" | "importance" | "sensitivity">;

