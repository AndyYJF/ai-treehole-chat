import { getRuntimeConfig } from "../app-config";
import { sortMemoryForPrompt } from "./store";
import type { MemoryRecord } from "./types";

type RerankResult = {
  index?: number;
  relevance_score?: number;
};

type RerankResponse = {
  results?: RerankResult[];
};

type SelectRelevantMemoriesInput = {
  query: string;
  memories: MemoryRecord[];
  limit?: number;
};

const DEFAULT_LIMIT = 10;
const PINNED_TYPES = new Set<MemoryRecord["type"]>(["safety", "boundary"]);

export async function selectRelevantMemories({
  query,
  memories,
  limit = DEFAULT_LIMIT,
}: SelectRelevantMemoriesInput): Promise<MemoryRecord[]> {
  if (memories.length <= limit) return [...memories].sort(sortMemoryForPrompt);

  const sorted = [...memories].sort(sortMemoryForPrompt);
  const pinned = sorted.filter((memory) => PINNED_TYPES.has(memory.type)).slice(0, Math.min(4, limit));
  const pinnedIds = new Set(pinned.map((memory) => memory.id));
  const pool = sorted.filter((memory) => !pinnedIds.has(memory.id));
  const room = Math.max(limit - pinned.length, 0);

  if (room === 0) return pinned;

  const reranked = await rerankWithSiliconFlow(query, pool, room);
  const selected = reranked.length > 0 ? reranked : pool.slice(0, room);

  return [...pinned, ...selected].sort(sortMemoryForPrompt).slice(0, limit);
}

async function rerankWithSiliconFlow(query: string, memories: MemoryRecord[], limit: number): Promise<MemoryRecord[]> {
  const config = await getRuntimeConfig();
  const apiKey = config.siliconFlowApiKey;
  if (!apiKey || memories.length === 0) return [];

  const baseUrl = config.siliconFlowBaseUrl;
  const model = config.siliconFlowRerankModel;
  const documents = memories.map(formatMemoryForRerank);

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/rerank`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        query,
        documents,
        return_documents: false,
        top_n: Math.min(memories.length, Math.max(limit * 2, limit)),
      }),
      signal: AbortSignal.timeout(3500),
    });

    if (!response.ok) return [];

    const payload = (await response.json()) as RerankResponse;
    return (payload.results ?? [])
      .filter((result): result is Required<RerankResult> => Number.isInteger(result.index))
      .sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))
      .map((result) => memories[result.index])
      .filter((memory): memory is MemoryRecord => Boolean(memory))
      .slice(0, limit);
  } catch {
    return [];
  }
}

function formatMemoryForRerank(memory: MemoryRecord): string {
  const confidence = Math.round(memory.confidence * 100);
  const confirmed = memory.userConfirmed ? "confirmed" : "unconfirmed";

  return [
    `type=${memory.type}`,
    `importance=${memory.importance}`,
    `confidence=${confidence}`,
    `status=${confirmed}`,
    memory.content,
  ].join("\n");
}
