import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { callDeepSeek, type ChatMessage } from "./deepseek";
import { getMemoryRepository } from "./memory/repository";
import { extractMemoryCandidates } from "./memory/extract";
import { selectRelevantMemories } from "./memory/rerank";
import type { MemoryCandidate, MemoryRecord } from "./memory/types";
import { routeModel, type ModelTier, type RoutedModel } from "./model-routing";
import { buildChatMessages } from "./prompt";
import { buildRealityContext } from "./reality-context";

type RecentMessage = { role: "user" | "assistant"; content: string; createdAt?: string };

type ChatEngineInput = {
  userId: string;
  message: string;
  tier: ModelTier;
  memoryEnabled: boolean;
  temperature: number;
  recentMessages: RecentMessage[];
};

export type PreparedChatTurn = {
  messageId: string;
  routed: RoutedModel;
  memories: MemoryRecord[];
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
  messageId: Annotation<string>(),
  routed: Annotation<RoutedModel>(),
  memories: Annotation<MemoryRecord[]>(),
  realityContext: Annotation<string>(),
  promptMessages: Annotation<ChatMessage[]>(),
  reply: Annotation<string>(),
  memoryCandidates: Annotation<MemoryCandidate[]>(),
  updatedMemories: Annotation<MemoryRecord[]>(),
});

async function prepareTurn() {
  return {
    messageId: `msg-${Date.now()}`,
  };
}

async function routeTurn(state: typeof ChatTurnState.State) {
  return {
    routed: routeModel({
      userTier: state.tier,
      latestMessage: state.message,
      recentMessageCount: state.recentMessages.length,
    }),
  };
}

async function retrieveMemories(state: typeof ChatTurnState.State) {
  const repository = getMemoryRepository();
  const memories = state.memoryEnabled ? await repository.listMemories(state.userId) : [];

  return {
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
      memories: state.memories,
      realityContext,
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
  return {
    memoryCandidates: state.memoryEnabled
      ? await extractMemoryCandidates({
          userId: state.userId,
          messageId: state.messageId,
          userMessage: state.message,
        })
      : [],
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
    messageId: "",
    memories: [],
    realityContext: "",
    promptMessages: [],
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
  const messageId = `msg-${Date.now()}`;
  const routed = routeModel({
    userTier: input.tier,
    latestMessage: input.message,
    recentMessageCount: input.recentMessages.length,
  });
  const repository = getMemoryRepository();
  const allMemories = input.memoryEnabled ? await repository.listMemories(input.userId) : [];
  const memories = await selectRelevantMemories({
    query: input.message,
    memories: allMemories,
  });
  const realityContext = await buildRealityContext({
    userId: input.userId,
    latestMessage: input.message,
    recentMessages: input.recentMessages,
  });
  const promptMessages = buildChatMessages({
    memories,
    realityContext,
    threadSummary: "",
    recentMessages: input.recentMessages.slice(-12),
    latestMessage: input.message,
    latestMessageCreatedAt: new Date().toISOString(),
  });

  return {
    messageId,
    routed,
    memories,
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
  const memoryCandidates = input.memoryEnabled
    ? await extractMemoryCandidates({
        userId: input.userId,
        messageId: input.messageId,
        userMessage: input.message,
      })
    : [];

  if (!input.memoryEnabled || memoryCandidates.length === 0) {
    return input.memories.slice(0, 8);
  }

  const repository = getMemoryRepository();
  return (await repository.addMemoryCandidates(input.userId, memoryCandidates)).slice(0, 8);
}
