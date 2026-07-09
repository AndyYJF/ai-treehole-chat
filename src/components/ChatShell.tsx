"use client";

import {
  FormEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
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
  ImagePlus,
  Leaf,
  LogOut,
  MessageSquare,
  Moon,
  Network,
  PenLine,
  Plus,
  RefreshCw,
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
  usedMemories?: MemoryRecord[];
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
  | { type: "status"; status: { type: string; label: string } }
  | { type: "reasoning" }
  | { type: "token"; delta: string }
  | {
      type: "done";
      routed: { label: string };
      activeThread: ChatThread;
      threads: ChatThread[];
      memories: MemoryRecord[];
      usedMemories?: MemoryRecord[];
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

type UsageRecord = {
  id: string;
  provider: string;
  operation: string;
  model: string;
  success: boolean;
  statusCode: number | null;
  latencyMs: number;
  totalTokens: number | null;
  errorMessage: string | null;
  createdAt: string;
};

type UsagePayload = {
  summary: UsageSummary;
  recent: UsageRecord[];
};

type TimeboxLetter = {
  id: string;
  userId: string;
  content: string;
  isRead: boolean;
  createdAt: string;
};

type SelectedImage = {
  base64: string;
  previewUrl: string;
  name: string;
};

type VisionSettings = {
  visionApiKey: string;
  visionBaseUrl: string;
  visionModelName: string;
};

type LocalState = {
  tier: ModelTier;
  memoryEnabled: boolean;
  temperature: number;
};

type LegacyLocalState = LocalState & {
  activeThreadId?: string;
  routeLabel?: string;
};

type TabState = {
  activeThreadId?: string;
  routeLabel?: string;
};

type ClientRecoveryState = {
  threadId?: string;
  createdAt: number;
  messages: Array<Pick<Message, "role" | "content">>;
};

const storageKey = "treehole-chat-state-v1";
const tabStateStorageKey = "treehole-chat-tab-state-v1";
const clientRecoveryStorageKey = "treehole-chat-client-recovery-v1";
const peerSyncStorageKey = "treehole-chat-peer-sync-v1";
const authSyncStorageKey = "treehole-chat-auth-sync-v1";
const peerSyncChannelName = "treehole-chat-sync";
const proactiveGreetingStoragePrefix = "treehole-proactive-greeting-v1";
const proactiveGreetingThresholdMs = 8 * 60 * 60 * 1000;
const clientRecoveryTtlMs = 24 * 60 * 60 * 1000;
const networkFallbackMessage = "刚刚连接不太顺。你说的我先接住，我们可以再试一次。";

type BrowserStorageKind = "local" | "session";

function getBrowserStorage(kind: BrowserStorageKind): Storage | null {
  if (typeof window === "undefined") return null;

  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function safeGetStorageItem(kind: BrowserStorageKind, key: string): string | null {
  try {
    return getBrowserStorage(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSetStorageItem(kind: BrowserStorageKind, key: string, value: string) {
  try {
    getBrowserStorage(kind)?.setItem(key, value);
  } catch {
    // Storage can be unavailable in private browsing, embedded webviews, or quota exhaustion.
  }
}

function safeRemoveStorageItem(kind: BrowserStorageKind, key: string) {
  try {
    getBrowserStorage(kind)?.removeItem(key);
  } catch {
    // Best-effort cleanup; server state remains authoritative.
  }
}

function createPeerSyncChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel !== "function") return null;

  try {
    return new BroadcastChannel(peerSyncChannelName);
  } catch {
    return null;
  }
}

function runBackgroundTask(task: Promise<unknown>) {
  void task.catch(() => {
    // Background sync is opportunistic; foreground/online events will retry.
  });
}

function createClientId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function tierLabel(value: ModelTier) {
  return tierOptions.find((option) => option.value === value)?.label ?? "自动";
}

function redirectToLogin() {
  if (window.location.pathname !== "/login") {
    window.location.href = "/login";
  }
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
  const [selectedImage, setSelectedImage] = useState<SelectedImage | null>(null);
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
  const [isMaintainingMemories, setIsMaintainingMemories] = useState(false);
  const [memoryEnabled, setMemoryEnabledState] = useState(true);
  const [temperature, setTemperature] = useState(0.72);
  const [routeLabel, setRouteLabel] = useState("自动");
  const [chatStatus, setChatStatus] = useState("");
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [recentUsage, setRecentUsage] = useState<UsageRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState("");
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThread, setActiveThread] = useState<ChatThread | null>(null);
  const [letters, setLetters] = useState<TimeboxLetter[]>([]);
  const [isLetterDrawerOpen, setIsLetterDrawerOpen] = useState(false);
  const [selectedLetterId, setSelectedLetterId] = useState<string | null>(null);
  const [visionSettings, setVisionSettings] = useState<VisionSettings>({
    visionApiKey: "",
    visionBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    visionModelName: "gemini-3.1-pro-preview",
  });
  const [isSavingVisionSettings, setIsSavingVisionSettings] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const thinkingTimerRef = useRef<number | null>(null);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const greetingAttemptedRef = useRef(false);
  const greetingInFlightRef = useRef(false);
  const activeThreadIdRef = useRef<string | undefined>(undefined);
  const isThinkingRef = useRef(false);
  const lastForegroundSyncRef = useRef(0);
  const pendingForegroundSyncRef = useRef(false);
  const threadRefreshSeqRef = useRef(0);
  const clientRecoveryRef = useRef<ClientRecoveryState | null>(null);
  const peerSyncChannelRef = useRef<BroadcastChannel | null>(null);
  const syncForegroundStateRef = useRef<(force?: boolean) => Promise<void>>(async () => {});
  const refreshThreadStateRef = useRef<(threadId?: string) => Promise<boolean>>(async () => false);
  const refreshLettersRef = useRef<() => Promise<void>>(async () => {});
  const triggerProactiveGreetingRef = useRef<(threadId: string) => Promise<void>>(async () => {});
  const { preference, setPreference } = useThemePreference();

  useEffect(() => {
    queueMicrotask(() => {
      clientRecoveryRef.current = readClientRecoveryState();

      const raw = safeGetStorageItem("local", storageKey);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Partial<LegacyLocalState>;
          const restoredTier = parsed.tier ?? "auto";
          const tabState = readTabState(parsed.activeThreadId, parsed.routeLabel);
          setTier(restoredTier);
          setRouteLabel(restoredTier === "auto" ? (tabState.routeLabel ?? "自动") : tierLabel(restoredTier));
          if (typeof parsed.memoryEnabled === "boolean") setMemoryEnabledState(parsed.memoryEnabled);
          if (typeof parsed.temperature === "number") setTemperature(parsed.temperature);
          runBackgroundTask(refreshThreadStateRef.current(tabState.activeThreadId));
        } catch {
          safeRemoveStorageItem("local", storageKey);
          runBackgroundTask(refreshThreadStateRef.current());
        }
      } else {
        runBackgroundTask(refreshThreadStateRef.current());
      }

      setLoaded(true);
      runBackgroundTask(refreshMemories());
      runBackgroundTask(refreshUsage());
      runBackgroundTask(refreshVisionSettings());
      void (async () => {
        try {
          const response = await fetch("/api/letters/sync", { method: "POST" });
          if (handleAuthRedirect(response)) return;

          if (response.status !== 204 && response.ok) {
            const data = (await response.json()) as { letters: TimeboxLetter[] };
            setLetters(data.letters);
            return;
          }
        } catch {
          // Letter generation is intentionally quiet and should not affect chat startup.
        }

        try {
          const response = await fetch("/api/letters");
          if (handleAuthRedirect(response)) return;
          if (!response.ok) return;

          const data = (await response.json()) as { letters: TimeboxLetter[] };
          setLetters(data.letters);
        } catch {
          // Startup remains usable offline; foreground sync retries later.
        }
      })();
    });
    // Initial restore intentionally runs once; later foreground events keep state fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loaded) return;

    const state: LocalState = {
      tier,
      memoryEnabled,
      temperature,
    };

    safeSetStorageItem("local", storageKey, JSON.stringify(state));
  }, [loaded, memoryEnabled, temperature, tier]);

  useEffect(() => {
    if (!loaded) return;

    safeSetStorageItem(
      "session",
      tabStateStorageKey,
      JSON.stringify({ activeThreadId: activeThread?.id, routeLabel } satisfies TabState),
    );
  }, [activeThread?.id, loaded, routeLabel]);

  useEffect(() => {
    activeThreadIdRef.current = activeThread?.id;
  }, [activeThread?.id]);

  useEffect(() => {
    isThinkingRef.current = isThinking;

    if (!isThinking && loaded && pendingForegroundSyncRef.current) {
      void syncForegroundStateRef.current(true);
    }
  }, [isThinking, loaded]);

  useEffect(() => {
    if (!loaded) return;

    async function syncForegroundState(force = false) {
      if (document.visibilityState === "hidden" || isThinkingRef.current) {
        pendingForegroundSyncRef.current = true;
        return;
      }
      if (!force && typeof navigator !== "undefined" && navigator.onLine === false) return;

      const now = Date.now();
      if (!force && now - lastForegroundSyncRef.current < 12_000) return;
      lastForegroundSyncRef.current = now;
      pendingForegroundSyncRef.current = false;

      try {
        await refreshThreadStateRef.current(activeThreadIdRef.current);
        await Promise.allSettled([
          refreshMemories(),
          refreshUsage(),
          refreshLettersRef.current(),
          refreshVisionSettings(),
        ]);
      } catch {
        pendingForegroundSyncRef.current = true;
        // Foreground sync is opportunistic; the next focus/online/interval event will retry.
      }
    }

    syncForegroundStateRef.current = syncForegroundState;

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        void syncForegroundState(pendingForegroundSyncRef.current);
      }
    }

    function handleForegroundEvent() {
      void syncForegroundState();
    }

    function handleOnline() {
      void syncForegroundState(true);
    }

    window.addEventListener("focus", handleForegroundEvent);
    window.addEventListener("pageshow", handleForegroundEvent);
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const peerChannel = createPeerSyncChannel();
    peerSyncChannelRef.current = peerChannel;
    if (peerChannel) {
      peerChannel.onmessage = (event) => {
        const payload = event.data as { type?: string } | null;
        if (payload?.type === "auth-state-changed") {
          redirectToLogin();
          return;
        }

        void syncForegroundState(true);
      };
    }
    function handleStorageEvent(event: StorageEvent) {
      if (event.key === storageKey) {
        applySharedLocalState(event.newValue);
        return;
      }

      if (event.key === peerSyncStorageKey) {
        void syncForegroundState(true);
        return;
      }

      if (event.key === authSyncStorageKey) {
        redirectToLogin();
        return;
      }

      if (event.key === clientRecoveryStorageKey) {
        clientRecoveryRef.current = readClientRecoveryState();
        void syncForegroundState(true);
      }
    }
    window.addEventListener("storage", handleStorageEvent);
    const syncInterval = window.setInterval(() => {
      void syncForegroundState();
    }, 45_000);

    return () => {
      window.removeEventListener("focus", handleForegroundEvent);
      window.removeEventListener("pageshow", handleForegroundEvent);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("storage", handleStorageEvent);
      window.clearInterval(syncInterval);
      peerChannel?.close();
      if (peerSyncChannelRef.current === peerChannel) {
        peerSyncChannelRef.current = null;
      }
      if (syncForegroundStateRef.current === syncForegroundState) {
        syncForegroundStateRef.current = async () => {};
      }
    };
    // Event listeners use ref-backed dynamic state and are rebound only when startup finishes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  useEffect(() => {
    if (!loaded || !activeThread?.id || isThinking || greetingAttemptedRef.current) return;

    greetingAttemptedRef.current = true;

    const latestThread =
      [...threads].sort((left, right) => {
        const leftTime = left.lastMessageAt ?? left.updatedAt;
        const rightTime = right.lastMessageAt ?? right.updatedAt;
        return rightTime.localeCompare(leftTime);
      })[0] ?? activeThread;

    if (!shouldTriggerProactiveGreeting(latestThread)) return;

    void triggerProactiveGreetingRef.current(latestThread.id);
  }, [activeThread, isThinking, loaded, threads]);

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
  const hasUnreadLetters = letters.some((letter) => !letter.isRead);

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

  function applyClientRecoveryMessages(baseMessages: Message[], threadId?: string): Message[] {
    const recovery = clientRecoveryRef.current;
    if (!recovery) return baseMessages;

    if (!isClientRecoveryActive(recovery, threadId)) {
      if (!recovery.threadId || isClientRecoveryExpired(recovery)) {
        clearClientRecoveryState();
      }
      return baseMessages;
    }

    const visibleMessages = baseMessages.map((message) => ({
      role: message.role,
      content: message.content,
    }));
    const alreadySynced = recovery.messages.every((message) =>
      visibleMessages.some(
        (visible) => visible.role === message.role && visible.content === message.content,
      ),
    );

    if (alreadySynced) {
      clearClientRecoveryState();
      return baseMessages;
    }

    const withoutDuplicateFallback = baseMessages.filter(
      (message) => message.content !== networkFallbackMessage,
    );
    return [
      ...withoutDuplicateFallback.filter((message) =>
        !recovery.messages.some(
          (recovered) => recovered.role === message.role && recovered.content === message.content,
        ),
      ),
      ...recovery.messages.map((message) => ({
        id: createClientId(),
        role: message.role,
        content: message.content,
      })),
    ];
  }

  function saveClientRecoveryState(recovery: ClientRecoveryState) {
    clientRecoveryRef.current = recovery;
    safeSetStorageItem("local", clientRecoveryStorageKey, JSON.stringify(recovery));
  }

  function clearClientRecoveryState() {
    clientRecoveryRef.current = null;
    safeRemoveStorageItem("local", clientRecoveryStorageKey);
  }

  function notifyPeerTabs(reason: string) {
    const payload = { type: "server-state-changed", reason, at: Date.now() };
    peerSyncChannelRef.current?.postMessage(payload);
    safeSetStorageItem("local", peerSyncStorageKey, JSON.stringify(payload));
  }

  function notifyAuthTabs(reason: string) {
    const payload = { type: "auth-state-changed", reason, at: Date.now() };
    peerSyncChannelRef.current?.postMessage(payload);
    safeSetStorageItem("local", authSyncStorageKey, JSON.stringify(payload));
  }

  function handleAuthRedirect(response: Response) {
    if (response.status === 401) {
      notifyAuthTabs("unauthorized");
      redirectToLogin();
      return true;
    }

    if (response.status === 428) {
      window.location.href = "/setup";
      return true;
    }

    return false;
  }

  function applySharedLocalState(raw: string | null) {
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as Partial<LocalState>;
      const nextTier = parsed.tier ?? "auto";
      setTier(nextTier);
      if (typeof parsed.memoryEnabled === "boolean") setMemoryEnabledState(parsed.memoryEnabled);
      if (typeof parsed.temperature === "number") setTemperature(parsed.temperature);
      setRouteLabel((current) => (nextTier === "auto" ? current : tierLabel(nextTier)));
    } catch {
      // Ignore malformed state from older clients; the next local write will repair it.
    }
  }

  function invalidateThreadRefreshes() {
    threadRefreshSeqRef.current += 1;
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
    if (handleAuthRedirect(response)) return;
    if (!response.ok) return;

    const data = (await response.json()) as {
      memories: MemoryRecord[];
      settings: { enabled: boolean };
    };

    setMemories(data.memories);
    setMemoryEnabledState(data.settings.enabled);
  }

  async function refreshThreadState(threadId?: string): Promise<boolean> {
    const refreshSeq = threadRefreshSeqRef.current + 1;
    threadRefreshSeqRef.current = refreshSeq;
    const query = threadId ? `?threadId=${encodeURIComponent(threadId)}` : "";
    const response = await fetch(`/api/threads${query}`);
    if (handleAuthRedirect(response)) return false;
    if (!response.ok) return false;

    const data = (await response.json()) as {
      activeThread: ChatThread;
      threads: ChatThread[];
      messages: StoredChatMessage[];
    };
    const nextActiveThread = sanitizeChatThread(data.activeThread);

    if (refreshSeq !== threadRefreshSeqRef.current) return false;

    if (threadId && nextActiveThread.id !== threadId) {
      clearClientRecoveryState();
    }

    setThreads(sanitizeChatThreads(data.threads));
    setActiveThread(nextActiveThread);
    setMessages(applyClientRecoveryMessages(toDisplayMessages(data.messages), nextActiveThread.id));
    return true;
  }

  refreshThreadStateRef.current = refreshThreadState;

  async function refreshUsage() {
    const response = await fetch("/api/usage");
    if (handleAuthRedirect(response)) return;
    if (!response.ok) return;

    const data = (await response.json()) as UsagePayload;
    setUsage(data.summary);
    setRecentUsage(data.recent ?? []);
  }

  async function refreshVisionSettings() {
    const response = await fetch("/api/setup");
    if (handleAuthRedirect(response)) return;
    if (!response.ok) return;

    const data = (await response.json()) as {
      defaults?: Partial<VisionSettings>;
    };

    setVisionSettings((current) => ({
      visionApiKey: data.defaults?.visionApiKey ?? current.visionApiKey,
      visionBaseUrl: data.defaults?.visionBaseUrl ?? current.visionBaseUrl,
      visionModelName: data.defaults?.visionModelName ?? current.visionModelName,
    }));
  }

  function updateVisionSetting<Key extends keyof VisionSettings>(key: Key, value: VisionSettings[Key]) {
    setVisionSettings((current) => ({
      ...current,
      [key]: value,
    }));
  }

  async function saveVisionSettings() {
    if (isSavingVisionSettings) return;

    setIsSavingVisionSettings(true);

    try {
      const response = await fetch("/api/setup", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(visionSettings),
      });

      if (handleAuthRedirect(response)) return;
      if (!response.ok) throw new Error("save failed");

      const data = (await response.json()) as { defaults?: Partial<VisionSettings> };
      if (data.defaults) {
        setVisionSettings((current) => ({
          visionApiKey: data.defaults?.visionApiKey ?? current.visionApiKey,
          visionBaseUrl: data.defaults?.visionBaseUrl ?? current.visionBaseUrl,
          visionModelName: data.defaults?.visionModelName ?? current.visionModelName,
        }));
      }
      notifyPeerTabs("vision-settings");
      showNotice("Vision 配置已保存。");
    } catch {
      showNotice("Vision 配置没有保存成功。");
    } finally {
      setIsSavingVisionSettings(false);
    }
  }

  async function refreshLetters() {
    const response = await fetch("/api/letters");
    if (handleAuthRedirect(response)) return;
    if (!response.ok) return;

    const data = (await response.json()) as { letters: TimeboxLetter[] };
    setLetters(data.letters);
  }

  refreshLettersRef.current = refreshLetters;

  async function openLetterDrawer() {
    setIsLetterDrawerOpen(true);
    runBackgroundTask(refreshLetters());
  }

  async function selectLetter(letterId: string) {
    setSelectedLetterId(letterId);

    const target = letters.find((letter) => letter.id === letterId);
    if (!target || target.isRead) return;

    const response = await fetch("/api/letters", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: letterId }),
    });

    if (handleAuthRedirect(response)) return;
    if (!response.ok) return;

    const data = (await response.json()) as { letters: TimeboxLetter[] };
    setLetters(data.letters);
    notifyPeerTabs("letter-read");
  }

  async function deleteMemory(memoryId: string) {
    const response = await fetch("/api/memories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", memoryId }),
    });

    if (handleAuthRedirect(response)) return;
    if (!response.ok) return;
    const data = (await response.json()) as { memories: MemoryRecord[] };
    setMemories(data.memories);
    setSelectedMemoryId((current) => (current === memoryId ? null : current));
    notifyPeerTabs("memory-delete");
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

    if (handleAuthRedirect(response)) return;
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
    notifyPeerTabs("memory-update");
    showNotice("记忆已更新。");
  }

  async function clearAllMemories() {
    if (!window.confirm("清空所有记忆？")) return;

    const response = await fetch("/api/memories", { method: "DELETE" });
    if (handleAuthRedirect(response)) return;
    if (!response.ok) return;

    const data = (await response.json()) as {
      memories: MemoryRecord[];
      settings: { enabled: boolean };
    };

    setMemories(data.memories);
    setMemoryEnabledState(data.settings.enabled);
    notifyPeerTabs("memory-clear");
  }

  async function maintainMemoriesNow() {
    if (isMaintainingMemories) return;

    setIsMaintainingMemories(true);

    try {
      const response = await fetch("/api/memories", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "maintain" }),
      });

      if (handleAuthRedirect(response)) return;
      if (!response.ok) throw new Error("maintain failed");

      const data = (await response.json()) as {
        memories: MemoryRecord[];
        settings: { enabled: boolean };
      };

      setMemories(data.memories);
      setMemoryEnabledState(data.settings.enabled);
      notifyPeerTabs("memory-maintain");
      showNotice("记忆已维护。");
    } catch {
      showNotice("记忆维护没有完成，再试一次。");
    } finally {
      setIsMaintainingMemories(false);
    }
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

      if (handleAuthRedirect(response)) return;
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

      if (handleAuthRedirect(response)) return;
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
      notifyPeerTabs("memory-import");
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
    if (handleAuthRedirect(response)) return;
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
    if (handleAuthRedirect(response)) return;
    if (!response.ok) return;

    const data = (await response.json()) as UsagePayload;
    setUsage(data.summary);
    setRecentUsage(data.recent ?? []);
    notifyPeerTabs("usage-clear");
  }

  async function clearAllData() {
    if (!window.confirm("清空对话、记忆和用量记录？这个操作不能撤销。")) return;

    const response = await fetch("/api/data", { method: "DELETE" });
    if (handleAuthRedirect(response)) return;
    if (!response.ok) return;

    const data = (await response.json()) as {
      activeThread: ChatThread;
      threads: ChatThread[];
      memories: MemoryRecord[];
      settings: { enabled: boolean };
      usage: UsageSummary;
    };

    safeRemoveStorageItem("local", storageKey);
    safeRemoveStorageItem("session", tabStateStorageKey);
    clearClientRecoveryState();
    invalidateThreadRefreshes();
    setActiveThread(sanitizeChatThread(data.activeThread));
    setThreads(sanitizeChatThreads(data.threads));
    setMessages(initialMessages);
    setMemories(data.memories);
    setMemoryEnabledState(data.settings.enabled);
    setUsage(data.usage);
    setRecentUsage([]);
    setTier("auto");
    setRouteLabel("自动");
    setTemperature(0.72);
    setInput("");
    notifyPeerTabs("data-clear");
  }

  async function logout() {
    try {
      await fetch("/api/session", { method: "DELETE" });
    } finally {
      notifyAuthTabs("logout");
      redirectToLogin();
    }
  }

  async function setMemoryEnabled(enabled: boolean) {
    setMemoryEnabledState(enabled);

    const response = await fetch("/api/memories", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setEnabled", enabled }),
    });

    if (handleAuthRedirect(response)) return;
    if (!response.ok) return;
    const data = (await response.json()) as {
      memories: MemoryRecord[];
      settings: { enabled: boolean };
    };
    setMemories(data.memories);
    setMemoryEnabledState(data.settings.enabled);
    notifyPeerTabs("memory-enabled");
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

    if (handleAuthRedirect(response)) return;
    if (!response.ok) {
      showNotice("没有建好，再试一次。");
      return;
    }

    const data = (await response.json()) as {
      activeThread: ChatThread;
      threads: ChatThread[];
      messages: StoredChatMessage[];
    };

    clearClientRecoveryState();
    invalidateThreadRefreshes();
    setActiveThread(sanitizeChatThread(data.activeThread));
    setThreads(sanitizeChatThreads(data.threads));
    setMessages(toDisplayMessages(data.messages));
    setRouteLabel("自动");
    setInput("");
    setTimelineOpen(false);
    notifyPeerTabs("thread-create");
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

    if (handleAuthRedirect(response)) return;
    if (!response.ok) {
      showNotice("没有删掉，再试一次。");
      return;
    }

    const data = (await response.json()) as {
      activeThread: ChatThread;
      threads: ChatThread[];
      messages: StoredChatMessage[];
    };

    clearClientRecoveryState();
    invalidateThreadRefreshes();
    setActiveThread(sanitizeChatThread(data.activeThread));
    setThreads(sanitizeChatThreads(data.threads));
    setMessages(toDisplayMessages(data.messages));
    setTimelineOpen(false);
    setRouteLabel("自动");
    notifyPeerTabs("thread-delete");
    showNotice("已删除时间线。");
  }

  async function switchThread(threadId: string) {
    if (isThinking) {
      showNotice("正在回复，稍等一下。");
      return;
    }

    if (await refreshThreadState(threadId)) {
      clearClientRecoveryState();
      setTimelineOpen(false);
    }
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

    if (handleAuthRedirect(response)) return;
    if (!response.ok) {
      showNotice("没有清掉，再试一次。");
      runBackgroundTask(refreshThreadState(threadId));
      return;
    }

    const data = (await response.json()) as {
      activeThread: ChatThread;
      threads: ChatThread[];
      messages: StoredChatMessage[];
    };

    clearClientRecoveryState();
    invalidateThreadRefreshes();
    setActiveThread(sanitizeChatThread(data.activeThread));
    setThreads(sanitizeChatThreads(data.threads));
    setMessages(toDisplayMessages(data.messages));
    setRouteLabel("自动");
    setInput("");
    notifyPeerTabs("messages-clear");
    showNotice("已清空当前上下文。");
  }

  function shouldTriggerProactiveGreeting(thread: ChatThread) {
    const lockKey = proactiveGreetingLockKey(thread.id);
    const lockedAt = Number(safeGetStorageItem("local", lockKey) ?? 0);

    if (lockedAt && Date.now() - lockedAt < proactiveGreetingThresholdMs) return false;
    if (!thread.lastMessageAt) return true;

    const lastMessageAt = new Date(thread.lastMessageAt).getTime();
    if (Number.isNaN(lastMessageAt)) return false;

    return Date.now() - lastMessageAt >= proactiveGreetingThresholdMs;
  }

  async function triggerProactiveGreeting(threadId: string) {
    if (greetingInFlightRef.current) return;

    // Prefer the newest timeline for proactive care, even if the client is
    // currently viewing an older thread.
    const latestThread =
      [...threads].sort((left, right) => {
        const leftTime = left.lastMessageAt ?? left.updatedAt;
        const rightTime = right.lastMessageAt ?? right.updatedAt;
        return rightTime.localeCompare(leftTime);
      })[0] ?? null;
    const targetThreadId = latestThread?.id ?? threadId;
    const lockKey = proactiveGreetingLockKey(targetThreadId);

    try {
      if (latestThread && latestThread.id !== activeThread?.id) {
        setActiveThread(sanitizeChatThread(latestThread));
        await refreshThreadState(latestThread.id);
      }

      const assistantMessage: Message = {
        id: createClientId(),
        role: "assistant",
        content: "",
      };

      greetingInFlightRef.current = true;
      safeSetStorageItem("local", lockKey, String(Date.now()));
      setMessages((current) => [...current.filter((message) => message.id !== "hello"), assistantMessage]);
      setIsThinking(true);
      setChatStatus("准备关心");
      startThinkingTimer();

      const response = await fetch("/api/chat/greet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (handleAuthRedirect(response)) return;
      if (response.status === 204) {
        setMessages((current) => {
          const next = current.filter((message) => message.id !== assistantMessage.id);
          return next.length > 0 ? next : initialMessages;
        });
        return;
      }

      if (!response.ok) throw new Error("request failed");

      await readChatStream(response, {
        onRoute: (label) => setRouteLabel(label),
        onStatus: (label) => setChatStatus(label),
        onReasoning: () => setIsThinking(true),
        onToken: (delta) => {
          setChatStatus("");
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
          invalidateThreadRefreshes();
          setRouteLabel(data.routed.label);
          setActiveThread(sanitizeChatThread(data.activeThread));
          setThreads(sanitizeChatThreads(data.threads));
          setMemories(data.memories);
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessage.id
                ? {
                    ...message,
                    content: stripInternalMetadataFromContent(
                      message.content.trim().length > 0
                        ? message.content
                        : latestAssistantContent(data.messages) ?? "我在。你可以慢慢说。",
                    ),
                    usedMemories: data.usedMemories ?? [],
                  }
                : message,
            ),
          );
          notifyPeerTabs("proactive-greeting");
          runBackgroundTask(refreshUsage());
        },
      });
    } catch {
      safeRemoveStorageItem("local", lockKey);
      setMessages((current) => {
        const next = current.filter((message) => message.content.trim().length > 0 || message.id === "hello");
        return next.length > 0 ? next : initialMessages;
      });
    } finally {
      greetingInFlightRef.current = false;
      stopThinkingTimer();
      setIsThinking(false);
      setChatStatus("");
    }
  }

  triggerProactiveGreetingRef.current = triggerProactiveGreeting;

  async function selectImageFile(file: File | undefined) {
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      showNotice("请选择图片文件。");
      return;
    }

    try {
      const compressed = await compressImageToJpegBase64(file);
      setSelectedImage({
        base64: compressed,
        previewUrl: compressed,
        name: file.name || "image.jpg",
      });
    } catch {
      showNotice("图片没有处理成功，换一张试试。");
    }
  }

  function removeSelectedImage() {
    setSelectedImage(null);
    if (imageInputRef.current) imageInputRef.current.value = "";
  }

  function handleImagePaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const file = Array.from(event.clipboardData.files).find((item) =>
      item.type.startsWith("image/"),
    );
    if (!file) return;

    event.preventDefault();
    void selectImageFile(file);
  }

  function handleImageDrop(event: ReactDragEvent<HTMLTextAreaElement>) {
    const file = Array.from(event.dataTransfer.files).find((item) =>
      item.type.startsWith("image/"),
    );
    if (!file) return;

    event.preventDefault();
    void selectImageFile(file);
  }

  function handleImageDragOver(event: ReactDragEvent<HTMLTextAreaElement>) {
    if (
      Array.from(event.dataTransfer.items).some((item) =>
        item.type.startsWith("image/"),
      )
    ) {
      event.preventDefault();
    }
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;

    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const textContent = input.trim();
    if ((!textContent && !selectedImage) || isThinking) return;
    if (!activeThread?.id) {
      showNotice("时间线还在同步，稍等一下。");
      return;
    }

    const content = textContent || "请看看这张图片。";
    const imageBase64 = selectedImage?.base64;

    const userMessage: Message = {
      id: createClientId(),
      role: "user",
      content: selectedImage ? `【图片】${content}` : content,
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
    setSelectedImage(null);
    setIsThinking(true);
    setChatStatus("准备回复");
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
          imageBase64,
          recentMessages,
        }),
      });

      if (handleAuthRedirect(response)) return;
      if (!response.ok) throw new Error("request failed");

      await readChatStream(response, {
        onRoute: (label) => setRouteLabel(label),
        onStatus: (label) => setChatStatus(label),
        onReasoning: () => setIsThinking(true),
        onToken: (delta) => {
          setChatStatus("");
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
          clearClientRecoveryState();
          invalidateThreadRefreshes();
          setRouteLabel(data.routed.label);
          setActiveThread(sanitizeChatThread(data.activeThread));
          setThreads(sanitizeChatThreads(data.threads));
          setMemories(data.memories);
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessage.id
                ? {
                    ...message,
                    content: stripInternalMetadataFromContent(
                      message.content.trim().length > 0
                        ? message.content
                        : latestAssistantContent(data.messages) ?? "我在。你可以慢慢说。",
                    ),
                    usedMemories: data.usedMemories ?? [],
                  }
                : message,
            ),
          );
          notifyPeerTabs("chat-message");
          runBackgroundTask(refreshUsage());
        },
      });
    } catch {
      const recoveryMessages: ClientRecoveryState["messages"] = [
        { role: "user", content: userMessage.content },
        { role: "assistant", content: networkFallbackMessage },
      ];
      saveClientRecoveryState({
        threadId: activeThread.id,
        createdAt: Date.now(),
        messages: recoveryMessages,
      });
      setMessages((current) =>
        applyClientRecoveryMessages(
          current.filter((message) => message.id !== assistantMessage.id),
          activeThread?.id,
        ),
      );
    } finally {
      stopThinkingTimer();
      setIsThinking(false);
      setChatStatus("");
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
            <button
              type="button"
              onClick={() => void openLetterDrawer()}
              className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-pine text-card shadow-[0_2px_10px_rgba(34,57,42,0.35)] transition hover:bg-pine-deep active:scale-95"
              aria-label="时光信箱"
              title="时光信箱"
            >
              <Leaf size={17} strokeWidth={1.8} />
              {hasUnreadLetters ? (
                <span className="absolute right-0 top-0 flex h-2.5 w-2.5" aria-hidden>
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-clay opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full border border-card bg-clay" />
                </span>
              ) : null}
            </button>
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
                runBackgroundTask(refreshThreadState(activeThread?.id));
              }}
            >
              <PenLine size={17} strokeWidth={1.8} />
            </IconButton>
            <IconButton
              label="记忆"
              onClick={() => {
                setMemoryOpen(true);
                runBackgroundTask(refreshMemories());
              }}
            >
              <Brain size={17} strokeWidth={1.8} />
            </IconButton>
            <IconButton
              label="设置"
              onClick={() => {
                setSettingsOpen(true);
                runBackgroundTask(refreshUsage());
              }}
            >
              <Settings size={17} strokeWidth={1.8} />
            </IconButton>
          </div>
        </header>

        <section
          className={`flex flex-1 flex-col gap-4 pb-32 pt-6 ${isFreshThread ? "justify-center" : "justify-end"}`}
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
                    <div
                      className={`max-w-[85%] whitespace-pre-wrap px-4.5 py-3 text-[15px] leading-7 sm:max-w-[72%] ${
                        message.role === "user"
                          ? "rounded-3xl rounded-br-lg bg-pine text-[#f4f7ee] shadow-[0_6px_20px_rgba(34,57,42,0.22)]"
                          : "rounded-3xl rounded-bl-lg border border-line bg-card text-ink shadow-[0_2px_12px_rgba(63,58,38,0.06)]"
                      }`}
                    >
                      <MarkdownMessage content={message.content} isUser={message.role === "user"} />
                      {message.role === "assistant" && message.usedMemories && message.usedMemories.length > 0 ? (
                        <ReferencedMemories memories={message.usedMemories} />
                      ) : null}
                    </div>
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
                      {chatStatus ? `${chatStatus}，` : ""}思考中（{thinkingSeconds}秒）
                    </span>
                  </div>
                </div>
              ) : null}
              <div ref={bottomRef} />
            </div>
          )}
        </section>

        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 px-4 pb-4 pt-5 sm:px-6">
          <div className="pointer-events-auto mx-auto w-full max-w-3xl">
            <form
              onSubmit={sendMessage}
              className="rounded-[26px] border border-line bg-card p-2 transition focus-within:border-line-strong"
            >
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  void selectImageFile(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              {selectedImage ? (
                <div className="mb-2 flex items-center gap-3 rounded-2xl border border-line bg-mist/45 p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={selectedImage.previewUrl}
                    alt={selectedImage.name}
                    className="h-14 w-14 shrink-0 rounded-xl object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-ink-soft">{selectedImage.name}</p>
                    <p className="mt-0.5 text-[11px] text-ink-faint">将先识图，再交给树洞回复</p>
                  </div>
                  <button
                    type="button"
                    onClick={removeSelectedImage}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-clay transition hover:bg-clay-soft"
                    aria-label="移除图片"
                    title="移除图片"
                  >
                    <X size={15} />
                  </button>
                </div>
              ) : null}
              <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={() => imageInputRef.current?.click()}
                disabled={isThinking}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-faint transition hover:bg-mist hover:text-pine active:scale-95 disabled:cursor-not-allowed disabled:text-line-strong"
                aria-label="上传图片"
                title="上传图片"
              >
                <ImagePlus size={17} strokeWidth={1.8} />
              </button>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(event) => {
                  setInput(event.target.value);
                  resizeTextarea();
                }}
                onKeyDown={handleInputKeyDown}
                onPaste={handleImagePaste}
                onDrop={handleImageDrop}
                onDragOver={handleImageDragOver}
                rows={1}
                placeholder="写给我……"
                aria-label="写给我"
                className="max-h-40 min-h-11 flex-1 resize-none bg-transparent px-3 py-2.5 text-[15px] leading-6 text-ink outline-none placeholder:text-ink-faint"
              />
              <button
                type="submit"
                disabled={(!input.trim() && !selectedImage) || isThinking}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-pine text-card transition hover:bg-pine-deep active:scale-95 disabled:cursor-not-allowed disabled:bg-line-strong"
                aria-label="发送"
              >
                <Send size={17} strokeWidth={1.8} />
              </button>
              </div>
            </form>
            <p className="mt-2 text-center text-[11px] text-ink-faint">
              这里只有你和树洞，数据随时可以导出或清空。
            </p>
          </div>
        </div>
      </div>

      <TimeboxLetterDrawer
        open={isLetterDrawerOpen}
        letters={letters}
        selectedLetterId={selectedLetterId}
        onSelect={(letterId) => void selectLetter(letterId)}
        onClose={() => setIsLetterDrawerOpen(false)}
      />

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
            <PanelLabel>Vision</PanelLabel>
            <div className="mt-3 space-y-3">
              <SettingsInput
                label="Vision Key"
                value={visionSettings.visionApiKey}
                onChange={(value) => updateVisionSetting("visionApiKey", value)}
                type="password"
                autoComplete="off"
              />
              <SettingsInput
                label="Vision Base URL"
                value={visionSettings.visionBaseUrl}
                onChange={(value) => updateVisionSetting("visionBaseUrl", value)}
              />
              <SettingsInput
                label="Vision Model"
                value={visionSettings.visionModelName}
                onChange={(value) => updateVisionSetting("visionModelName", value)}
              />
              <button
                type="button"
                onClick={() => void saveVisionSettings()}
                disabled={isSavingVisionSettings}
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-pine px-3 text-sm text-card transition hover:bg-pine-deep disabled:cursor-not-allowed disabled:bg-line-strong"
              >
                <Check size={15} />
                {isSavingVisionSettings ? "保存中" : "保存 Vision 配置"}
              </button>
            </div>
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
            {recentUsage.length > 0 ? (
              <div className="mt-3 space-y-2">
                <PanelLabel>最近事件</PanelLabel>
                <div className="space-y-1.5">
                  {recentUsage.slice(0, 8).map((record) => (
                    <UsageEvent key={record.id} record={record} />
                  ))}
                </div>
              </div>
            ) : null}
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
              <button
                type="button"
                onClick={() => void maintainMemoriesNow()}
                disabled={isMaintainingMemories}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-faint transition hover:bg-mist hover:text-pine disabled:cursor-not-allowed disabled:text-line-strong"
                aria-label="维护记忆"
                title="维护记忆"
              >
                <RefreshCw
                  size={14}
                  className={isMaintainingMemories ? "animate-spin" : ""}
                />
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

  const { nodes, edges, graphSize } = useMemo(() => {
    const usedTypes = memoryTypeOrder.filter((type) =>
      memories.some((memory) => memory.type === type),
    );
    const center = { x: 420, y: 300 };
    const typeRadius = Math.max(150, Math.min(250, 130 + usedTypes.length * 18));
    const memoryRadius = 122;
    const typeNodeWidth = 124;
    const memoryNodeWidth = 152;
    const grouped = new Map<MemoryType, MemoryRecord[]>();

    for (const type of usedTypes) {
      grouped.set(
        type,
        memories
          .filter((memory) => memory.type === type)
          .sort((a, b) => b.importance - a.importance || b.lastSeenAt.localeCompare(a.lastSeenAt)),
      );
    }

    const typePositions = new Map<MemoryType, { x: number; y: number; angle: number }>();
    const typeNodes: Node[] = usedTypes.map((type, index) => {
      const angle = -Math.PI / 2 + (index / Math.max(usedTypes.length, 1)) * Math.PI * 2;
      const x = center.x + Math.cos(angle) * typeRadius;
      const y = center.y + Math.sin(angle) * typeRadius;
      typePositions.set(type, { x, y, angle });

      return {
        id: `type-${type}`,
        type: "default",
        position: { x, y },
        data: { label: memoryTypeLabels[type], kind: "type" },
        style: {
          width: typeNodeWidth,
          border: "1px solid var(--color-line)",
          borderRadius: 999,
          background: "var(--color-moss)",
          color: "var(--color-pine-deep)",
          fontSize: 12,
          fontWeight: 600,
          padding: "9px 12px",
          textAlign: "center",
          boxShadow: "0 8px 20px rgb(63 58 38 / 0.08)",
        },
      };
    });

    const rawMemoryNodes: Node[] = usedTypes.flatMap((type) =>
      (grouped.get(type) ?? []).map((memory, memoryIndex) => {
        const selected = memory.id === selectedMemoryId;
        const typePosition = typePositions.get(type) ?? { ...center, angle: 0 };
        const memoriesInType = grouped.get(type)?.length ?? 1;
        const perRing = 4;
        const ringIndex = Math.floor(memoryIndex / perRing);
        const indexInRing = memoryIndex % perRing;
        const itemsInRing = Math.min(perRing, memoriesInType - ringIndex * perRing);
        const spread = Math.min(Math.PI * 1.2, Math.max(Math.PI * 0.5, itemsInRing * 0.34));
        const offset =
          itemsInRing === 1
            ? 0
            : -spread / 2 + (indexInRing / Math.max(itemsInRing - 1, 1)) * spread;
        const angle = typePosition.angle + offset;
        const ring = memoryRadius + ringIndex * 150;
        const xJitter = ringIndex % 2 === 0 ? 0 : 34;
        const yJitter = indexInRing % 2 === 0 ? 0 : 18;

        return {
          id: memory.id,
          type: "default",
          position: {
            x: typePosition.x + Math.cos(angle) * ring + xJitter,
            y: typePosition.y + Math.sin(angle) * ring + yJitter,
          },
          data: {
            label: truncateMemory(memory.content),
            kind: "memory",
            memoryId: memory.id,
          },
          style: {
            width: memoryNodeWidth,
            minHeight: 72,
            border: `1px solid ${selected ? "var(--color-pine)" : "var(--color-line)"}`,
            borderRadius: 12,
            background: selected ? "var(--color-pine)" : "var(--color-card)",
            color: selected ? "var(--color-on-pine)" : "var(--color-ink)",
            fontSize: 11,
            lineHeight: 1.5,
            padding: "9px 10px",
            boxShadow: selected
              ? "0 10px 24px rgb(34 57 42 / 0.2)"
              : "0 2px 10px rgb(63 58 38 / 0.06)",
          },
        };
      }),
    );

    const centerNode: Node = {
      id: "memory-center",
      type: "default",
      position: center,
      data: { label: "长期记忆", kind: "center" },
      selectable: false,
      draggable: false,
      style: {
        width: 116,
        border: "1px solid var(--color-pine)",
        borderRadius: 999,
        background: "var(--color-pine)",
        color: "var(--color-on-pine)",
        fontSize: 12,
        fontWeight: 600,
        padding: "10px 12px",
        textAlign: "center",
        boxShadow: "0 12px 28px rgb(34 57 42 / 0.22)",
      },
    };

    const graphEdges: Edge[] = memories.map((memory) => ({
      id: `edge-${memory.id}`,
      source: `type-${memory.type}`,
      target: memory.id,
      animated: memory.id === selectedMemoryId,
      style: { stroke: "var(--color-line-strong)" },
    }));
    const typeEdges: Edge[] = usedTypes.map((type) => ({
      id: `edge-center-${type}`,
      source: "memory-center",
      target: `type-${type}`,
      style: { stroke: "var(--color-line)" },
    }));

    const layoutNodes = resolveMemoryGraphCollisions([centerNode, ...typeNodes, ...rawMemoryNodes]);
    const bounds = getMemoryGraphBounds(layoutNodes);
    const graphSize = {
      width: Math.max(1120, bounds.maxX + 120),
      height: Math.max(860, bounds.maxY + 120),
    };

    return { nodes: layoutNodes, edges: [...typeEdges, ...graphEdges], graphSize };
  }, [memories, selectedMemoryId]);

  const handleNodeClick: NodeMouseHandler = (_, node) => {
    const memoryId = node.data?.memoryId;
    onSelectMemory(typeof memoryId === "string" ? memoryId : null);
  };

  return (
    <div className="space-y-3">
      <div className="h-[420px] overflow-auto rounded-2xl border border-line bg-card">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodeClick={handleNodeClick}
          defaultViewport={{ x: -220, y: -120, zoom: 0.82 }}
          minZoom={0.45}
          maxZoom={1.3}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          panOnScroll
          translateExtent={[
            [-80, -80],
            [graphSize.width, graphSize.height],
          ]}
          nodeExtent={[
            [-20, -20],
            [graphSize.width - 40, graphSize.height - 40],
          ]}
          style={{
            width: graphSize.width,
            height: graphSize.height,
          }}
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

function resolveMemoryGraphCollisions(nodes: Node[]) {
  const padding = 18;
  const movableIds = new Set(
    nodes
      .filter((node) => node.data?.kind === "memory")
      .map((node) => node.id),
  );
  const originalPositions = new Map(
    nodes.map((node) => [node.id, { ...node.position }]),
  );
  const layoutNodes = nodes.map((node) => ({
    ...node,
    position: { ...node.position },
  }));

  for (let iteration = 0; iteration < 90; iteration += 1) {
    let moved = false;

    for (let leftIndex = 0; leftIndex < layoutNodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < layoutNodes.length; rightIndex += 1) {
        const left = layoutNodes[leftIndex];
        const right = layoutNodes[rightIndex];
        const leftMovable = movableIds.has(left.id);
        const rightMovable = movableIds.has(right.id);

        if (!leftMovable && !rightMovable) continue;

        const leftBox = getMemoryGraphNodeBox(left);
        const rightBox = getMemoryGraphNodeBox(right);
        const dx = rightBox.centerX - leftBox.centerX;
        const dy = rightBox.centerY - leftBox.centerY;
        const overlapX = leftBox.width / 2 + rightBox.width / 2 + padding - Math.abs(dx);
        const overlapY = leftBox.height / 2 + rightBox.height / 2 + padding - Math.abs(dy);

        if (overlapX <= 0 || overlapY <= 0) continue;

        moved = true;
        const pushX = dx === 0 ? (leftIndex % 2 === 0 ? 1 : -1) : Math.sign(dx);
        const pushY = dy === 0 ? (rightIndex % 2 === 0 ? 1 : -1) : Math.sign(dy);

        if (overlapX < overlapY) {
          const shift = overlapX + 4;
          if (leftMovable && rightMovable) {
            left.position.x -= (shift * pushX) / 2;
            right.position.x += (shift * pushX) / 2;
          } else if (leftMovable) {
            left.position.x -= shift * pushX;
          } else {
            right.position.x += shift * pushX;
          }
        } else {
          const shift = overlapY + 4;
          if (leftMovable && rightMovable) {
            left.position.y -= (shift * pushY) / 2;
            right.position.y += (shift * pushY) / 2;
          } else if (leftMovable) {
            left.position.y -= shift * pushY;
          } else {
            right.position.y += shift * pushY;
          }
        }
      }
    }

    for (const node of layoutNodes) {
      if (!movableIds.has(node.id)) continue;
      const original = originalPositions.get(node.id);
      if (!original) continue;

      node.position.x += (original.x - node.position.x) * 0.006;
      node.position.y += (original.y - node.position.y) * 0.006;
    }

    if (!moved) break;
  }

  const bounds = getMemoryGraphBounds(layoutNodes);
  const offsetX = bounds.minX < 40 ? 40 - bounds.minX : 0;
  const offsetY = bounds.minY < 40 ? 40 - bounds.minY : 0;

  if (offsetX === 0 && offsetY === 0) return layoutNodes;

  return layoutNodes.map((node) => ({
    ...node,
    position: {
      x: node.position.x + offsetX,
      y: node.position.y + offsetY,
    },
  }));
}

