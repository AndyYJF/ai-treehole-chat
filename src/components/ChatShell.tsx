"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  Brain,
  Check,
  ChevronDown,
  Download,
  Eye,
  FileText,
  Leaf,
  LogOut,
  MessageSquare,
  Moon,
  Network,
  PenLine,
  Plus,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import { tierOptions, type ModelTier } from "@/lib/model-routing";
import type { MemoryRecord, MemoryType } from "@/lib/memory/types";
import { type ThemePreference, useThemePreference } from "@/lib/theme";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type StoredChatMessage = Message & {
  threadId: string;
  createdAt: string;
};

type ImportedMemoryCandidate = {
  clientId: string;
  type: MemoryType;
  content: string;
  confidence: number;
  importance: number;
  sensitivity: "normal" | "sensitive" | "private";
  sourceMessageIds: string[];
  validFrom: string | null;
  validUntil: string | null;
};

type ImportAnalysisPayload = {
  sourceName: string;
  messageCount: number;
  analyzedChars: number;
  truncated: boolean;
  candidates: Array<Omit<ImportedMemoryCandidate, "clientId">>;
};

type ChatThread = {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
};

type ChatStreamEvent =
  | { type: "route"; routed: { label: string } }
  | { type: "reasoning" }
  | { type: "token"; delta: string }
  | {
      type: "done";
      routed: { label: string };
      activeThread: ChatThread;
      threads: ChatThread[];
      memories: MemoryRecord[];
      messages: StoredChatMessage[];
    }
  | { type: "error"; error: string };

type UsageSummary = {
  requestCount: number;
  successCount: number;
  failureCount: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  cacheHitRate: number | null;
  averageLatencyMs: number | null;
};

type UsagePayload = {
  summary: UsageSummary;
};

type LocalState = {
  tier: ModelTier;
  routeLabel: string;
  memoryEnabled: boolean;
  temperature: number;
  activeThreadId?: string;
};

const storageKey = "treehole-chat-state-v1";

function createClientId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function tierLabel(value: ModelTier) {
  return tierOptions.find((option) => option.value === value)?.label ?? "自动";
}

const initialMessages: Message[] = [
  {
    id: "hello",
    role: "assistant",
    content: "我在。你可以慢慢说。",
  },
];

const memoryTypeLabels: Record<MemoryType, string> = {
  semantic: "事实",
  episodic: "经历",
  procedural: "习惯",
  affect: "情绪",
  safety: "安全",
  preference: "偏好",
  boundary: "边界",
};

const sensitivityLabels: Record<ImportedMemoryCandidate["sensitivity"], string> = {
  normal: "普通",
  sensitive: "敏感",
  private: "私密",
};

const memoryTypeOrder = Object.keys(memoryTypeLabels) as MemoryType[];

const themeOptions: Array<{
  value: ThemePreference;
  label: string;
  icon: React.ReactNode;
}> = [
  { value: "system", label: "跟随", icon: <Sparkles size={14} /> },
  { value: "light", label: "浅色", icon: <Sun size={14} /> },
  { value: "dark", label: "深色", icon: <Moon size={14} /> },
];

