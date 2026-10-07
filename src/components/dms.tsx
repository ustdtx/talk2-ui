"use client";

import * as React from "react";
import { ArrowLeft } from "lucide-react";
import {
  ApiError,
  getDMThread,
  listDMs,
  sendDM,
  type DMMessage,
  type DMThread,
} from "@/lib/api";
import { Talk2Socket } from "@/lib/socket";
import { onDMOpen } from "@/lib/dm-bus";
import { useSession } from "@/context/session";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

// Revamped Talk (plan F5): online-only 1:1 chats.
// List shows username + last message (bold = unread); chat is clean
// left/right bubbles (theirs left, mine right), newest at the bottom.
// Threads vanish when either side goes offline. Chats can only start from
// a feed Talk button — no search, no manual user-id entry.
export function DMs({ target }: { target?: { id: number; username: string } | null }) {
  const { token, user } = useSession();
  const [threads, setThreads] = React.useState<DMThread[]>([]);
  const [active, setActive] = React.useState<DMThread | null>(null);
  const [messages, setMessages] = React.useState<DMMessage[]>([]);
  const [unread, setUnread] = React.useState<Set<number>>(new Set());
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const cardRef = React.useRef<HTMLDivElement>(null);

  const loadThreads = React.useCallback(async () => {
    if (!token) return;
    try {
      const res = await listDMs(token);
      setThreads(res.threads);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "dms failed");
    }
  }, [token]);

  const loadMessages = React.useCallback(
    async (withId: number) => {
      if (!token) return;
      try {
        const res = await getDMThread(token, withId);
        setMessages(res.messages);
        setError(null);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 410 || err.status === 422)) {
          // Counterpart offline: thread gone (plan decision 3).
          setMessages([]);
          setActive(null);
          loadThreads();
          return;
        }
        setError(err instanceof ApiError ? err.message : "thread failed");
      }
    },
    [token, loadThreads],
  );

  React.useEffect(() => {
    loadThreads();
  }, [loadThreads]);

  const openThread = React.useCallback(
    (t: DMThread) => {
      setActive(t);
      setUnread((prev) => {
        if (!prev.has(t.with_user_id)) return prev;
        const next = new Set(prev);
        next.delete(t.with_user_id);
        return next;
      });
      loadMessages(t.with_user_id);
    },
    [loadMessages],
  );

  // Opened from a post's Talk button (plan 3.4: viewer -> poster).
  const openTarget = React.useCallback(
    (t: { id: number; username: string }) => {
      openThread({
        with_user_id: t.id,
        with_username: t.username,
        last_text: "",
        last_at: "",
        message_count: 0,
      });
    },
    [openThread],
  );

  React.useEffect(() => {
    if (target) openTarget(target);
  }, [target, openTarget]);

  React.useEffect(() => {
    return onDMOpen((t) => openTarget(t));
  }, [openTarget]);

  // Keep the open thread's display name fresh once the server lists it.
  React.useEffect(() => {
    if (!active) return;
    const known = threads.find((t) => t.with_user_id === active.with_user_id);
    if (known && known.with_username !== active.with_username) {
      setActive((prev) => (prev ? { ...prev, with_username: known.with_username } : prev));
    }
  }, [threads, active]);

  // Newest at the bottom: pin the message list after paint, and bring
  // the chat into view when a thread opens so the sender sits at the
  // bottom of the screen.
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, active]);
  const activeId = active?.with_user_id ?? null;
  React.useEffect(() => {
    cardRef.current?.scrollIntoView({ block: "end" });
  }, [activeId]);

  // Live updates: dm:receive (+dm:new alias), dm:thread_retracted, offline.
  React.useEffect(() => {
    if (!token) return;
    const socket = new Talk2Socket(() => token);
    const off = socket.on((ev) => {
      const pl = (ev.payload ?? {}) as Record<string, unknown>;
      if (ev.type === "dm:receive" || ev.type === "dm:new") {
        loadThreads();
        const from = pl.from_id as number;
        const to = pl.to_id as number;
        if (active && (from === active.with_user_id || to === active.with_user_id)) {
          loadMessages(active.with_user_id);
        } else if (typeof from === "number" && user && from !== user.id) {
          // Message for a thread we're not viewing: bold it in the list.
          setUnread((prev) => new Set(prev).add(from));
        }
      } else if (ev.type === "dm:thread_retracted") {
        const gone = pl.with_user_id as number;
        setThreads((prev) => prev.filter((t) => t.with_user_id !== gone));
        setUnread((prev) => {
          if (!prev.has(gone)) return prev;
          const next = new Set(prev);
          next.delete(gone);
          return next;
        });
        if (active && active.with_user_id === gone) {
          setActive(null);
          setMessages([]);
        }
      } else if (ev.type === "presence:offline" || ev.type === "presence:update") {
        loadThreads();
      }
    });
    socket.connect();
    return () => {
      off();
      socket.close();
    };
  }, [token, active, user, loadThreads, loadMessages]);

  async function send() {
    if (!token || busy || !active) return;
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    try {
      await sendDM(token, { to_user_id: active.with_user_id, text });
      setDraft("");
      setError(null);
      await loadThreads();
      await loadMessages(active.with_user_id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not send (are they still online?)");
    } finally {
      setBusy(false);
    }
  }

  // --- Chat view: back + bubbles, newest at bottom, sender pinned ---
  if (active) {
    return (
      <div ref={cardRef}>
      <Card className="flex h-[calc(100dvh-320px)] min-h-[380px] flex-col">
        <CardHeader className="flex shrink-0 flex-row items-center gap-2 pb-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="back to conversations"
            onClick={() => {
              setActive(null);
              setMessages([]);
              loadThreads();
            }}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <span className="text-sm font-semibold">@{active.with_username}</span>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-2">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
            <div className="mt-auto flex flex-col gap-1.5">
            {messages.map((m) => {
              const mine = user != null && m.from_id === user.id;
              return (
                <div
                  key={m.id}
                  title={m.created_at}
                  className={`max-w-[80%] rounded-2xl px-3 py-1.5 text-sm whitespace-pre-wrap ${
                    mine
                      ? "bg-primary text-primary-foreground self-end rounded-br-sm"
                      : "bg-muted self-start rounded-bl-sm"
                  }`}
                >
                  {m.text}
                </div>
              );
            })}
            {messages.length === 0 && (
              <p className="text-muted-foreground text-xs">
                Nothing here — say hi while they&apos;re still online.
              </p>
            )}
            </div>
          </div>
          {error && <p className="text-destructive text-xs">{error}</p>}
          <div className="flex shrink-0 gap-2 border-t pt-2">
            <Input
              placeholder="message…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") send();
              }}
            />
            <Button type="button" onClick={send} disabled={busy || !draft.trim()}>
              Send
            </Button>
          </div>
        </CardContent>
      </Card>
      </div>
    );
  }

  // --- List view: username + last message, bold = unread ---
  return (
    <Card>
      <CardHeader className="pb-2 text-sm font-semibold">Talk — online only</CardHeader>
      <CardContent className="flex flex-col gap-1">
        <p className="text-muted-foreground pb-1 text-xs">
          DMs exist only while both sides are online. Start one from a Talk button in the stream.
        </p>
        {error && <p className="text-destructive text-xs">{error}</p>}
        {threads.length === 0 && (
          <p className="text-muted-foreground text-xs">No live conversations.</p>
        )}
        {threads.map((t) => {
          const isUnread = unread.has(t.with_user_id);
          return (
            <button
              key={t.with_user_id}
              type="button"
              onClick={() => openThread(t)}
              className="rounded-md border p-2 text-left"
            >
              <span className={`block text-sm ${isUnread ? "font-bold" : "font-semibold"}`}>
                @{t.with_username}
              </span>
              <span
                className={`block truncate text-sm ${isUnread ? "font-bold" : "text-muted-foreground"}`}
              >
                {t.last_text}
              </span>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}
