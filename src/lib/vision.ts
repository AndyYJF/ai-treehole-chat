import type { RuntimeConfig } from "./app-config";
import { recordModelUsage } from "./model-usage";

const visionPrompt =
  "请详细描述这张图片的内容。你需要像一个心理咨询师的助手一样，留意画面中的主体、色彩、可能暗示的情绪氛围。如果图片中包含文字，请提取出来。直接输出描述，不要加任何废话。";

export async function extractImageDescription(
  imageBase64: string,
  config: RuntimeConfig,
): Promise<string> {
  const start = Date.now();
  const apiKey = config.visionApiKey.trim();
  const model = config.visionModelName.trim();
  const baseUrl = config.visionBaseUrl.trim();

  if (!apiKey || !model || !baseUrl) {
    throw new Error("Vision model is not configured");
  }

  const response = await fetch(joinUrl(baseUrl, "chat/completions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: visionPrompt,
            },
            {
              type: "image_url",
              image_url: {
                url: normalizeImageUrl(imageBase64),
              },
            },
          ],
        },
      ],
      temperature: 0.2,
      stream: false,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    await recordVisionUsageSafely({
      config,
      success: false,
      statusCode: response.status,
      start,
      errorMessage: detail,
    });
    throw new Error(`Vision request failed: ${response.status} ${detail}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
  const description = data.choices?.[0]?.message?.content?.trim();

  await recordVisionUsageSafely({
    config,
    success: true,
    statusCode: response.status,
    start,
    usage: data.usage,
  });

  if (!description) throw new Error("Vision model returned empty description");

  return description;
}

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function normalizeImageUrl(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("data:")) return trimmed;
  return `data:image/jpeg;base64,${trimmed}`;
}

async function recordVisionUsageSafely(input: {
  config: RuntimeConfig;
  success: boolean;
  statusCode: number | null;
  start: number;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  errorMessage?: string;
}) {
  try {
    await recordModelUsage({
      userId: input.config.defaultUserId,
      provider: "vision",
      operation: "vision_extract",
      model: input.config.visionModelName,
      streamed: false,
      success: input.success,
      statusCode: input.statusCode,
      latencyMs: Date.now() - input.start,
      promptTokens: input.usage?.prompt_tokens ?? null,
      completionTokens: input.usage?.completion_tokens ?? null,
      totalTokens: input.usage?.total_tokens ?? null,
      promptCacheHitTokens: null,
      promptCacheMissTokens: null,
      reasoningTokens: null,
      errorMessage: input.errorMessage?.slice(0, 800) ?? null,
    });
  } catch {
    // Vision telemetry should never block chat.
  }
}
