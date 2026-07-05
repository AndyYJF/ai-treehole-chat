import { normalizeUsage, recordModelUsage, type ModelUsage } from "./model-usage";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type DeepSeekOperation = "chat" | "memory_extract" | "title_summarize";

export async function callDeepSeek(input: {
  userId?: string;
  operation?: DeepSeekOperation;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  const start = Date.now();

  if (!apiKey) {
    const latest = input.messages.findLast((message) => message.role === "user")?.content ?? "";
    const reply = mockTreeholeReply(latest);
    await recordUsageSafely({
      input,
      provider: "mock",
      streamed: false,
      success: true,
      statusCode: null,
      start,
      usage: estimateUsage(input.messages, reply),
    });
    return reply;
  }

  const body = {
    model: input.model,
    messages: input.messages,
    temperature: input.temperature ?? 0.72,
    stream: false,
    user_id: input.userId,
  };

  const response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
    method: "POST",
    signal: input.signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text();
    await recordUsageSafely({
      input,
      provider: "deepseek",
      streamed: false,
      success: false,
      statusCode: response.status,
      start,
      errorMessage: detail,
    });
    throw new Error(`DeepSeek request failed: ${response.status} ${detail}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: unknown;
  };
  const reply = data.choices?.[0]?.message?.content?.trim() || "我在。你可以慢慢说。";

  await recordUsageSafely({
    input,
    provider: "deepseek",
    streamed: false,
    success: true,
    statusCode: response.status,
    start,
    usage: normalizeUsage(data.usage),
  });

  return reply;
}

export async function* streamDeepSeek(input: {
  userId?: string;
  operation?: DeepSeekOperation;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  signal?: AbortSignal;
}): AsyncGenerator<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  const start = Date.now();

  if (!apiKey) {
    const latest = input.messages.findLast((message) => message.role === "user")?.content ?? "";
    const reply = mockTreeholeReply(latest);

    for (const chunk of chunkText(reply)) {
      await new Promise((resolve) => setTimeout(resolve, 18));
      yield chunk;
    }

    await recordUsageSafely({
      input,
      provider: "mock",
      streamed: true,
      success: true,
      statusCode: null,
      start,
      usage: estimateUsage(input.messages, reply),
    });
    return;
  }

  const body = {
    model: input.model,
    messages: input.messages,
    temperature: input.temperature ?? 0.72,
    stream: true,
    stream_options: {
      include_usage: true,
    },
    user_id: input.userId,
  };

  const response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
    method: "POST",
    signal: input.signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.body) {
    const detail = await response.text();
    await recordUsageSafely({
      input,
      provider: "deepseek",
      streamed: true,
      success: false,
      statusCode: response.status,
      start,
      errorMessage: detail,
    });
    throw new Error(`DeepSeek stream failed: ${response.status} ${detail}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: ModelUsage = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const event of events) {
      for (const line of event.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        const chunk = parseStreamChunk(data);
        if (chunk.usage) usage = chunk.usage;
        if (chunk.delta) yield chunk.delta;
      }
    }
  }

  if (buffer.trim()) {
    for (const line of buffer.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      const chunk = parseStreamChunk(data);
      if (chunk.usage) usage = chunk.usage;
      if (chunk.delta) yield chunk.delta;
    }
  }

  await recordUsageSafely({
    input,
    provider: "deepseek",
    streamed: true,
    success: true,
    statusCode: response.status,
    start,
    usage,
  });
}

export async function callDeepSeekJson(input: {
  userId?: string;
  operation?: DeepSeekOperation;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
}): Promise<unknown | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  const start = Date.now();

  if (!apiKey) return null;

  const response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      temperature: input.temperature ?? 0.1,
      stream: false,
      response_format: {
        type: "json_object",
      },
      user_id: input.userId,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    await recordUsageSafely({
      input,
      provider: "deepseek",
      streamed: false,
      success: false,
      statusCode: response.status,
      start,
      errorMessage: detail,
    });
    return null;
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: unknown;
  };
  await recordUsageSafely({
    input,
    provider: "deepseek",
    streamed: false,
    success: true,
    statusCode: response.status,
    start,
    usage: normalizeUsage(data.usage),
  });

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) return null;

  return parseLooseJson(content);
}

function parseStreamChunk(data: string): { delta: string; usage?: ModelUsage } {
  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string } }>;
      usage?: unknown;
    };

    return {
      delta: parsed.choices?.[0]?.delta?.content ?? "",
      usage: parsed.usage ? normalizeUsage(parsed.usage) : undefined,
    };
  } catch {
    return { delta: "" };
  }
}

async function fetchWithRetry(url: string, init: RequestInit, maxAttempts = 3): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (!shouldRetryResponse(response) || attempt === maxAttempts) return response;
      await sleep(backoffMs(attempt));
    } catch (error) {
      if (isAbortError(error) || attempt === maxAttempts) throw error;
      lastError = error;
      await sleep(backoffMs(attempt));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Request failed");
}

function shouldRetryResponse(response: Response): boolean {
  return response.status === 429 || response.status >= 500;
}

function backoffMs(attempt: number): number {
  return 350 * 2 ** (attempt - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function recordUsageSafely(input: {
  input: {
    userId?: string;
    operation?: DeepSeekOperation;
    model: string;
  };
  provider: string;
  streamed: boolean;
  success: boolean;
  statusCode: number | null;
  start: number;
  usage?: ModelUsage;
  errorMessage?: string;
}) {
  if (!input.input.userId) return;

  try {
    await recordModelUsage({
      userId: input.input.userId,
      provider: input.provider,
      operation: input.input.operation ?? "chat",
      model: input.input.model,
      streamed: input.streamed,
      success: input.success,
      statusCode: input.statusCode,
      latencyMs: Date.now() - input.start,
      promptTokens: input.usage?.promptTokens ?? null,
      completionTokens: input.usage?.completionTokens ?? null,
      totalTokens: input.usage?.totalTokens ?? null,
      promptCacheHitTokens: input.usage?.promptCacheHitTokens ?? null,
      promptCacheMissTokens: input.usage?.promptCacheMissTokens ?? null,
      reasoningTokens: input.usage?.reasoningTokens ?? null,
      errorMessage: input.errorMessage?.slice(0, 800) ?? null,
    });
  } catch {
    // Usage logging should never block the chat experience.
  }
}

function estimateUsage(messages: ChatMessage[], reply: string): ModelUsage {
  const promptChars = messages.reduce((total, message) => total + message.content.length, 0);
  const completionChars = reply.length;
  const promptTokens = Math.ceil(promptChars / 2);
  const completionTokens = Math.ceil(completionChars / 2);

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: promptTokens,
  };
}

function chunkText(text: string): string[] {
  const chunks = text.match(/.{1,8}/gu);
  return chunks ?? [text];
}

function parseLooseJson(content: string): unknown | null {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/) ?? content.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (!match) return null;

    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }
}

function mockTreeholeReply(latest: string): string {
  if (!latest.trim()) return "我在。";

  if (latest.includes("怎么办") || latest.includes("焦虑") || latest.includes("难过")) {
    return "听起来这件事已经压了你一阵子。先不用急着把它处理好，我们可以先把最难受的那一块拆出来：是委屈、害怕，还是不知道下一步该怎么走？";
  }

  return "嗯，我听到了。你可以继续说，不需要组织得很完整，我会跟着你的节奏来。";
}
