"use client";

import { FormEvent, useMemo, useState } from "react";
import { ArrowRight, Check, KeyRound, Leaf, Lock, ServerCog } from "lucide-react";

type SetupForm = {
  treeholeAccessToken: string;
  treeholeSessionSecret: string;
  treeholeCookieSecure: boolean;
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  siliconFlowApiKey: string;
  siliconFlowBaseUrl: string;
  siliconFlowRerankModel: string;
  tavilyApiKey: string;
  braveSearchApiKey: string;
  visionApiKey: string;
  visionBaseUrl: string;
  visionModelName: string;
  realityCountryCode: string;
};

const steps = [
  { title: "入口", icon: Lock },
  { title: "模型", icon: KeyRound },
  { title: "增强", icon: ServerCog },
];

const initialForm: SetupForm = {
  treeholeAccessToken: "",
  treeholeSessionSecret: "",
  treeholeCookieSecure: false,
  deepseekApiKey: "",
  deepseekBaseUrl: "https://api.deepseek.com",
  siliconFlowApiKey: "",
  siliconFlowBaseUrl: "https://api.siliconflow.cn/v1",
  siliconFlowRerankModel: "Qwen/Qwen3-Reranker-0.6B",
  tavilyApiKey: "",
  braveSearchApiKey: "",
  visionApiKey: "",
  visionBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
  visionModelName: "gemini-3.1-pro-preview",
  realityCountryCode: "CN",
};

function getInitialForm(): SetupForm {
  if (typeof window === "undefined") return initialForm;

  return {
    ...initialForm,
    treeholeCookieSecure: window.location.protocol === "https:",
  };
}

