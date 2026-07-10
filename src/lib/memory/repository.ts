import { randomUUID } from "crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createPostgresMemoryRepository } from "./postgres";
import { applyMemoryDecay, findMergeTarget, maintainMemoryRecords, mergeMemoryRecord } from "./merge";
import type { MemoryCandidate, MemoryRecord, MemoryUpdate } from "./types";
import {
  addMemoryCandidates as addMemoryCandidatesInMemory,
  clearMemories as clearMemoriesInMemory,
  confirmMemory as confirmMemoryInMemory,
  deleteMemory as deleteMemoryInMemory,
  getMemorySettings as getMemorySettingsInMemory,
  maintainMemories as maintainMemoriesInMemory,
  listMemories as listMemoriesInMemory,
  setMemoryEnabled as setMemoryEnabledInMemory,
  sortMemoryForPrompt,
  updateMemory as updateMemoryInMemory,
} from "./store";

export type MemorySettings = {
  enabled: boolean;
};

export type MemoryRepository = {
  listMemories(userId: string): Promise<MemoryRecord[]>;
  addMemoryCandidates(userId: string, candidates: MemoryCandidate[]): Promise<MemoryRecord[]>;
  confirmMemory(userId: string, memoryId: string): Promise<MemoryRecord[]>;
  updateMemory(userId: string, memoryId: string, update: MemoryUpdate): Promise<MemoryRecord[]>;
  deleteMemory(userId: string, memoryId: string): Promise<MemoryRecord[]>;
  clearMemories(userId: string): Promise<MemoryRecord[]>;
  maintainMemories(userId: string): Promise<MemoryRecord[]>;
  getMemorySettings(userId: string): Promise<MemorySettings>;
  setMemoryEnabled(userId: string, enabled: boolean): Promise<MemorySettings>;
};

let cachedRepository: MemoryRepository | null = null;

export function getMemoryRepository(): MemoryRepository {
  if (cachedRepository) return cachedRepository;

  const databaseUrl = process.env.DATABASE_URL;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (databaseUrl) {
    cachedRepository = createPostgresMemoryRepository(databaseUrl);
    return cachedRepository;
  }

  if (supabaseUrl && serviceRoleKey) {
    cachedRepository = createSupabaseMemoryRepository(
      createClient(supabaseUrl, serviceRoleKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      }),
    );
    return cachedRepository;
  }

  cachedRepository = inMemoryMemoryRepository;
  return cachedRepository;
}

const inMemoryMemoryRepository: MemoryRepository = {
  async listMemories(userId) {
    return listMemoriesInMemory(userId);
  },
  async addMemoryCandidates(userId, candidates) {
    return addMemoryCandidatesInMemory(userId, candidates);
  },
  async confirmMemory(userId, memoryId) {
    return confirmMemoryInMemory(userId, memoryId);
  },
  async updateMemory(userId, memoryId, update) {
    return updateMemoryInMemory(userId, memoryId, update);
  },
  async deleteMemory(userId, memoryId) {
    return deleteMemoryInMemory(userId, memoryId);
  },
  async clearMemories(userId) {
    return clearMemoriesInMemory(userId);
  },
  async maintainMemories(userId) {
    return maintainMemoriesInMemory(userId);
  },
  async getMemorySettings(userId) {
    return getMemorySettingsInMemory(userId);
  },
  async setMemoryEnabled(userId, enabled) {
    return setMemoryEnabledInMemory(userId, enabled);
  },
};

