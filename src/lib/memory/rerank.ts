import { getRuntimeConfig } from "../app-config";
import { effectiveMemoryImportance, memorySimilarity } from "./merge";
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

const DEFAULT_LIMIT = 8;
const PINNED_TYPES = new Set<MemoryRecord["type"]>(["boundary", "procedural"]);
const minimumRerankScore = 0.08;
const minimumLocalScore = 0.12;

export async function selectRelevantMemories({
  query,
  memories,
  limit = DEFAULT_LIMIT,
}: SelectRelevantMemoriesInput): Promise<MemoryRecord[]> {
  const sorted = [...memories].sort(sortMemoryForPrompt);
  const pinned = sorted
    .filter((memory) => PINNED_TYPES.has(memory.type))
    .slice(0, Math.min(3, limit));
  const pinnedIds = new Set(pinned.map((memory) => memory.id));
  const pool = sorted.filter((memory) => !pinnedIds.has(memory.id));
  const room = Math.max(limit - pinned.length, 0);

  if (room === 0) return pinned;

  const reranked = await rerankWithSiliconFlow(query, pool, room);
  const selected = reranked.length > 0 ? reranked : rerankLocally(query, pool, room);

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
      .filter(
        (result): result is Required<RerankResult> =>
          Number.isInteger(result.index) &&
          typeof result.relevance_score === "number" &&
          result.relevance_score >= minimumRerankScore,
      )
      .sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))
      .map((result) => memories[result.index])
      .filter((memory): memory is MemoryRecord => Boolean(memory))
      .slice(0, limit);
  } catch {
    return [];
  }
}

function rerankLocally(query: string, memories: MemoryRecord[], limit: number) {
  const now = Date.now();

  return memories
    .map((memory) => {
      const lexical = memorySimilarity(query, memory.content, memory.type);
      const importance = effectiveMemoryImportance(memory) / 100;
      const confidence = memory.confidence;
      const lastSeen = new Date(memory.lastSeenAt).getTime();
      const ageDays = Number.isFinite(lastSeen)
        ? Math.max(0, (now - lastSeen) / (24 * 60 * 60 * 1000))
        : 365;
      const recency = Math.exp(-ageDays / 90);
      const score = lexical * 0.68 + importance * 0.14 + confidence * 0.1 + recency * 0.08;

      return { memory, score };
    })
    .filter((item) => item.score >= minimumLocalScore)
    .sort((left, right) => right.score - left.score || left.memory.id.localeCompare(right.memory.id))
    .slice(0, limit)
    .map((item) => item.memory);
}

function formatMemoryForRerank(memory: MemoryRecord): string {
  const confidence = Math.round(memory.confidence * 100);

  return [
    `type=${memory.type}`,
    `importance=${memory.importance}`,
    `confidence=${confidence}`,
    memory.content,
  ].join("\n");
}