export function SetupWizard() {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<SetupForm>(getInitialForm);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const canContinue = useMemo(() => {
    if (step === 0) return form.treeholeAccessToken.trim().length >= 8;
    if (step === 1) return form.deepseekApiKey.trim().length >= 8 && isUrl(form.deepseekBaseUrl);
    return (
      isUrl(form.siliconFlowBaseUrl) &&
      form.siliconFlowRerankModel.trim().length > 0 &&
      isUrl(form.visionBaseUrl) &&
      form.visionModelName.trim().length > 0 &&
      /^[A-Za-z]{2}$/.test(form.realityCountryCode.trim())
    );
  }, [form, step]);

  function update<Key extends keyof SetupForm>(key: Key, value: SetupForm[Key]) {
    setForm((current) => ({ ...current, [key]: value }));
    setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step < steps.length - 1) {
      setStep((current) => current + 1);
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      const response = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (!response.ok) {
        setError("保存失败，检查字段后再试一次。");
        return;
      }

      window.location.assign("/login");
    } finally {
      setSubmitting(false);
    }
  }

  const ActiveIcon = steps[step].icon;

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-8 text-ink">
      <div className="animate-rise w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-4 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-pine text-card shadow-[0_10px_36px_rgba(34,57,42,0.3)]">
            <Leaf size={26} strokeWidth={1.5} />
          </span>
          <div className="space-y-1.5">
            <h1 className="font-display text-2xl tracking-wide text-pine-deep">树洞初始化</h1>
            <p className="text-sm text-ink-faint">只出现一次。</p>
          </div>
        </div>

        <form
          onSubmit={submit}
          className={`rounded-3xl border border-line bg-card p-5 shadow-[0_18px_60px_rgba(63,58,38,0.14)] ${
            error ? "animate-shake" : ""
          }`}
        >
          <div className="mb-5 flex items-center justify-between">
            {steps.map((item, index) => {
              const Icon = item.icon;
              const active = index === step;
              const done = index < step;

              return (
                <button
                  key={item.title}
                  type="button"
                  onClick={() => {
                    if (index <= step) setStep(index);
                  }}
                  className={`flex h-10 min-w-0 items-center gap-2 rounded-full px-3 text-sm transition ${
                    active || done ? "bg-moss text-pine-deep" : "text-ink-faint"
                  }`}
                  aria-current={active ? "step" : undefined}
                >
                  {done ? <Check size={14} /> : <Icon size={14} />}
                  <span className="truncate">{item.title}</span>
                </button>
              );
            })}
          </div>

          <div className="mb-5 flex items-center gap-2 text-sm text-ink-soft">
            <ActiveIcon size={15} className="text-pine" />
            <span>{steps[step].title}</span>
          </div>

          {step === 0 ? (
            <div className="space-y-3">
              <Field
                label="进入口令"
                value={form.treeholeAccessToken}
                onChange={(value) => update("treeholeAccessToken", value)}
                type="password"
                autoComplete="new-password"
              />
              <Field
                label="会话密钥"
                value={form.treeholeSessionSecret}
                onChange={(value) => update("treeholeSessionSecret", value)}
                type="password"
                autoComplete="new-password"
                placeholder="留空自动生成"
              />
              <label className="flex items-center justify-between rounded-2xl border border-line bg-mist/40 px-3.5 py-3 text-sm text-ink-soft">
                <span>HTTPS Cookie</span>
                <input
                  type="checkbox"
                  checked={form.treeholeCookieSecure}
                  onChange={(event) => update("treeholeCookieSecure", event.target.checked)}
                  className="h-4 w-4 accent-pine"
                />
              </label>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="space-y-3">
              <Field
                label="DeepSeek Key"
                value={form.deepseekApiKey}
                onChange={(value) => update("deepseekApiKey", value)}
                type="password"
                autoComplete="off"
              />
              <Field label="DeepSeek Base URL" value={form.deepseekBaseUrl} onChange={(value) => update("deepseekBaseUrl", value)} />
            </div>
          ) : null}

          {step === 2 ? (
            <div className="space-y-3">
              <Field
                label="SiliconFlow Key"
                value={form.siliconFlowApiKey}
                onChange={(value) => update("siliconFlowApiKey", value)}
                type="password"
                autoComplete="off"
                placeholder="可留空"
              />
              <Field
                label="SiliconFlow Base URL"
                value={form.siliconFlowBaseUrl}
                onChange={(value) => update("siliconFlowBaseUrl", value)}
              />
              <Field
                label="Rerank Model"
                value={form.siliconFlowRerankModel}
                onChange={(value) => update("siliconFlowRerankModel", value)}
              />
              <Field
                label="Tavily Search Key"
                value={form.tavilyApiKey}
                onChange={(value) => update("tavilyApiKey", value)}
                type="password"
                autoComplete="off"
                placeholder="可留空"
              />
              <Field
                label="Brave Search Key"
                value={form.braveSearchApiKey}
                onChange={(value) => update("braveSearchApiKey", value)}
                type="password"
                autoComplete="off"
                placeholder="可留空"
              />
              <Field
                label="Vision Key"
                value={form.visionApiKey}
                onChange={(value) => update("visionApiKey", value)}
                type="password"
                autoComplete="off"
                placeholder="optional"
              />
              <Field
                label="Vision Base URL"
                value={form.visionBaseUrl}
                onChange={(value) => update("visionBaseUrl", value)}
              />
              <Field
                label="Vision Model"
                value={form.visionModelName}
                onChange={(value) => update("visionModelName", value)}
              />
              <Field
                label="Reality Country Code"
                value={form.realityCountryCode}
                onChange={(value) => update("realityCountryCode", value.toUpperCase())}
                placeholder="CN"
              />
            </div>
          ) : null}

          <p className="mt-3 min-h-5 text-sm text-clay" aria-live="polite">
            {error}
          </p>

          <button
            type="submit"
            disabled={!canContinue || submitting}
            className="mt-2 inline-flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-pine px-4 text-sm text-card shadow-[0_4px_14px_rgba(34,57,42,0.3)] transition hover:bg-pine-deep active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-line-strong disabled:shadow-none"
          >
            {step === steps.length - 1 ? "完成" : "继续"}
            <ArrowRight size={16} />
          </button>
        </form>
      </div>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs text-ink-faint">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        type={type}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="min-h-11 w-full rounded-2xl border border-line bg-mist/50 px-3.5 text-[15px] text-ink outline-none transition placeholder:text-ink-faint focus:border-line-strong focus:bg-card"
      />
    </label>
  );
}

function isUrl(value: string) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
