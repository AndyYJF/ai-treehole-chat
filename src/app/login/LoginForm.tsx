"use client";

import { FormEvent, useState } from "react";
import { ArrowRight, Leaf, Lock } from "lucide-react";

export function LoginForm() {
  const [token, setToken] = useState("");
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = new URLSearchParams(window.location.search).get("next") ?? "/";

    setSubmitting(true);
    setError(false);

    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });

      if (!response.ok) {
        setError(true);
        return;
      }

      window.location.assign(next.startsWith("/") ? next : "/");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 text-ink">
      <div className="animate-rise w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-4 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-pine text-card shadow-[0_10px_36px_rgba(34,57,42,0.3)]">
            <Leaf size={26} strokeWidth={1.5} />
          </span>
          <div className="space-y-1.5">
            <h1 className="font-display text-2xl tracking-wide text-pine-deep">树洞</h1>
            <p className="text-sm text-ink-faint">一个安静的地方，说什么都可以。</p>
          </div>
        </div>

        <form
          onSubmit={submit}
          className={`rounded-3xl border border-line bg-card p-5 shadow-[0_18px_60px_rgba(63,58,38,0.14)] ${
            error ? "animate-shake" : ""
          }`}
        >
          <label
            htmlFor="token"
            className="mb-3 flex items-center gap-2 text-sm text-ink-soft"
          >
            <Lock size={15} className="text-pine" />
            口令
          </label>

          <div className="flex items-center gap-2 rounded-2xl border border-line bg-mist/50 p-1.5 transition focus-within:border-line-strong focus-within:bg-card">
            <input
              id="token"
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                setError(false);
              }}
              type="password"
              autoFocus
              autoComplete="current-password"
              placeholder="轻声说出口令"
              className="min-h-11 min-w-0 flex-1 bg-transparent px-3 text-[15px] outline-none placeholder:text-ink-faint"
            />
            <button
              type="submit"
              disabled={!token.trim() || submitting}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-pine text-card shadow-[0_4px_14px_rgba(34,57,42,0.3)] transition hover:bg-pine-deep active:scale-95 disabled:cursor-not-allowed disabled:bg-line-strong disabled:shadow-none"
              aria-label="进入"
            >
              <ArrowRight size={18} strokeWidth={1.8} />
            </button>
          </div>

          <p className="mt-3 min-h-5 text-sm text-clay" aria-live="polite">
            {error ? "口令不对，再试一次。" : ""}
          </p>
        </form>

        <p className="mt-6 text-center text-[11px] text-ink-faint">
          进入后，这里只有你和树洞。
        </p>
      </div>
    </main>
  );
}
