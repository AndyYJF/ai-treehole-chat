import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { callDeepSeek, type ChatMessage } from "./deepseek";
import { getMemoryRepository } from "./memory/repository";
import { extractMemoryCandidates } from "./memory/extract";
import { selectRelevantMemories } from "./memory/rerank";
import { selectRetrievableMemories, selectStableSystemMemories } from "./memory/policy";
import type { MemoryCandidate, MemoryRecord } from "./memory/types";
import { routeModel, type ModelTier, type RoutedModel } from "./model-routing";
import { recordModelUsage } from "./model-usage";
import { buildChatMessages } from "./prompt";
import { buildRealityContext, type RealityContextStatus } from "./reality-context";
import { assessSafetyRisk, formatSafetyContext, type SafetyAssessment } from "./safety";
import type { VisionAnalysis } from "./vision";

type RecentMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  context?: { vision?: VisionAnalysis; visionWarning?: string };
};

type ChatEngineInput = {
  userId: string;
  messageId?: string;
  message: string;
  tier: ModelTier;
  memoryEnabled: boolean;
  temperature: number;
  recentMessages: RecentMessage[];
  visionAnalysis?: VisionAnalysis;
  visionWarning?: string;
  onRealityStatus?: (status: RealityContextStatus) => void;
};

export type PreparedChatTurn = {
  messageId: string;
  routed: RoutedModel;
  memories: MemoryRecord[];
  systemMemories: MemoryRecord[];
  realityContext: string;
  promptMessages: ChatMessage[];
};

const ChatTurnState = Annotation.Root({
  userId: Annotation<string>(),
  message: Annotation<string>(),
  tier: Annotation<ModelTier>(),
  memoryEnabled: Annotation<boolean>(),
  temperature: Annotation<number>(),
  recentMessages: Annotation<RecentMessage[]>(),
  visionAnalysis: Annotation<VisionAnalysis | undefined>(),
  visionWarning: Annotation<string | undefined>(),
  messageId: Annotation<string>(),
  routed: Annotation<RoutedModel>(),
  memories: Annotation<MemoryRecord[]>(),
  systemMemories: Annotation<MemoryRecord[]>(),
  realityContext: Annotation<string>(),
  promptMessages: Annotation<ChatMessage[]>(),
  safetyAssessment: Annotation<SafetyAssessment>(),
  reply: Annotation<string>(),
  memoryCandidates: Annotation<MemoryCandidate[]>(),
  updatedMemories: Annotation<MemoryRecord[]>(),
});

async function prepareTurn(state: typeof ChatTurnState.State) {
  return {
    messageId: state.messageId || `msg-${Date.now()}`,
  };
}

async function routeTurn(state: typeof ChatTurnState.State) {
  const safetyAssessment = assessSafetyRisk(state.message);
  return {
    safetyAssessment,
    routed: routeModel({
      userTier: state.tier,
      latestMessage: state.message,
      recentMessageCount: state.recentMessages.length,
      safetyLevel: safetyAssessment.level,
    }),
  };
}

async function retrieveMemories(state: typeof ChatTurnState.State) {
  const repository = getMemoryRepository();
  const allMemories = state.memoryEnabled ? await repository.listMemories(state.userId) : [];
  const memories = selectRetrievableMemories(allMemories);

  return {
    systemMemories: selectStableSystemMemories(allMemories),
    memories: await selectRelevantMemories({
      query: state.message,
      memories,
    }),
  };
}

async function composePrompt(state: typeof ChatTurnState.State) {
  const realityContext = await buildRealityContext({
    userId: state.userId,
    latestMessage: state.message,
    recentMessages: state.recentMessages,
  });

  return {
    realityContext,
    promptMessages: buildChatMessages({
      memories: state.systemMemories,
      relevantMemories: state.memories,
      realityContext,
      safetyContext: formatSafetyContext(state.safetyAssessment),
      visionAnalysis: state.visionAnalysis,
      visionWarning: state.visionWarning,
      threadSummary: "",
      recentMessages: state.recentMessages.slice(-12),
      latestMessage: state.message,
      latestMessageCreatedAt: new Date().toISOString(),
    }),
  };
}

async function generateReply(state: typeof ChatTurnState.State) {
  return {
    reply: await callDeepSeek({
      userId: state.userId,
      operation: "chat",
      model: state.routed.model,
      messages: state.promptMessages,
      temperature: state.temperature,
    }),
  };
}

async function extractMemories(state: typeof ChatTurnState.State) {
  const start = Date.now();
  const memoryCandidates = state.memoryEnabled
    ? await extractMemoryCandidates({
        userId: state.userId,
        messageId: state.messageId,
        userMessage: state.message,
      })
    : [];
  await recordMemoryExtractResult(state.userId, memoryCandidates.length, start);

  return {
    memoryCandidates,
  };
}

