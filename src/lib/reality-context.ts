import { getRuntimeConfig } from "./app-config";
import { callDeepSeekJson } from "./deepseek";

type PublicHoliday = {
  date: string;
  localName?: string;
  name?: string;
};

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

type SearchDecision = {
  shouldSearch: boolean;
  query: string;
  reason: string;
};

const holidayCache = new Map<string, { expiresAt: number; holidays: PublicHoliday[] }>();

export async function buildRealityContext(input: {
  userId: string;
  latestMessage: string;
  recentMessages?: Array<{ role: "user" | "assistant"; content: string }>;
}) {
  const config = await getRuntimeConfig();
  const now = new Date();
  const countryCode = normalizeCountryCode(config.realityCountryCode);
  const message = input.latestMessage.trim();
  const searchDecision =
    config.tavilyApiKey || config.braveSearchApiKey
      ? await decideSearchWithLlm({
          userId: input.userId,
          latestMessage: message,
          recentMessages: input.recentMessages ?? [],
          now,
          countryCode,
        })
      : {
          shouldSearch: false,
          query: "",
          reason: "未配置联网搜索 key",
        };
  const [holidayContext, searchContext] = await Promise.all([
    getHolidayContext(now, countryCode),
    searchDecision.shouldSearch
      ? getSearchContext(searchDecision.query || message, config, searchDecision)
      : Promise.resolve(`联网检索：LLM 判定本轮无需搜索。原因：${searchDecision.reason || "未说明"}`),
  ]);

  return [
    `当前时间：${formatUtc8DateTime(now)}，${formatUtc8Weekday(now)}。`,
    `默认地区：${countryCode}。`,
    holidayContext,
    searchContext,
    "使用规则：如果用户询问最新事实、现实状态、节假日或日期安排，优先依据本块信息回答；信息不足时明确说不确定，不要编造实时结论。树洞倾诉场景下不要生硬引用这些信息。",
  ].join("\n");
}

async function getHolidayContext(now: Date, countryCode: string) {
  try {
    const currentYear = getUtc8Year(now);
    const holidays = [
      ...(await listPublicHolidays(currentYear, countryCode)),
      ...(await listPublicHolidays(currentYear + 1, countryCode)),
    ];
    const today = formatUtc8Date(now);
    const todayHolidays = holidays.filter((holiday) => holiday.date === today);
    const upcoming = holidays
      .filter((holiday) => holiday.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 6);

    return [
      `今日节假日：${todayHolidays.length > 0 ? todayHolidays.map(formatHoliday).join("；") : "无公开节假日记录"}`,
      `近期节假日：${upcoming.length > 0 ? upcoming.map(formatHoliday).join("；") : "暂无近期公开节假日记录"}`,
      "节假日说明：该数据用于公共节假日感知，不保证覆盖补班/调休工作日。",
    ].join("\n");
  } catch {
    return "节假日查询失败：不要声称已确认节假日安排。";
  }
}

async function listPublicHolidays(year: number, countryCode: string) {
  const cacheKey = `${year}:${countryCode}`;
  const cached = holidayCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.holidays;

  const response = await fetchWithTimeout(
    `https://date.nager.at/api/v3/PublicHolidays/${year}/${encodeURIComponent(countryCode)}`,
    { headers: { Accept: "application/json" } },
    3500,
  );

  if (!response.ok) throw new Error(`Holiday lookup failed: ${response.status}`);

  const holidays = (await response.json()) as PublicHoliday[];
  holidayCache.set(cacheKey, {
    expiresAt: Date.now() + 12 * 60 * 60 * 1000,
    holidays,
  });

  return holidays;
}

async function decideSearchWithLlm(input: {
  userId: string;
  latestMessage: string;
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
  now: Date;
  countryCode: string;
}): Promise<SearchDecision> {
  if (!input.latestMessage) {
    return { shouldSearch: false, query: "", reason: "用户消息为空" };
  }

  const recent = input.recentMessages
    .slice(-6)
    .map((message) => `${message.role}: ${message.content.slice(0, 500)}`)
    .join("\n");
  const json = await callDeepSeekJson({
    userId: input.userId,
    operation: "reality_search_decision",
    model: "deepseek-v4-flash",
    temperature: 0,
    messages: [
      {
        role: "system",
        content: [
          "你只判断私人树洞聊天是否需要联网搜索，输出严格 JSON。",
          "需要搜索的情况：用户询问最新事实、新闻、政策、价格、天气、赛事结果、现实世界状态、具体网页/资料，或要求你查一下。",
          "不需要搜索的情况：日常倾诉、情绪陪伴、关系复盘、创作、常识解释、只需要当前时间/星期/节假日上下文即可回答的问题。",
          "不要因为用户说“今天我很累”“最近心情不好”“现在有点难受”就搜索。",
          "输出格式：{\"shouldSearch\":true|false,\"query\":\"用于搜索的简洁中文查询词\",\"reason\":\"一句话原因\"}",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `当前时间：${formatUtc8DateTime(input.now)}，${formatUtc8Weekday(input.now)}。`,
          `默认地区：${input.countryCode}。`,
          "近期对话：",
          recent || "无",
          "最新用户消息：",
          input.latestMessage,
        ].join("\n"),
      },
    ],
  });

  return normalizeSearchDecision(json, input.latestMessage);
}