function getMemoryGraphNodeBox(node: Node) {
  const kind = node.data?.kind;
  const width = kind === "memory" ? 172 : kind === "type" ? 144 : 136;
  const height = kind === "memory" ? 96 : 56;

  return {
    width,
    height,
    centerX: node.position.x + width / 2,
    centerY: node.position.y + height / 2,
    minX: node.position.x,
    minY: node.position.y,
    maxX: node.position.x + width,
    maxY: node.position.y + height,
  };
}

function getMemoryGraphBounds(nodes: Node[]) {
  return nodes.reduce(
    (bounds, node) => {
      const box = getMemoryGraphNodeBox(node);
      return {
        minX: Math.min(bounds.minX, box.minX),
        minY: Math.min(bounds.minY, box.minY),
        maxX: Math.max(bounds.maxX, box.maxX),
        maxY: Math.max(bounds.maxY, box.maxY),
      };
    },
    { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: 0, maxY: 0 },
  );
}

type MarkdownBlock =
  | { type: "paragraph"; lines: string[] }
  | { type: "heading"; level: number; text: string }
  | { type: "unordered-list"; items: string[] }
  | { type: "ordered-list"; items: string[] }
  | { type: "blockquote"; lines: string[] }
  | { type: "code"; language: string; content: string };

function MarkdownMessage({ content, isUser }: { content: string; isUser: boolean }) {
  const blocks = useMemo(() => parseMarkdownBlocks(content), [content]);

  return (
    <div className={`space-y-2.5 ${isUser ? "markdown-user" : "markdown-assistant"}`}>
      {blocks.map((block, index) => renderMarkdownBlock(block, index, isUser))}
    </div>
  );
}

