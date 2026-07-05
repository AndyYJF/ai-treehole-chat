import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createPostgresMemoryRepository } from "./postgres";
import type { MemoryCandidate, MemoryRecord } from "./types";
import {
  addMemoryCandidates as addMemoryCandidatesInMemory,
  clearMemories as clearMemoriesInMemory,
  confirmMemory as confirmMemoryInMemory,
  deleteMemory as deleteMemoryInMemory,
  getMemorySettings as getMemorySettingsInMemory,
  listMemories as listMemoriesInMemory,
  setMemoryEnabled as setMemoryEnabledInMemory,
  sortMemoryForPrompt,
} from "./store";

export type MemorySettings = {
  enabled: boolean;
};

export type MemoryRepository = {
  listMemories(userId: string): Promise<MemoryRecord[]>;
  addMemoryCandidates(userId: string, candidates: MemoryCandidate[]): Promise<MemoryRecord[]>;
  confirmMemory(userId: string, memoryId: string): Promise<MemoryRecord[]>;
  deleteMemory(userId: string, memoryId: string): Promise<MemoryRecord[]>;
  clearMemories(userId: string): Promise<MemoryRecord[]>;
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
  async deleteMemory(userId, memoryId) {
    return deleteMemoryInMemory(userId, memoryId);
  },
  async clearMemories(userId) {
    return clearMemoriesInMemory(userId);
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
        .is("valid_until", null);

      if (error) throw new Error(`Failed to list memories: ${error.message}`);
      return (data ?? []).map(memoryFromRow).sort(sortMemoryForPrompt);
    },

    async addMemoryCandidates(userId, candidates) {
      if (candidates.length === 0) return this.listMemories(userId);

      const now = new Date().toISOString();
      const rows = candidates.map((candidate) => ({
        user_id: userId,
        type: candidate.type,
        content: candidate.content,
        confidence: candidate.confidence,
        importance: candidate.importance,
        sensitivity: candidate.sensitivity,
        source_message_ids: candidate.sourceMessageIds,
        user_confirmed: false,
        valid_from: candidate.validFrom,
        valid_until: candidate.validUntil,
        created_at: now,
        last_seen_at: now,
      }));

      const { error } = await client.from("memories").insert(rows);
      if (error) throw new Error(`Failed to add memories: ${error.message}`);
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