async function getSearchContext(
  query: string,
  config: Awaited<ReturnType<typeof getRuntimeConfig>>,
  decision: SearchDecision,
) {
  const results = await searchWeb(query, config);

  if (results.length === 0) {
    if (!config.tavilyApiKey && !config.braveSearchApiKey) {
      return "联网检索：未配置 TAVILY_API_KEY 或 BRAVE_SEARCH_API_KEY。用户询问实时信息时，应说明当前无法联网确认。";
    }

    return `联网检索：LLM 判定需要搜索，但未获得可靠结果。判定原因：${decision.reason || "未说明"}。用户询问实时信息时，应说明检索结果不足。`;
  }

  return [
    `联网检索：LLM 判定需要搜索。判定原因：${decision.reason || "未说明"}。搜索词：${query}`,
    "联网检索结果：",
    ...results.slice(0, 5).map((result, index) => {
      const snippet = result.snippet ? ` - ${result.snippet}` : "";
      return `${index + 1}. ${result.title} (${result.url})${snippet}`;
    }),
  ].join("\n");
}

function normalizeSearchDecision(value: unknown, fallbackQuery: string): SearchDecision {
  if (!value || typeof value !== "object") {
    return { shouldSearch: false, query: "", reason: "搜索判定未返回有效 JSON" };
  }

  const record = value as Record<string, unknown>;
  const shouldSearch = record.shouldSearch === true;
  const query = typeof record.query === "string" ? record.query.trim().slice(0, 160) : "";
  const reason = typeof record.reason === "string" ? record.reason.trim().slice(0, 160) : "";

  return {
    shouldSearch,
    query: shouldSearch ? query || fallbackQuery.slice(0, 160) : "",
    reason,
  };
}

async function searchWeb(query: string, config: Awaited<ReturnType<typeof getRuntimeConfig>>) {
  if (config.tavilyApiKey) {
    const results = await searchTavily(query, config.tavilyApiKey);
    if (results.length > 0) return results;
  }

  if (config.braveSearchApiKey) {
    return searchBrave(query, config.braveSearchApiKey);
  }

  return [];
}

async function searchTavily(query: string, apiKey: string): Promise<SearchResult[]> {
  try {
    const response = await fetchWithTimeout(
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          search_depth: "basic",
          max_results: 5,
          include_answer: false,
        }),
      },
      7000,
    );

    if (!response.ok) return [];

    const data = (await response.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };

    return (data.results ?? [])
      .map((result) => ({
        title: clean(result.title),
        url: clean(result.url),
        snippet: clean(result.content),
      }))
      .filter((result) => result.title && result.url);
  } catch {
    return [];
  }
}

async function searchBrave(query: string, apiKey: string): Promise<SearchResult[]> {
  try {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", "5");
    url.searchParams.set("text_decorations", "false");

    const response = await fetchWithTimeout(
      url.toString(),
      {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
      },
      7000,
    );

    if (!response.ok) return [];

    const data = (await response.json()) as {
      web?: {
        results?: Array<{ title?: string; url?: string; description?: string }>;
      };
    };

    return (data.web?.results ?? [])
      .map((result) => ({
        title: clean(result.title),
        url: clean(result.url),
        snippet: clean(result.description),
      }))
      .filter((result) => result.title && result.url);
  } catch {
    return [];
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function formatHoliday(holiday: PublicHoliday) {
  const name = holiday.localName || holiday.name || "Holiday";
  return `${holiday.date} ${name}`;
}

function formatUtc8DateTime(date: Date) {
  const shifted = toUtc8Date(date);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

function formatUtc8Date(date: Date) {
  return formatUtc8DateTime(date).slice(0, 10);
}

function formatUtc8Weekday(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    weekday: "long",
  }).format(date);
}

function getUtc8Year(date: Date) {
  return Number(formatUtc8Date(date).slice(0, 4));
}

function toUtc8Date(date: Date) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000);
}

function normalizeCountryCode(value: string) {
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : "CN";
}

function clean(value: string | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
}