function ReferencedMemories({ memories }: { memories: MemoryRecord[] }) {
  return (
    <details className="mt-3 rounded-2xl border border-line bg-mist/35 px-3 py-2 text-xs text-ink-soft">
      <summary className="cursor-pointer select-none text-ink-faint">
        本轮参考的记忆（{memories.length}）
      </summary>
      <div className="mt-2 space-y-2">
        {memories.slice(0, 6).map((memory) => (
          <div key={memory.id} className="rounded-xl bg-card/70 px-2.5 py-2">
            <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-faint">
              <span>{memoryTypeLabels[memory.type]}</span>
              <span>重要度 {memory.importance}</span>
              <span>{formatMemoryDate(memory.lastSeenAt)}</span>
            </div>
            <p className="leading-5 text-ink-soft">{memory.content}</p>
          </div>
        ))}
      </div>
    </details>
  );
}

function TimeboxLetterDrawer({
  open,
  letters,
  selectedLetterId,
  onSelect,
  onClose,
}: {
  open: boolean;
  letters: TimeboxLetter[];
  selectedLetterId: string | null;
  onSelect: (letterId: string) => void;
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

  const selectedLetter = letters.find((letter) => letter.id === selectedLetterId) ?? null;

  if (!open) return null;

  return (
    <div
      className="animate-veil fixed inset-0 z-50"
    >
      <button
        type="button"
        className="absolute inset-0 bg-pine-deep/25 backdrop-blur-[2px]"
        onClick={onClose}
        aria-label="关闭时光信箱"
      />
      <aside
        className="animate-panel-left fixed left-0 top-0 flex h-full w-full max-w-md flex-col border-r border-line bg-paper shadow-[24px_0_60px_rgba(34,57,42,0.18)]"
        role="dialog"
        aria-modal="true"
        aria-label="时光信箱"
      >
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-line px-5">
          <div className="min-w-0">
            <h2 className="font-display text-lg tracking-wide text-ink">时光信箱</h2>
            <p className="mt-0.5 text-xs text-ink-faint">过去的片段，会在这里慢慢沉下来。</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-soft transition hover:bg-mist"
            aria-label="关闭"
          >
            <X size={17} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <nav className="w-24 shrink-0 overflow-y-auto border-r border-line bg-mist/35 px-2 py-4">
            {letters.length === 0 ? (
              <p className="px-2 pt-2 text-center text-[11px] leading-5 text-ink-faint">还没有信</p>
            ) : (
              <div className="space-y-2">
                {letters.map((letter) => {
                  const selected = letter.id === selectedLetter?.id;

                  return (
                    <button
                      key={letter.id}
                      type="button"
                      onClick={() => onSelect(letter.id)}
                      className={`relative w-full rounded-xl px-2 py-2 text-left transition ${
                        selected
                          ? "bg-card text-pine-deep shadow-[0_2px_12px_rgba(63,58,38,0.08)]"
                          : "text-ink-faint hover:bg-card/70 hover:text-ink-soft"
                      }`}
                      tabIndex={open ? 0 : -1}
                    >
                      {!letter.isRead ? (
                        <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-clay" aria-hidden />
                      ) : null}
                      <span className="block text-xs font-medium">{formatLetterMonthDay(letter.createdAt)}</span>
                      <span className="mt-0.5 block text-[10px]">{formatLetterYear(letter.createdAt)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </nav>

          <section className="min-w-0 flex-1 overflow-y-auto px-6 py-6">
            {selectedLetter ? (
              <article className="mx-auto max-w-[32rem] animate-rise">
                <p className="mb-5 text-xs text-ink-faint">{formatLetterFullDate(selectedLetter.createdAt)}</p>
                <div className="font-display text-[22px] leading-9 text-pine-deep">给这段时间的你</div>
                <div className="mt-6 text-[15px] leading-8 text-ink">
                  <MarkdownMessage content={selectedLetter.content} isUser={false} />
                </div>
              </article>
            ) : (
              <div className="flex h-full min-h-[360px] flex-col items-center justify-center text-center">
                <span className="flex h-14 w-14 items-center justify-center rounded-full border border-line bg-card text-pine shadow-[0_10px_36px_rgba(34,57,42,0.10)]">
                  <Leaf size={22} strokeWidth={1.5} />
                </span>
                <p className="mt-4 font-display text-lg tracking-wide text-ink">选一封信慢慢看</p>
                <p className="mt-2 max-w-56 text-sm leading-6 text-ink-faint">
                  信会在后台生成，不会打断聊天。
                </p>
              </div>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}

function renderMarkdownBlock(block: MarkdownBlock, index: number, isUser: boolean) {
  if (block.type === "heading") {
    const className = "text-[15px] font-semibold leading-7";
    const children = renderInlineMarkdown(block.text, isUser);

    if (block.level === 1) return <h3 key={index} className={className}>{children}</h3>;
    if (block.level === 2) return <h4 key={index} className={className}>{children}</h4>;
    return <h5 key={index} className={className}>{children}</h5>;
  }

  if (block.type === "unordered-list") {
    return (
      <ul key={index} className="space-y-1 pl-4">
        {block.items.map((item, itemIndex) => (
          <li key={itemIndex} className="list-disc whitespace-normal">
            {renderInlineMarkdown(item, isUser)}
          </li>
        ))}
      </ul>
    );
  }

  if (block.type === "ordered-list") {
    return (
      <ol key={index} className="space-y-1 pl-4">
        {block.items.map((item, itemIndex) => (
          <li key={itemIndex} className="list-decimal whitespace-normal">
            {renderInlineMarkdown(item, isUser)}
          </li>
        ))}
      </ol>
    );
  }

  if (block.type === "blockquote") {
    return (
      <blockquote
        key={index}
        className={`border-l-2 pl-3 italic ${
          isUser ? "border-[#f4f7ee]/50 text-[#f4f7ee]/90" : "border-line-strong text-ink-soft"
        }`}
      >
        {renderInlineMarkdown(block.lines.join("\n"), isUser)}
      </blockquote>
    );
  }

  if (block.type === "code") {
    return (
      <pre
        key={index}
        className={`max-w-full overflow-x-auto rounded-xl px-3 py-2 text-xs leading-5 ${
          isUser ? "bg-[#203527] text-[#f4f7ee]" : "bg-mist/70 text-ink"
        }`}
      >
        <code>{block.content}</code>
      </pre>
    );
  }

  return (
    <p key={index} className="whitespace-pre-wrap">
      {renderInlineMarkdown(block.lines.join("\n"), isUser)}
    </p>
  );
}

function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let codeLines: string[] = [];
  let codeLanguage = "";
  let inCode = false;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", lines: paragraph });
    paragraph = [];
  };

  for (const line of lines) {
    const fence = line.match(/^```(\w+)?\s*$/);

    if (fence) {
      if (inCode) {
        blocks.push({ type: "code", language: codeLanguage, content: codeLines.join("\n") });
        codeLines = [];
        codeLanguage = "";
        inCode = false;
      } else {
        flushParagraph();
        inCode = true;
        codeLanguage = fence[1] ?? "";
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      const previous = blocks[blocks.length - 1];
      if (previous?.type === "unordered-list") {
        previous.items.push(unordered[1].trim());
      } else {
        blocks.push({ type: "unordered-list", items: [unordered[1].trim()] });
      }
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      const previous = blocks[blocks.length - 1];
      if (previous?.type === "ordered-list") {
        previous.items.push(ordered[1].trim());
      } else {
        blocks.push({ type: "ordered-list", items: [ordered[1].trim()] });
      }
      continue;
    }

    const quote = line.match(/^\s*>\s?(.+)$/);
    if (quote) {
      flushParagraph();
      const previous = blocks[blocks.length - 1];
      if (previous?.type === "blockquote") {
        previous.lines.push(quote[1].trim());
      } else {
        blocks.push({ type: "blockquote", lines: [quote[1].trim()] });
      }
      continue;
    }

    paragraph.push(line);
  }

  if (inCode) {
    blocks.push({ type: "code", language: codeLanguage, content: codeLines.join("\n") });
  }
  flushParagraph();

  return blocks.length > 0 ? blocks : [{ type: "paragraph", lines: [content] }];
}

function renderInlineMarkdown(text: string, isUser: boolean): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^\s)]+)\)|\*[^*\n]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));

    const token = match[0];
    const key = `${match.index}-${token}`;

    if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(<strong key={key}>{renderInlineMarkdown(token.slice(2, -2), isUser)}</strong>);
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code
          key={key}
          className={`rounded-md px-1 py-0.5 text-[0.9em] ${
            isUser ? "bg-[#203527] text-[#f4f7ee]" : "bg-mist text-ink"
          }`}
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("[") && match[2]) {
      const label = token.slice(1, token.indexOf("]("));
      const href = sanitizeMarkdownHref(match[2]);
      nodes.push(
        href ? (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4"
          >
            {label}
          </a>
        ) : (
          label
        ),
      );
    } else if (token.startsWith("*") && token.endsWith("*")) {
      nodes.push(<em key={key}>{renderInlineMarkdown(token.slice(1, -1), isUser)}</em>);
    } else {
      nodes.push(token);
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function sanitizeMarkdownHref(href: string) {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
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

function formatLetterMonthDay(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--/--";

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatLetterYear(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "----";

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
  }).format(date);
}

function formatLetterFullDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(date);
}

function toDisplayMessages(messages: StoredChatMessage[]): Message[] {
  if (messages.length === 0) return initialMessages;

  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content:
      message.role === "user"
        ? sanitizeVisionDisplayContent(message.content)
        : stripInternalMetadataFromContent(message.content),
  }));
}

function stripInternalMetadataFromContent(content: string): string {
  return content
    .replace(/<\/?internal_(?:message|memory)_metadata\b[^>]*\/?>/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeVisionDisplayContent(content: string) {
  const looksLikeVisionContext =
    content.startsWith("[User uploaded an image.") ||
    content.includes("[\u7528\u6237\u4e0a\u4f20\u4e86\u4e00\u5f20\u56fe\u7247") ||
    (content.startsWith("[") && content.includes("\n\n[") && content.length > 120);

  if (!looksLikeVisionContext) {
    return content;
  }

  const captionMarker = content.match(/\n\n\[[^\]\n]+\]\n/);
  const caption = captionMarker
    ? content.slice((captionMarker.index ?? 0) + captionMarker[0].length).trim()
    : "";
  const displayCaption =
    caption && !caption.includes("\u7528\u6237\u6ca1\u6709\u8f93\u5165\u914d\u6587")
      ? caption
      : "\u8bf7\u770b\u770b\u8fd9\u5f20\u56fe\u7247\u3002";

  return `\u3010\u56fe\u7247\u3011${displayCaption}`;
}

function sanitizeChatThread(thread: ChatThread): ChatThread {
  return {
    ...thread,
    title: sanitizeVisionDisplayContent(thread.title),
  };
}

function sanitizeChatThreads(threads: ChatThread[]): ChatThread[] {
  return threads.map(sanitizeChatThread);
}

function readTabState(legacyActiveThreadId?: string, legacyRouteLabel?: string): TabState {
  const raw = safeGetStorageItem("session", tabStateStorageKey);

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<TabState>;
      return {
        activeThreadId: typeof parsed.activeThreadId === "string" ? parsed.activeThreadId : undefined,
        routeLabel: typeof parsed.routeLabel === "string" ? parsed.routeLabel : undefined,
      };
    } catch {
      safeRemoveStorageItem("session", tabStateStorageKey);
    }
  }

  if (legacyActiveThreadId || legacyRouteLabel) {
    const migrated = {
      activeThreadId: legacyActiveThreadId,
      routeLabel: legacyRouteLabel,
    };
    safeSetStorageItem("session", tabStateStorageKey, JSON.stringify(migrated));
    return migrated;
  }

  return {};
}

function readClientRecoveryState(): ClientRecoveryState | null {
  const raw = safeGetStorageItem("local", clientRecoveryStorageKey);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<ClientRecoveryState>;
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages.filter(
          (message): message is Pick<Message, "role" | "content"> =>
            (message?.role === "user" || message?.role === "assistant") &&
            typeof message.content === "string" &&
            message.content.trim().length > 0,
        )
      : [];
    const recovery: ClientRecoveryState = {
      threadId: typeof parsed.threadId === "string" ? parsed.threadId : undefined,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
      messages,
    };

    if (!isClientRecoveryActive(recovery, recovery.threadId)) {
      safeRemoveStorageItem("local", clientRecoveryStorageKey);
      return null;
    }

    return recovery;
  } catch {
    safeRemoveStorageItem("local", clientRecoveryStorageKey);
    return null;
  }
}

function isClientRecoveryActive(recovery: ClientRecoveryState | null, threadId?: string): boolean {
  if (!recovery || recovery.messages.length === 0) return false;
  if (isClientRecoveryExpired(recovery)) return false;
  return Boolean(recovery.threadId && threadId && recovery.threadId === threadId);
}

function isClientRecoveryExpired(recovery: ClientRecoveryState) {
  return Date.now() - recovery.createdAt > clientRecoveryTtlMs;
}

function latestAssistantContent(messages: StoredChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.content.trim()) return message.content;
  }

  return null;
}

function proactiveGreetingLockKey(threadId: string) {
  return `${proactiveGreetingStoragePrefix}:${threadId}`;
}

async function compressImageToJpegBase64(file: File): Promise<string> {
  const image = await loadImage(file);
  const maxSide = 1024;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) throw new Error("Canvas is not available");

  canvas.width = width;
  canvas.height = height;
  context.drawImage(image, 0, 0, width, height);

  return canvas.toDataURL("image/jpeg", 0.82);
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Image failed to load"));
    };
    image.src = url;
  });
}

async function readChatStream(
  response: Response,
  handlers: {
    onRoute: (label: string) => void;
    onStatus: (label: string) => void;
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
    onStatus: (label: string) => void;
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

  if (event.type === "status") {
    handlers.onStatus(event.status.label);
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

function SettingsInput({
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs text-ink-faint">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        type={type}
        autoComplete={autoComplete}
        className="min-h-10 w-full rounded-xl border border-line bg-paper px-3 text-sm text-ink outline-none transition placeholder:text-ink-faint focus:border-line-strong"
      />
    </label>
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

function UsageEvent({ record }: { record: UsageRecord }) {
  return (
    <div className="rounded-xl border border-line bg-mist/35 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-xs text-ink-soft">
          {formatUsageOperation(record.operation)} · {record.provider}
        </p>
        <span className={`shrink-0 text-[11px] ${record.success ? "text-pine" : "text-clay"}`}>
          {record.success ? "成功" : "失败"}
        </span>
      </div>
      <p className="mt-1 truncate font-mono text-[11px] text-ink-faint">
        {formatLatency(record.latencyMs)}
        {record.totalTokens ? ` · ${formatCompact(record.totalTokens)} tokens` : ""}
        {record.statusCode ? ` · ${record.statusCode}` : ""}
      </p>
    </div>
  );
}

function formatUsageOperation(value: string) {
  const labels: Record<string, string> = {
    chat: "聊天",
    memory_extract: "记忆抽取",
    memory_extract_result: "记忆结果",
    title_summarize: "标题生成",
    reality_search_decision: "联网判定",
    web_search: "联网搜索",
    holiday_lookup: "节假日",
    timebox_letter: "时光信箱",
  };

  labels.vision_extract = "识图";

  return labels[value] ?? value;
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