async function persistMemories(state: typeof ChatTurnState.State) {
  const repository = getMemoryRepository();

  return {
    updatedMemories:
      state.memoryEnabled && state.memoryCandidates.length > 0
        ? await repository.addMemoryCandidates(state.userId, state.memoryCandidates)
        : state.memories,
  };
}

const chatTurnGraph = new StateGraph(ChatTurnState)
  .addNode("prepareTurn", prepareTurn)
  .addNode("routeTurn", routeTurn)
  .addNode("retrieveMemories", retrieveMemories)
  .addNode("composePrompt", composePrompt)
  .addNode("generateReply", generateReply)
  .addNode("extractMemories", extractMemories)
  .addNode("persistMemories", persistMemories)
  .addEdge(START, "prepareTurn")
  .addEdge("prepareTurn", "routeTurn")
  .addEdge("routeTurn", "retrieveMemories")
  .addEdge("retrieveMemories", "composePrompt")
  .addEdge("composePrompt", "generateReply")
  .addEdge("generateReply", "extractMemories")
  .addEdge("extractMemories", "persistMemories")
  .addEdge("persistMemories", END)
  .compile();

export async function runChatTurn(input: ChatEngineInput) {
  const result = await chatTurnGraph.invoke({
    ...input,
    messageId: input.messageId ?? "",
    memories: [],
    systemMemories: [],
    realityContext: "",
    promptMessages: [],
    safetyAssessment: assessSafetyRisk(input.message),
    reply: "",
    memoryCandidates: [],
    updatedMemories: [],
  });

  return {
    reply: result.reply,
    routed: result.routed,
    memories: result.updatedMemories.slice(0, 8),
  };
}

export async function prepareChatTurn(input: ChatEngineInput): Promise<PreparedChatTurn> {
  const messageId = input.messageId ?? `msg-${Date.now()}`;
  const safetyAssessment = assessSafetyRisk(input.message);
  const routed = routeModel({
    userTier: input.tier,
    latestMessage: input.message,
    recentMessageCount: input.recentMessages.length,
    safetyLevel: safetyAssessment.level,
  });
  const repository = getMemoryRepository();
  const allMemories = input.memoryEnabled ? await repository.listMemories(input.userId) : [];
  const systemMemories = selectStableSystemMemories(allMemories);
  const retrievableMemories = selectRetrievableMemories(allMemories);
  const memories = await selectRelevantMemories({
    query: input.message,
    memories: retrievableMemories,
  });
  const realityContext = await buildRealityContext({
    userId: input.userId,
    latestMessage: input.message,
    recentMessages: input.recentMessages,
    onStatus: input.onRealityStatus,
  });
  const promptMessages = buildChatMessages({
    memories: systemMemories,
    relevantMemories: memories,
    realityContext,
    safetyContext: formatSafetyContext(safetyAssessment),
    visionAnalysis: input.visionAnalysis,
    visionWarning: input.visionWarning,
    threadSummary: "",
    recentMessages: input.recentMessages.slice(-12),
    latestMessage: input.message,
    latestMessageCreatedAt: new Date().toISOString(),
  });

  return {
    messageId,
    routed,
    memories,
    systemMemories,
    realityContext,
    promptMessages,
  };
}

export async function finishChatTurn(input: {
  userId: string;
  messageId: string;
  message: string;
  memoryEnabled: boolean;
  memories: MemoryRecord[];
}) {
  const start = Date.now();
  let memoryCandidates: MemoryCandidate[] = [];

  try {
    memoryCandidates = input.memoryEnabled
      ? await extractMemoryCandidates({
          userId: input.userId,
          messageId: input.messageId,
          userMessage: input.message,
        })
      : [];
  } catch {
    memoryCandidates = [];
  }
  await recordMemoryExtractResult(input.userId, memoryCandidates.length, start);

  if (!input.memoryEnabled || memoryCandidates.length === 0) {
    return input.memories.slice(0, 8);
  }

  try {
    const repository = getMemoryRepository();
    return (await repository.addMemoryCandidates(input.userId, memoryCandidates)).slice(0, 8);
  } catch {
    return input.memories.slice(0, 8);
  }
}

async function recordMemoryExtractResult(userId: string, candidateCount: number, start: number) {
  try {
    await recordModelUsage({
      userId,
      provider: "app",
      operation: "memory_extract_result",
      model: "memory_candidates",
      streamed: false,
      success: true,
      statusCode: null,
      latencyMs: Date.now() - start,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      promptCacheHitTokens: null,
      promptCacheMissTokens: null,
      reasoningTokens: null,
      errorMessage: `candidates=${candidateCount}`,
    });
  } catch {
    // Observability must not block chat.
  }
}