function createSupabaseMemoryRepository(client: SupabaseClient): MemoryRepository {
  return {
    async listMemories(userId) {
      const { data, error } = await client
        .from("memories")
        .select(
          "id,user_id,type,content,confidence,importance,sensitivity,source_message_ids,user_confirmed,valid_from,valid_until,created_at,last_seen_at",
        )
        .eq("user_id", userId)
        .or("valid_from.is.null,valid_from.lte.now()").or("valid_until.is.null,valid_until.gt.now()");

      if (error) throw new Error(`Failed to list memories: ${error.message}`);
      return (data ?? []).map(memoryFromRow).map(m => applyMemoryDecay(m)).sort(sortMemoryForPrompt);
    },

    async addMemoryCandidates(userId, candidates) {
      if (candidates.length === 0) return this.listMemories(userId);

      const now = new Date().toISOString();
      let existing = await this.listMemories(userId);

      for (const candidate of candidates) {
        const incoming = memoryRecordFromCandidate(userId, candidate, now);
        const target = findMergeTarget(existing, incoming);

        if (target) {
          const merged = mergeMemoryRecord(target, incoming);
          const { error } = await client
            .from("memories")
            .update(memoryToSupabaseUpdate(merged))
            .eq("user_id", userId)
            .eq("id", target.id);

          if (error) throw new Error(`Failed to merge memory: ${error.message}`);
          existing = existing.map((memory) => (memory.id === target.id ? merged : memory));
          continue;
        }

        const { error } = await client.from("memories").insert(memoryToSupabaseInsert(incoming));
        if (error) throw new Error(`Failed to add memories: ${error.message}`);
        existing = [...existing, incoming];
      }

      return this.listMemories(userId);
    },

    async confirmMemory(userId, memoryId) {
      const now = new Date().toISOString();
      const { error } = await client
        .from("memories")
        .update({
          user_confirmed: true,
          confidence: 0.9,
          last_seen_at: now,
        })
        .eq("user_id", userId)
        .eq("id", memoryId);

      if (error) throw new Error(`Failed to confirm memory: ${error.message}`);
      return this.listMemories(userId);
    },

    async updateMemory(userId, memoryId, update) {
      const now = new Date().toISOString();
      const existing = await this.listMemories(userId);
      const current = existing.find((memory) => memory.id === memoryId);
      if (!current) return existing;

      const incoming: MemoryRecord = {
        ...current,
        type: update.type,
        content: update.content.trim(),
        importance: update.importance,
        sensitivity: update.sensitivity,
        userConfirmed: true,
        confidence: Math.max(current.confidence, 0.9),
        lastSeenAt: now,
      };
      const target = findMergeTarget(existing, incoming, memoryId);

      if (target) {
        const merged = mergeMemoryRecord(target, incoming);
        const { error: updateError } = await client
          .from("memories")
          .update(memoryToSupabaseUpdate(merged))
          .eq("user_id", userId)
          .eq("id", target.id);

        if (updateError) throw new Error(`Failed to merge memory: ${updateError.message}`);

        const { error: deleteError } = await client.from("memories").delete().eq("user_id", userId).eq("id", memoryId);
        if (deleteError) throw new Error(`Failed to merge memory: ${deleteError.message}`);

        return this.listMemories(userId);
      }

      const { error } = await client.from("memories").update(memoryToSupabaseUpdate(incoming)).eq("user_id", userId).eq("id", memoryId);

      if (error) throw new Error(`Failed to update memory: ${error.message}`);
      return this.listMemories(userId);
    },

    async deleteMemory(userId, memoryId) {
      const { error } = await client.from("memories").delete().eq("user_id", userId).eq("id", memoryId);
      if (error) throw new Error(`Failed to delete memory: ${error.message}`);
      return this.listMemories(userId);
    },

    async clearMemories(userId) {
      const { error } = await client.from("memories").delete().eq("user_id", userId);
      if (error) throw new Error(`Failed to clear memories: ${error.message}`);
      return [];
    },

    async maintainMemories(userId) {
      const memories = await this.listMemories(userId);
      const maintained = maintainMemoryRecords(memories);
      const maintainedIds = new Set(maintained.map((memory) => memory.id));

      for (const memory of maintained) {
        const { error } = await client
          .from("memories")
          .update(memoryToSupabaseUpdate(memory))
          .eq("user_id", userId)
          .eq("id", memory.id);

        if (error) throw new Error(`Failed to maintain memories: ${error.message}`);
      }

      for (const memory of memories) {
        if (maintainedIds.has(memory.id)) continue;

        const { error } = await client.from("memories").delete().eq("user_id", userId).eq("id", memory.id);
        if (error) throw new Error(`Failed to maintain memories: ${error.message}`);
      }

      return this.listMemories(userId);
    },

    async getMemorySettings(userId) {
      const { data, error } = await client
        .from("user_memory_settings")
        .select("enabled")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) throw new Error(`Failed to read memory settings: ${error.message}`);
      return { enabled: data?.enabled ?? true };
    },

    async setMemoryEnabled(userId, enabled) {
      const { error } = await client.from("user_memory_settings").upsert(
        {
          user_id: userId,
          enabled,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );

      if (error) throw new Error(`Failed to update memory settings: ${error.message}`);
      return { enabled };
    },
  };
}

function memoryRecordFromCandidate(userId: string, candidate: MemoryCandidate, now: string): MemoryRecord {
  return {
    id: `mem-${randomUUID()}`,
    userId,
    type: candidate.type,
    content: candidate.content.trim(),
    confidence: candidate.confidence,
    importance: candidate.importance,
    sensitivity: candidate.sensitivity,
    sourceMessageIds: candidate.sourceMessageIds,
    userConfirmed: false,
    validFrom: candidate.validFrom,
    validUntil: candidate.validUntil,
    createdAt: now,
    lastSeenAt: now,
  };
}

function memoryToSupabaseInsert(memory: MemoryRecord) {
  return {
    id: memory.id,
    user_id: memory.userId,
    type: memory.type,
    content: memory.content,
    confidence: memory.confidence,
    importance: memory.importance,
    sensitivity: memory.sensitivity,
    source_message_ids: memory.sourceMessageIds,
    user_confirmed: memory.userConfirmed,
    valid_from: memory.validFrom,
    valid_until: memory.validUntil,
    created_at: memory.createdAt,
    last_seen_at: memory.lastSeenAt,
  };
}

function memoryToSupabaseUpdate(memory: MemoryRecord) {
  return {
    type: memory.type,
    content: memory.content.trim(),
    confidence: memory.confidence,
    importance: memory.importance,
    sensitivity: memory.sensitivity,
    source_message_ids: memory.sourceMessageIds,
    user_confirmed: memory.userConfirmed,
    valid_from: memory.validFrom,
    valid_until: memory.validUntil,
    created_at: memory.createdAt,
    last_seen_at: memory.lastSeenAt,
  };
}

function memoryFromRow(row: Record<string, unknown>): MemoryRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    type: row.type as MemoryRecord["type"],
    content: String(row.content),
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    sensitivity: row.sensitivity as MemoryRecord["sensitivity"],
    sourceMessageIds: Array.isArray(row.source_message_ids) ? row.source_message_ids.map(String) : [],
    userConfirmed: Boolean(row.user_confirmed),
    validFrom: row.valid_from ? String(row.valid_from) : null,
    validUntil: row.valid_until ? String(row.valid_until) : null,
    createdAt: String(row.created_at),
    lastSeenAt: String(row.last_seen_at),
  };
}