export function ChatShell() {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [tier, setTier] = useState<ModelTier>("auto");
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingSeconds, setThinkingSeconds] = useState(0);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryView, setMemoryView] = useState<"list" | "graph">("list");
  const [memoryImportOpen, setMemoryImportOpen] = useState(false);
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [importSourceName, setImportSourceName] = useState("");
  const [importContent, setImportContent] = useState("");
  const [importCandidates, setImportCandidates] = useState<ImportedMemoryCandidate[]>([]);
  const [selectedImportCandidateIds, setSelectedImportCandidateIds] = useState<string[]>([]);
  const [importSummary, setImportSummary] = useState<ImportAnalysisPayload | null>(null);
  const [importError, setImportError] = useState("");
  const [isAnalyzingImport, setIsAnalyzingImport] = useState(false);
  const [isAddingImport, setIsAddingImport] = useState(false);
  const [memoryEnabled, setMemoryEnabledState] = useState(true);
  const [temperature, setTemperature] = useState(0.72);
  const [routeLabel, setRouteLabel] = useState("自动");
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState("");
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThread, setActiveThread] = useState<ChatThread | null>(null);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const thinkingTimerRef = useRef<number | null>(null);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const { preference, setPreference } = useThemePreference();

  useEffect(() => {
    queueMicrotask(() => {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Partial<LocalState>;
          const restoredTier = parsed.tier ?? "auto";
          setTier(restoredTier);
          setRouteLabel(restoredTier === "auto" ? (parsed.routeLabel ?? "自动") : tierLabel(restoredTier));
          if (typeof parsed.memoryEnabled === "boolean") setMemoryEnabledState(parsed.memoryEnabled);
          if (typeof parsed.temperature === "number") setTemperature(parsed.temperature);
          if (parsed.activeThreadId) {
            void refreshThreadState(parsed.activeThreadId);
          } else {
            void refreshThreadState();
          }
        } catch {
          window.localStorage.removeItem(storageKey);
          void refreshThreadState();
        }
      } else {
        void refreshThreadState();
      }

      setLoaded(true);
      void refreshMemories();
      void refreshUsage();
    });
  }, []);

  useEffect(() => {
    if (!loaded) return;

    const state: LocalState = {
      tier,
      routeLabel,
      memoryEnabled,
      temperature,
      activeThreadId: activeThread?.id,
    };

    window.localStorage.setItem(storageKey, JSON.stringify(state));
  }, [activeThread?.id, loaded, memoryEnabled, routeLabel, temperature, tier]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isThinking]);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current != null) {
        window.clearTimeout(noticeTimerRef.current);
      }
      stopThinkingTimer();
    };
  }, []);

  const resizeTextarea = useCallback(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  }, []);

  const recentMessages = useMemo(
    () =>
      messages
        .filter((message) => message.id !== "hello")
        .slice(-10)
        .map((message) => ({ role: message.role, content: message.content })),
    [messages],
  );

  const isFreshThread = messages.length === 1 && messages[0]?.id === "hello";

  function showNotice(message: string) {
    setNotice(message);

    if (noticeTimerRef.current != null) {
      window.clearTimeout(noticeTimerRef.current);
    }

    noticeTimerRef.current = window.setTimeout(() => {
      setNotice("");
      noticeTimerRef.current = null;
    }, 2200);
  }

  function startThinkingTimer() {
    stopThinkingTimer();
    const startedAt = Date.now();
    setThinkingSeconds(0);

    thinkingTimerRef.current = window.setInterval(() => {
      setThinkingSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);
  }

  function stopThinkingTimer() {
    if (thinkingTimerRef.current == null) return;

    window.clearInterval(thinkingTimerRef.current);
    thinkingTimerRef.current = null;
  }

  async function refreshMemories() {
    const response = await fetch("/api/memories");
    if (!response.ok) return;

    const data = (await response.json()) as {
      memories: MemoryRecord[];
      settings: { enabled: boolean };
    };

    setMemories(data.memories);
    setMemoryEnabledState(data.settings.enabled);
  }

  async function refreshThreadState(threadId?: string) {
    const query = threadId ? `?threadId=${encodeURIComponent(threadId)}` : "";
    const response = await fetch(`/api/threads${query}`);
    if (!response.ok) return;

    const data = (await response.json()) as {
      activeThread: ChatThread;
      threads: ChatThread[];
      messages: StoredChatMessage[];
    };

    setThreads(data.threads);
    setActiveThread(data.activeThread);
    setMessages(toDisplayMessages(data.messages));
  }

  async function refreshUsage() {
    const response = await fetch("/api/usage");
    if (!response.ok) return;

    const data = (await response.json()) as UsagePayload;
    setUsage(data.summary);
  }

  async function deleteMemory(memoryId: string) {
    const response = await fetch("/api/memories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", memoryId }),
    });

    if (!response.ok) return;
    const data = (await response.json()) as { memories: MemoryRecord[] };
    setMemories(data.memories);
    setSelectedMemoryId((current) => (current === memoryId ? null : current));
  }

  async function updateMemory(
    memoryId: string,
    update: Pick<MemoryRecord, "type" | "content" | "importance" | "sensitivity">,
  ) {
    const response = await fetch("/api/memories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update",
        memoryId,
        ...update,
      }),
    });

    if (!response.ok) {
      showNotice("记忆没有保存成功。");
      return;
    }

    const data = (await response.json()) as {
      memories: MemoryRecord[];
      settings: { enabled: boolean };
    };
    setMemories(data.memories);
    setMemoryEnabledState(data.settings.enabled);
    showNotice("记忆已更新。");
  }

  async function clearAllMemories() {
    if (!window.confirm("清空所有记忆？")) return;

    const response = await fetch("/api/memories", { method: "DELETE" });
    if (!response.ok) return;

    const data = (await response.json()) as {
      memories: MemoryRecord[];
      settings: { enabled: boolean };
    };

    setMemories(data.memories);
    setMemoryEnabledState(data.settings.enabled);
  }

  function resetMemoryImport() {
    setImportSourceName("");
    setImportContent("");
    setImportCandidates([]);
    setSelectedImportCandidateIds([]);
    setImportSummary(null);
    setImportError("");
  }

  async function readImportFile(file: File | undefined) {
    if (!file) return;

    try {
      const text = await file.text();
      setImportContent(text);
      if (!importSourceName.trim()) setImportSourceName(file.name);
      setImportCandidates([]);
      setSelectedImportCandidateIds([]);
      setImportSummary(null);
      setImportError("");
    } catch {
      setImportError("文件没有读出来，换一个文件试试。");
    }
  }

  async function analyzeMemoryImport() {
    const content = importContent.trim();
    if (content.length < 20 || isAnalyzingImport) return;

    setIsAnalyzingImport(true);
    setImportError("");
    setImportCandidates([]);
    setSelectedImportCandidateIds([]);
    setImportSummary(null);

    try {
      const response = await fetch("/api/memories/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "analyze",
          sourceName: importSourceName,
          content,
        }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "导入分析失败");
      }

      const data = (await response.json()) as ImportAnalysisPayload;
      const candidates = data.candidates.map((candidate, index) => ({
        ...candidate,
        clientId: `import-${Date.now()}-${index}`,
      }));

      setImportSummary(data);
      setImportCandidates(candidates);
      setSelectedImportCandidateIds(candidates.map((candidate) => candidate.clientId));

      if (candidates.length === 0) {
        showNotice("没有分析出可添加的长期记忆。");
      }
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "导入分析失败");
    } finally {
      setIsAnalyzingImport(false);
    }
  }

  async function addImportedMemories() {
    const selected = importCandidates.filter((candidate) =>
      selectedImportCandidateIds.includes(candidate.clientId),
    );

    if (selected.length === 0 || isAddingImport) return;

    setIsAddingImport(true);
    setImportError("");

    try {
      const response = await fetch("/api/memories/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add",
          candidates: selected.map((candidate) => ({
            type: candidate.type,
            content: candidate.content,
            confidence: candidate.confidence,
            importance: candidate.importance,
            sensitivity: candidate.sensitivity,
            sourceMessageIds: candidate.sourceMessageIds,
            validFrom: candidate.validFrom,
            validUntil: candidate.validUntil,
          })),
        }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "记忆没有添加成功");
      }

      const data = (await response.json()) as {
        memories: MemoryRecord[];
        settings: { enabled: boolean };
      };

      setMemories(data.memories);
      setMemoryEnabledState(data.settings.enabled);
      setMemoryImportOpen(false);
      resetMemoryImport();
      showNotice(`已添加 ${selected.length} 条记忆。`);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "记忆没有添加成功");
    } finally {
      setIsAddingImport(false);
    }
  }

  function toggleImportedMemory(candidateId: string) {
    setSelectedImportCandidateIds((current) =>
      current.includes(candidateId)
        ? current.filter((id) => id !== candidateId)
        : [...current, candidateId],
    );
  }

  async function exportData() {
    const response = await fetch("/api/export");
    if (!response.ok) return;

    const data = await response.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `treehole-export-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function clearUsage() {
    if (!window.confirm("清空用量记录？")) return;

    const response = await fetch("/api/usage", { method: "DELETE" });
    if (!response.ok) return;

    const data = (await response.json()) as UsagePayload;
    setUsage(data.summary);
  }

  async function clearAllData() {
    if (!window.confirm("清空对话、记忆和用量记录？这个操作不能撤销。")) return;

    const response = await fetch("/api/data", { method: "DELETE" });
    if (!response.ok) return;

    const data = (await response.json()) as {
      activeThread: ChatThread;
      threads: ChatThread[];
      memories: MemoryRecord[];
      settings: { enabled: boolean };
      usage: UsageSummary;
    };

    window.localStorage.removeItem(storageKey);
    setActiveThread(data.activeThread);
    setThreads(data.threads);
    setMessages(initialMessages);
    setMemories(data.memories);
    setMemoryEnabledState(data.settings.enabled);
    setUsage(data.usage);
    setTier("auto");
    setRouteLabel("自动");
    setTemperature(0.72);
    setInput("");
  }

  async function logout() {
    await fetch("/api/session", { method: "DELETE" });
    window.location.href = "/login";
  }

  async function setMemoryEnabled(enabled: boolean) {
    setMemoryEnabledState(enabled);

    const response = await fetch("/api/memories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setEnabled", enabled }),
    });

    if (!response.ok) return;
    const data = (await response.json()) as {
      memories: MemoryRecord[];
      settings: { enabled: boolean };
    };
    setMemories(data.memories);
    setMemoryEnabledState(data.settings.enabled);
  }

  async function createNewThread() {
    if (isThinking) {
      showNotice("正在回复，稍等一下。");
      return;
    }

    if (isFreshThread) {
      showNotice("当前时间线还是空的。");
      return;
    }

    const response = await fetch("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      showNotice("没有建好，再试一次。");
      return;
    }

    const data = (await response.json()) as {
      activeThread: ChatThread;
      threads: ChatThread[];
      messages: StoredChatMessage[];
    };

    setActiveThread(data.activeThread);
    setThreads(data.threads);
    setMessages(toDisplayMessages(data.messages));
    setRouteLabel("自动");
    setInput("");
    setTimelineOpen(false);
    showNotice("已开启新时间线。");
  }

  async function deleteThread(threadId: string) {
    if (isThinking) {
      showNotice("正在回复，稍等一下。");
      return;
    }

    if (!window.confirm("删除这条时间线？长期记忆会保留。")) {
      return;
    }

    const response = await fetch(`/api/threads?threadId=${encodeURIComponent(threadId)}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      showNotice("没有删掉，再试一次。");
      return;
    }

    const data = (await response.json()) as {
      activeThread: ChatThread;
      threads: ChatThread[];
      messages: StoredChatMessage[];
    };

    setActiveThread(data.activeThread);
    setThreads(data.threads);
    setMessages(toDisplayMessages(data.messages));
    setTimelineOpen(false);
    setRouteLabel("自动");
    showNotice("已删除时间线。");
  }

  async function switchThread(threadId: string) {
    if (isThinking) {
      showNotice("正在回复，稍等一下。");
      return;
    }

    await refreshThreadState(threadId);
    setTimelineOpen(false);
  }

  async function clearCurrentContext() {
    if (isThinking) {
      showNotice("正在回复，稍等一下。");
      return;
    }

    if (isFreshThread && !input.trim()) {
      showNotice("当前时间线是空的。");
      return;
    }

    if (!window.confirm("清空当前时间线的上下文？长期记忆会保留。")) {
      return;
    }

    const threadId = activeThread?.id;
    const query = threadId ? `?threadId=${encodeURIComponent(threadId)}` : "";
    const response = await fetch(`/api/messages${query}`, { method: "DELETE" });

    if (!response.ok) {
      showNotice("没有清掉，再试一次。");
      void refreshThreadState(threadId);
      return;
    }

    const data = (await response.json()) as {
      activeThread: ChatThread;
      threads: ChatThread[];
      messages: StoredChatMessage[];
    };

    setActiveThread(data.activeThread);
    setThreads(data.threads);
    setMessages(toDisplayMessages(data.messages));
    setRouteLabel("自动");
    setInput("");
    showNotice("已清空当前上下文。");
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = input.trim();
    if (!content || isThinking) return;

    const userMessage: Message = {
      id: createClientId(),
      role: "user",
      content,
    };
    const assistantMessage: Message = {
      id: createClientId(),
      role: "assistant",
      content: "",
    };

    setMessages((current) => [
      ...current.filter((message) => message.id !== "hello"),
      userMessage,
      assistantMessage,
    ]);
    setInput("");
    setIsThinking(true);
    startThinkingTimer();
    requestAnimationFrame(resizeTextarea);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: activeThread?.id,
          message: content,
          tier,
          memoryEnabled,
          temperature,
          stream: true,
          recentMessages,
        }),
      });

      if (!response.ok) throw new Error("request failed");

      await readChatStream(response, {
        onRoute: (label) => setRouteLabel(label),
        onReasoning: () => setIsThinking(true),
        onToken: (delta) => {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessage.id
                ? {
                    ...message,
                    content: message.content + delta,
                  }
                : message,
            ),
          );
        },
        onDone: (data) => {
          setRouteLabel(data.routed.label);
          setActiveThread(data.activeThread);
          setThreads(data.threads);
          setMemories(data.memories);
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessage.id && message.content.trim().length === 0
                ? {
                    ...message,
                    content: latestAssistantContent(data.messages) ?? "我在。你可以慢慢说。",
                  }
                : message,
            ),
          );
          void refreshUsage();
        },
      });
    } catch {
      setMessages((current) => [
        ...current.filter((message) => message.id !== assistantMessage.id),
        {
          id: createClientId(),
          role: "assistant",
          content: "刚刚连接不太顺。你说的我先接住，我们可以再试一次。",
        },
      ]);
    } finally {
      stopThinkingTimer();
      setIsThinking(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col text-ink">
      {notice ? (
        <div
          className="fixed left-1/2 top-[76px] z-[70] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-full border border-line bg-card px-4 py-2 text-sm text-ink-soft shadow-[0_10px_30px_rgba(63,58,38,0.16)]"
          role="status"
          aria-live="polite"
        >
          {notice}
        </div>
      ) : null}

      <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 sm:px-6">
        <header className="sticky top-0 z-30 -mx-4 flex h-16 items-center justify-between gap-3 bg-paper/85 px-4 backdrop-blur-md sm:-mx-6 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-pine text-card shadow-[0_2px_10px_rgba(34,57,42,0.35)]">
              <Leaf size={17} strokeWidth={1.8} />
            </span>
            <div className="min-w-0 leading-tight">
              <p className="font-display text-[17px] tracking-wide">树洞</p>
              <p className="flex items-center gap-1 truncate text-xs text-ink-faint">
                <Sparkles size={11} className="shrink-0" />
                <span className="truncate">{routeLabel}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <IconButton
              label="时间线"
              onClick={() => {
                setTimelineOpen(true);
                void refreshThreadState(activeThread?.id);
              }}
            >
              <PenLine size={17} strokeWidth={1.8} />
            </IconButton>
            <IconButton
              label="记忆"
              onClick={() => {
                setMemoryOpen(true);
                void refreshMemories();
              }}
            >
              <Brain size={17} strokeWidth={1.8} />
            </IconButton>
            <IconButton
              label="设置"
              onClick={() => {
                setSettingsOpen(true);
                void refreshUsage();
              }}
            >
              <Settings size={17} strokeWidth={1.8} />
            </IconButton>
          </div>
        </header>

        <section
          className={`flex flex-1 flex-col gap-4 py-6 ${isFreshThread ? "justify-center" : "justify-end"}`}
        >
          {isFreshThread ? (
            <div className="animate-rise flex flex-col items-center gap-5 pb-16 text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-full border border-line bg-card text-pine shadow-[0_10px_36px_rgba(34,57,42,0.12)]">
                <Leaf size={26} strokeWidth={1.5} />
              </span>
              <div className="space-y-2">
                <p className="font-display text-2xl tracking-wide text-pine-deep">
                  我在。你可以慢慢说。
                </p>
                <p className="text-sm text-ink-faint">
                  说出来的话，落进树洞里，只有我们知道。
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((message) =>
                message.content ? (
                  <article
                    key={message.id}
                    className={`animate-rise flex ${
                      message.role === "user" ? "justify-end" : "justify-start"
                    }`}
                  >
                    <p
                      className={`max-w-[85%] whitespace-pre-wrap px-4.5 py-3 text-[15px] leading-7 sm:max-w-[72%] ${
                        message.role === "user"
                          ? "rounded-3xl rounded-br-lg bg-pine text-[#f4f7ee] shadow-[0_6px_20px_rgba(34,57,42,0.22)]"
                          : "rounded-3xl rounded-bl-lg border border-line bg-card text-ink shadow-[0_2px_12px_rgba(63,58,38,0.06)]"
                      }`}
                    >
                      {message.content}
                    </p>
                  </article>
                ) : null,
              )}

              {isThinking && messages[messages.length - 1]?.content === "" ? (
                <div className="animate-rise flex justify-start">
                  <div className="flex items-center gap-2.5 rounded-3xl rounded-bl-lg border border-line bg-card px-4.5 py-3.5 shadow-[0_2px_12px_rgba(63,58,38,0.06)]">
                    <span className="flex items-center gap-1" aria-hidden>
                      <span className="animate-breathe h-1.5 w-1.5 rounded-full bg-pine" />
                      <span className="animate-breathe h-1.5 w-1.5 rounded-full bg-pine [animation-delay:0.2s]" />
                      <span className="animate-breathe h-1.5 w-1.5 rounded-full bg-pine [animation-delay:0.4s]" />
                    </span>
                    <span className="text-sm text-ink-faint">
                      思考中（{thinkingSeconds}秒）
                    </span>
                  </div>
                </div>
              ) : null}
              <div ref={bottomRef} />
            </div>
          )}
        </section>

        <div className="sticky bottom-0 -mx-4 bg-gradient-to-t from-paper via-paper/95 to-transparent px-4 pb-4 pt-2 sm:-mx-6 sm:px-6">
          <form
            onSubmit={sendMessage}
            className="flex items-end gap-2 rounded-[26px] border border-line bg-card p-2 shadow-[0_14px_44px_rgba(63,58,38,0.14)] transition focus-within:border-line-strong"
          >
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                resizeTextarea();
              }}
              rows={1}
              placeholder="写给我……"
              aria-label="写给我"
              className="max-h-40 min-h-11 flex-1 resize-none bg-transparent px-3 py-2.5 text-[15px] leading-6 text-ink outline-none placeholder:text-ink-faint"
            />
            <button
              type="submit"
              disabled={!input.trim() || isThinking}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-pine text-card shadow-[0_4px_14px_rgba(34,57,42,0.3)] transition hover:bg-pine-deep active:scale-95 disabled:cursor-not-allowed disabled:bg-line-strong disabled:shadow-none"
              aria-label="发送"
            >
              <Send size={17} strokeWidth={1.8} />
            </button>
          </form>
          <p className="mt-2 text-center text-[11px] text-ink-faint">
            这里只有你和树洞，数据随时可以导出或清空。
          </p>
        </div>
      </div>

      <SidePanel open={timelineOpen} onClose={() => setTimelineOpen(false)} title="时间线">
        <div className="space-y-4">
          <section className="space-y-2">
            <button
              type="button"
              onClick={() => void createNewThread()}
              className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-card px-3.5 py-2.5 text-sm text-ink-soft transition hover:border-line-strong hover:bg-mist/50"
            >
              <Plus size={15} className="text-pine" />
              新时间线
            </button>
            <button
              type="button"
              onClick={() => void clearCurrentContext()}
              className="flex w-full items-center gap-2.5 rounded-xl border border-clay/30 bg-card px-3.5 py-2.5 text-sm text-clay transition hover:bg-clay-soft"
            >
              <Trash2 size={15} />
              清空当前上下文
            </button>
          </section>

          <section className="space-y-2">
            <PanelLabel>历史</PanelLabel>
            {threads.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-12 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-mist text-ink-faint">
                  <MessageSquare size={20} strokeWidth={1.5} />
                </span>
                <p className="text-sm text-ink-faint">还没有历史时间线。</p>
              </div>
            ) : (
              <div className="space-y-2">
                {threads.map((thread) => {
                  const active = thread.id === activeThread?.id;

                  return (
                    <div
                      key={thread.id}
                      className={`w-full rounded-2xl border px-3.5 py-3 text-left transition ${
                        active
                          ? "border-pine bg-moss text-pine-deep"
                          : "border-line bg-card text-ink-soft hover:border-line-strong hover:bg-mist/50"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void switchThread(thread.id)}
                          aria-pressed={active}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="block truncate text-sm font-medium">{thread.title}</span>
                          <span className="mt-1 block text-xs text-ink-faint">
                            {thread.messageCount} 条
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteThread(thread.id)}
                          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-clay transition hover:bg-clay-soft"
                          aria-label="删除时间线"
                          title="删除时间线"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </SidePanel>

      <SidePanel open={settingsOpen} onClose={() => setSettingsOpen(false)} title="设置">
        <div className="space-y-6">
          <section className="space-y-3">
            <PanelLabel>回复挡位</PanelLabel>
            <div className="grid grid-cols-2 gap-2">
              {tierOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    setTier(option.value);
                    setRouteLabel(tierLabel(option.value));
                  }}
                  aria-pressed={tier === option.value}
                  className={`rounded-2xl border px-3.5 py-3 text-left transition ${
                    tier === option.value
                      ? "border-pine bg-moss text-pine-deep shadow-[0_2px_10px_rgba(34,57,42,0.12)]"
                      : "border-line bg-card text-ink-soft hover:border-line-strong"
                  }`}
                >
                  <span className="block text-sm font-medium">{option.label}</span>
                  <span className="mt-1 block text-xs text-ink-faint">{option.hint}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-line bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <ShieldCheck size={16} className="text-pine" />
                <div>
                  <p className="text-sm text-ink">长期记忆</p>
                  <p className="text-xs text-ink-faint">
                    {memoryEnabled ? "会记住重要的事" : "只陪你聊，不做记录"}
                  </p>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={memoryEnabled}
                onClick={() => void setMemoryEnabled(!memoryEnabled)}
                className={`h-7 w-12 shrink-0 rounded-full p-1 transition ${
                  memoryEnabled ? "bg-pine" : "bg-line-strong"
                }`}
                aria-label="切换记忆"
              >
                <span
                  className={`block h-5 w-5 rounded-full bg-card shadow transition ${
                    memoryEnabled ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          </section>

          <section className="rounded-2xl border border-line bg-card p-4">
            <PanelLabel>外观</PanelLabel>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {themeOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setPreference(option.value)}
                  aria-pressed={preference === option.value}
                  className={`inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl border px-2.5 text-xs transition ${
                    preference === option.value
                      ? "border-pine bg-moss text-pine-deep"
                      : "border-line bg-card text-ink-soft hover:border-line-strong hover:bg-mist/50"
                  }`}
                >
                  {option.icon}
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl border border-line bg-card">
            <button
              type="button"
              onClick={() => setAdvancedOpen((current) => !current)}
              aria-expanded={advancedOpen}
              className="flex w-full items-center justify-between px-4 py-3.5 text-sm text-ink-soft transition hover:bg-mist/50"
            >
              <span className="inline-flex items-center gap-2.5">
                <SlidersHorizontal size={16} className="text-pine" />
                高级
              </span>
              <ChevronDown
                size={16}
                className={`text-ink-faint transition-transform ${advancedOpen ? "rotate-180" : ""}`}
              />
            </button>
            {advancedOpen ? (
              <div className="border-t border-line px-4 py-4">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-ink-faint" htmlFor="temperature">
                    温度
                  </label>
                  <span className="rounded-full bg-mist px-2 py-0.5 font-mono text-xs text-ink-soft">
                    {temperature.toFixed(2)}
                  </span>
                </div>
                <input
                  id="temperature"
                  type="range"
                  min="0"
                  max="1.2"
                  step="0.01"
                  value={temperature}
                  onChange={(event) => setTemperature(Number(event.target.value))}
                  className="mt-4 w-full"
                />
                <div className="mt-1.5 flex justify-between text-[11px] text-ink-faint">
                  <span>更稳妥</span>
                  <span>更松弛</span>
                </div>
              </div>
            ) : null}
          </section>

          <section className="rounded-2xl border border-line bg-card p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 text-sm text-ink">
                <Activity size={16} className="text-pine" />
                <span>用量</span>
              </div>
              <button
                type="button"
                onClick={() => void clearUsage()}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-clay transition hover:bg-clay-soft"
                aria-label="清空用量"
                title="清空用量"
              >
                <Trash2 size={15} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <UsageMetric label="请求" value={formatCompact(usage?.requestCount)} />
              <UsageMetric label="Token" value={formatCompact(usage?.totalTokens)} />
              <UsageMetric label="缓存命中" value={formatPercent(usage?.cacheHitRate)} />
              <UsageMetric label="平均延迟" value={formatLatency(usage?.averageLatencyMs)} />
            </div>
          </section>

          <section className="rounded-2xl border border-line bg-card p-4">
            <PanelLabel>数据</PanelLabel>
            <div className="mt-3 space-y-2">
              <button
                type="button"
                onClick={() => void exportData()}
                className="flex w-full items-center gap-2.5 rounded-xl border border-line px-3.5 py-2.5 text-sm text-ink-soft transition hover:border-line-strong hover:bg-mist/50"
              >
                <Download size={15} className="text-pine" />
                导出全部数据
              </button>
              <button
                type="button"
                onClick={() => void clearAllData()}
                className="flex w-full items-center gap-2.5 rounded-xl border border-clay/30 px-3.5 py-2.5 text-sm text-clay transition hover:bg-clay-soft"
              >
                <Trash2 size={15} />
                清空全部数据
              </button>
              <button
                type="button"
                onClick={() => void logout()}
                className="flex w-full items-center gap-2.5 rounded-xl border border-line px-3.5 py-2.5 text-sm text-ink-soft transition hover:border-line-strong hover:bg-mist/50"
              >
                <LogOut size={15} className="text-clay" />
                退出树洞
              </button>
            </div>
          </section>
        </div>
      </SidePanel>

      <SidePanel open={memoryOpen} onClose={() => setMemoryOpen(false)} title="记忆">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-ink-faint">共 {memories.length} 条</p>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setMemoryImportOpen((current) => !current)}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition ${
                  memoryImportOpen ? "bg-moss text-pine-deep" : "text-ink-faint hover:bg-mist hover:text-pine"
                }`}
                aria-label="导入对话"
                title="导入对话"
              >
                <Upload size={14} />
              </button>
              {memories.length > 0 ? (
                <>
                  <ViewToggle
                    value={memoryView}
                    onChange={(next) => {
                      setMemoryView(next);
                      if (next === "list") setSelectedMemoryId(null);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => void clearAllMemories()}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full text-clay transition hover:bg-clay-soft"
                    aria-label="清空记忆"
                    title="清空记忆"
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              ) : null}
            </div>
          </div>

          {memoryImportOpen ? (
            <div className="animate-rise space-y-3 rounded-2xl border border-line bg-card p-4 shadow-[0_2px_10px_rgba(63,58,38,0.05)]">
              <input
                ref={importFileInputRef}
                type="file"
                accept=".json,.txt,.md,.csv"
                className="hidden"
                onChange={(event) => {
                  void readImportFile(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              <div className="flex items-center gap-2">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-mist text-pine">
                  <FileText size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">导入外部对话</p>
                  <p className="truncate text-xs text-ink-faint">
                    JSON、TXT、Markdown
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => importFileInputRef.current?.click()}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-faint transition hover:bg-mist hover:text-pine"
                  aria-label="选择文件"
                  title="选择文件"
                >
                  <Upload size={14} />
                </button>
              </div>

              <input
                value={importSourceName}
                onChange={(event) => setImportSourceName(event.target.value)}
                placeholder="来源名称"
                className="h-10 w-full rounded-xl border border-line bg-paper px-3 text-sm text-ink outline-none transition placeholder:text-ink-faint focus:border-line-strong"
              />
              <textarea
                value={importContent}
                onChange={(event) => {
                  setImportContent(event.target.value);
                  setImportCandidates([]);
                  setSelectedImportCandidateIds([]);
                  setImportSummary(null);
                  setImportError("");
                }}
                rows={7}
                placeholder="粘贴外部聊天记录"
                className="min-h-36 w-full resize-y rounded-xl border border-line bg-paper px-3 py-2.5 text-sm leading-6 text-ink outline-none transition placeholder:text-ink-faint focus:border-line-strong"
              />

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void analyzeMemoryImport()}
                  disabled={importContent.trim().length < 20 || isAnalyzingImport}
                  className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-pine px-3 text-sm text-card transition hover:bg-pine-deep disabled:cursor-not-allowed disabled:bg-line-strong"
                >
                  <Brain size={15} />
                  {isAnalyzingImport ? "分析中" : "分析记忆"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    resetMemoryImport();
                    setMemoryImportOpen(false);
                  }}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-line text-ink-faint transition hover:bg-mist hover:text-ink"
                  aria-label="取消导入"
                  title="取消导入"
                >
                  <X size={15} />
                </button>
              </div>

              {importError ? (
                <p className="rounded-xl bg-clay-soft px-3 py-2 text-xs leading-5 text-clay">
                  {importError}
                </p>
              ) : null}

              {importSummary ? (
                <div className="flex flex-wrap gap-1.5 text-[11px] text-ink-faint">
                  <span className="rounded-full bg-mist px-2 py-0.5">
                    {importSummary.messageCount || "未知"} 条消息
                  </span>
                  <span className="rounded-full bg-mist px-2 py-0.5">
                    {formatCompact(importSummary.analyzedChars)} 字符
                  </span>
                  {importSummary.truncated ? (
                    <span className="rounded-full bg-clay-soft px-2 py-0.5 text-clay">
                      已截断
                    </span>
                  ) : null}
                </div>
              ) : null}

              {importCandidates.length > 0 ? (
                <div className="space-y-2">
                  {importCandidates.map((candidate) => {
                    const checked = selectedImportCandidateIds.includes(candidate.clientId);

                    return (
                      <label
                        key={candidate.clientId}
                        className={`block cursor-pointer rounded-xl border p-3 transition ${
                          checked ? "border-pine bg-moss/70" : "border-line bg-paper hover:border-line-strong"
                        }`}
                      >
                        <span className="flex items-start gap-2.5">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleImportedMemory(candidate.clientId)}
                            className="mt-1 h-4 w-4 accent-pine"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm leading-6 text-ink">
                              {candidate.content}
                            </span>
                            <span className="mt-2 flex flex-wrap gap-1.5">
                              <span className="rounded-full bg-card px-2 py-0.5 text-[11px] text-pine-deep">
                                {memoryTypeLabels[candidate.type]}
                              </span>
                              <span className="rounded-full bg-card px-2 py-0.5 text-[11px] text-ink-faint">
                                {candidate.importance}
                              </span>
                            </span>
                          </span>
                        </span>
                      </label>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => void addImportedMemories()}
                    disabled={selectedImportCandidateIds.length === 0 || isAddingImport}
                    className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-pine px-3 text-sm text-card transition hover:bg-pine-deep disabled:cursor-not-allowed disabled:bg-line-strong"
                  >
                    <Check size={15} />
                    {isAddingImport ? "添加中" : `添加选中的 ${selectedImportCandidateIds.length} 条`}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {memories.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-14 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-mist text-ink-faint">
                <Brain size={20} strokeWidth={1.5} />
              </span>
              <p className="text-sm leading-6 text-ink-faint">
                还没有新的记忆。
                <br />
                聊着聊着，重要的事会自己留下来。
              </p>
            </div>
          ) : (
            <>
              {memoryView === "graph" ? (
                <MemoryGraph
                  memories={memories}
                  selectedMemoryId={selectedMemoryId}
                  onSelectMemory={setSelectedMemoryId}
                  onUpdateMemory={(memoryId, update) => void updateMemory(memoryId, update)}
                  onDeleteMemory={(memoryId) => void deleteMemory(memoryId)}
                />
              ) : (
                memories.map((memory) => (
                  <MemoryCard
                    key={memory.id}
                    memory={memory}
                    onUpdate={(update) => void updateMemory(memory.id, update)}
                    onDelete={() => void deleteMemory(memory.id)}
                  />
                ))
              )}
            </>
          )}
        </div>
      </SidePanel>
    </main>
  );
}

function ViewToggle({
  value,
  onChange,
}: {
  value: "list" | "graph";
  onChange: (value: "list" | "graph") => void;
}) {
  return (
    <div className="inline-grid h-8 grid-cols-2 rounded-full border border-line bg-card p-0.5">
      <button
        type="button"
        onClick={() => onChange("list")}
        aria-pressed={value === "list"}
        className={`inline-flex h-7 w-8 items-center justify-center rounded-full transition ${
          value === "list" ? "bg-moss text-pine-deep" : "text-ink-faint hover:text-pine"
        }`}
        title="列表"
        aria-label="列表"
      >
        <Eye size={13} />
      </button>
      <button
        type="button"
        onClick={() => onChange("graph")}
        aria-pressed={value === "graph"}
        className={`inline-flex h-7 w-8 items-center justify-center rounded-full transition ${
          value === "graph" ? "bg-moss text-pine-deep" : "text-ink-faint hover:text-pine"
        }`}
        title="图谱"
        aria-label="图谱"
      >
        <Network size={13} />
      </button>
    </div>
  );
}

function MemoryCard({
  memory,
  onUpdate,
  onDelete,
}: {
  memory: MemoryRecord;
  onUpdate: (update: Pick<MemoryRecord, "type" | "content" | "importance" | "sensitivity">) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(memory.content);
  const [type, setType] = useState<MemoryType>(memory.type);
  const [importance, setImportance] = useState(memory.importance);
  const [sensitivity, setSensitivity] = useState<MemoryRecord["sensitivity"]>(memory.sensitivity);

  function startEdit() {
    setContent(memory.content);
    setType(memory.type);
    setImportance(memory.importance);
    setSensitivity(memory.sensitivity);
    setEditing(true);
  }

  function cancelEdit() {
    setContent(memory.content);
    setType(memory.type);
    setImportance(memory.importance);
    setSensitivity(memory.sensitivity);
    setEditing(false);
  }

  function saveEdit() {
    const nextContent = content.trim();
    if (nextContent.length < 4) return;

    onUpdate({
      type,
      content: nextContent,
      importance,
      sensitivity,
    });
    setEditing(false);
  }

  return (
    <div className="animate-rise rounded-2xl border border-line bg-card p-4 shadow-[0_2px_10px_rgba(63,58,38,0.05)]">
      {editing ? (
        <div className="space-y-3">
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={3}
            className="min-h-24 w-full resize-y rounded-xl border border-line bg-paper px-3 py-2.5 text-sm leading-6 text-ink outline-none transition focus:border-line-strong"
          />
          <div className="grid grid-cols-2 gap-2">
            <select
              value={type}
              onChange={(event) => setType(event.target.value as MemoryType)}
              className="h-10 rounded-xl border border-line bg-paper px-3 text-sm text-ink outline-none focus:border-line-strong"
            >
              {memoryTypeOrder.map((option) => (
                <option key={option} value={option}>
                  {memoryTypeLabels[option]}
                </option>
              ))}
            </select>
            <select
              value={sensitivity}
              onChange={(event) => setSensitivity(event.target.value as MemoryRecord["sensitivity"])}
              className="h-10 rounded-xl border border-line bg-paper px-3 text-sm text-ink outline-none focus:border-line-strong"
            >
              {Object.entries(sensitivityLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="flex items-center justify-between text-xs text-ink-faint">
              <span>重要度</span>
              <span className="font-mono">{importance}</span>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={importance}
              onChange={(event) => setImportance(Number(event.target.value))}
              className="mt-2 w-full"
            />
          </div>
          <div className="flex justify-end gap-1">
            <button
              type="button"
              onClick={cancelEdit}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-faint transition hover:bg-mist hover:text-ink"
              aria-label="取消编辑"
              title="取消编辑"
            >
              <X size={15} />
            </button>
            <button
              type="button"
              onClick={saveEdit}
              disabled={content.trim().length < 4}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-pine transition hover:bg-moss disabled:cursor-not-allowed disabled:text-ink-faint"
              aria-label="保存记忆"
              title="保存记忆"
            >
              <Check size={15} />
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-sm leading-6 text-ink">{memory.content}</p>
          <MemoryMeta memory={memory} />
          <MemoryActions onEdit={startEdit} onDelete={onDelete} />
        </>
      )}
    </div>
  );
}

function MemoryMeta({ memory }: { memory: MemoryRecord }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <span className="rounded-full bg-moss px-2 py-0.5 text-[11px] text-pine-deep">
        {memoryTypeLabels[memory.type]}
      </span>
      <span className="rounded-full bg-mist px-2 py-0.5 text-[11px] text-ink-faint">
        {memory.importance}
      </span>
      <span className="rounded-full bg-mist px-2 py-0.5 text-[11px] text-ink-faint">
        {formatMemoryDate(memory.createdAt)}
      </span>
    </div>
  );
}

function MemoryActions({
  onEdit,
  onDelete,
}: {
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="mt-3 flex items-center justify-end gap-1">
      <button
        type="button"
        onClick={onEdit}
        className="inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-faint transition hover:bg-mist hover:text-pine"
        aria-label="编辑记忆"
        title="编辑记忆"
      >
        <PenLine size={15} />
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="inline-flex h-8 w-8 items-center justify-center rounded-full text-clay transition hover:bg-clay-soft"
        aria-label="删除记忆"
        title="删除记忆"
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}

function MemoryGraph({
  memories,
  selectedMemoryId,
  onSelectMemory,
  onUpdateMemory,
  onDeleteMemory,
}: {
  memories: MemoryRecord[];
  selectedMemoryId: string | null;
  onSelectMemory: (memoryId: string | null) => void;
  onUpdateMemory: (
    memoryId: string,
    update: Pick<MemoryRecord, "type" | "content" | "importance" | "sensitivity">,
  ) => void;
  onDeleteMemory: (memoryId: string) => void;
}) {
  const selectedMemory =
    memories.find((memory) => memory.id === selectedMemoryId) ?? null;

  const { nodes, edges } = useMemo(() => {
    const usedTypes = memoryTypeOrder.filter((type) =>
      memories.some((memory) => memory.type === type),
    );

    const typeNodes: Node[] = usedTypes.map((type, index) => ({
      id: `type-${type}`,
      type: "default",
      position: { x: index * 150, y: 20 },
      data: { label: memoryTypeLabels[type], kind: "type" },
      style: {
        width: 104,
        border: "1px solid var(--color-line)",
        borderRadius: 16,
        background: "var(--color-moss)",
        color: "var(--color-pine-deep)",
        fontSize: 12,
      },
    }));

    const memoryNodes: Node[] = memories.map((memory, index) => {
      const typeIndex = Math.max(0, usedTypes.indexOf(memory.type));
      const selected = memory.id === selectedMemoryId;

      return {
        id: memory.id,
        type: "default",
        position: {
          x: typeIndex * 150 + (index % 2) * 28,
          y: 135 + Math.floor(index / Math.max(1, usedTypes.length)) * 112,
        },
        data: {
          label: truncateMemory(memory.content),
          kind: "memory",
          memoryId: memory.id,
        },
        style: {
          width: 132,
          border: `1px solid ${selected ? "var(--color-pine)" : "var(--color-line)"}`,
          borderRadius: 18,
          background: selected ? "var(--color-pine)" : "var(--color-card)",
          color: selected ? "var(--color-on-pine)" : "var(--color-ink)",
          fontSize: 11,
          lineHeight: 1.45,
          boxShadow: selected
            ? "0 10px 24px rgb(34 57 42 / 0.2)"
            : "0 2px 10px rgb(63 58 38 / 0.06)",
        },
      };
    });

    const graphEdges: Edge[] = memories.map((memory) => ({
      id: `edge-${memory.id}`,
      source: `type-${memory.type}`,
      target: memory.id,
      animated: memory.id === selectedMemoryId,
      style: { stroke: "var(--color-line-strong)" },
    }));

    return { nodes: [...typeNodes, ...memoryNodes], edges: graphEdges };
  }, [memories, selectedMemoryId]);

  const handleNodeClick: NodeMouseHandler = (_, node) => {
    const memoryId = node.data?.memoryId;
    onSelectMemory(typeof memoryId === "string" ? memoryId : null);
  };

  return (
    <div className="space-y-3">
      <div className="h-[360px] overflow-hidden rounded-2xl border border-line bg-card">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodeClick={handleNodeClick}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          panOnScroll
        >
          <Background color="var(--color-line)" gap={18} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {selectedMemory ? (
        <MemoryCard
          memory={selectedMemory}
          onUpdate={(update) => onUpdateMemory(selectedMemory.id, update)}
          onDelete={() => onDeleteMemory(selectedMemory.id)}
        />
      ) : (
        <p className="px-1 text-xs text-ink-faint">点一个节点查看或删除。</p>
      )}
    </div>
  );
}

function truncateMemory(content: string) {
  return content.length > 34 ? `${content.slice(0, 34)}...` : content;
}

function formatMemoryDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知时间";

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function toDisplayMessages(messages: StoredChatMessage[]): Message[] {
  if (messages.length === 0) return initialMessages;

  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
  }));
}

function latestAssistantContent(messages: StoredChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.content.trim()) return message.content;
  }

  return null;
}

async function readChatStream(
  response: Response,
  handlers: {
    onRoute: (label: string) => void;
    onReasoning: () => void;
    onToken: (delta: string) => void;
    onDone: (data: Extract<ChatStreamEvent, { type: "done" }>) => void;
  },
) {
  const contentType = response.headers.get("Content-Type") ?? "";

  if (!contentType.includes("application/x-ndjson")) {
    const data = (await response.json()) as {
      routed: { label: string };
      activeThread: ChatThread;
      threads: ChatThread[];
      memories: MemoryRecord[];
      messages: StoredChatMessage[];
    };
    handlers.onDone({ type: "done", ...data });
    return;
  }

  if (!response.body) throw new Error("missing response body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      handleChatStreamLine(line, handlers);
    }
  }

  if (buffer.trim()) {
    handleChatStreamLine(buffer, handlers);
  }
}

function handleChatStreamLine(
  line: string,
  handlers: {
    onRoute: (label: string) => void;
    onReasoning: () => void;
    onToken: (delta: string) => void;
    onDone: (data: Extract<ChatStreamEvent, { type: "done" }>) => void;
  },
) {
  if (!line.trim()) return;

  const event = JSON.parse(line) as ChatStreamEvent;

  if (event.type === "route") {
    handlers.onRoute(event.routed.label);
    return;
  }

  if (event.type === "token") {
    handlers.onToken(event.delta);
    return;
  }

  if (event.type === "reasoning") {
    handlers.onReasoning();
    return;
  }

  if (event.type === "done") {
    handlers.onDone(event);
    return;
  }

  throw new Error(event.error);
}

function PanelLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">
      {children}
    </p>
  );
}

function UsageMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-mist/70 px-3 py-2.5">
      <p className="truncate text-[11px] text-ink-faint">{label}</p>
      <p className="mt-0.5 truncate font-mono text-sm text-ink">{value}</p>
    </div>
  );
}

function formatCompact(value: number | null | undefined): string {
  if (value == null) return "0";
  return new Intl.NumberFormat("zh-CN", {
    notation: value >= 10000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatPercent(value: number | null | undefined): string {
  if (value == null) return "0%";
  return `${Math.round(value * 100)}%`;
}

function formatLatency(value: number | null | undefined): string {
  if (value == null) return "0ms";
  return `${Math.round(value)}ms`;
}

function IconButton({
  label,
  children,
  onClick,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-soft transition hover:bg-mist hover:text-pine-deep active:scale-95"
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function SidePanel({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="animate-veil fixed inset-0 z-50 flex justify-end bg-pine-deep/25 backdrop-blur-[2px]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <aside
        className="animate-panel flex h-full w-full max-w-sm flex-col border-l border-line bg-paper shadow-[-24px_0_60px_rgba(34,57,42,0.18)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex h-16 shrink-0 items-center justify-between px-5">
          <h2 className="font-display text-lg tracking-wide text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-soft transition hover:bg-mist"
            aria-label="关闭"
          >
            <X size={17} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 pb-8">{children}</div>
      </aside>
    </div>
  );
}
