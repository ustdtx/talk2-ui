"use client";

import * as React from "react";
import { ArrowLeft, ImagePlus, X } from "lucide-react";
import {
  ApiError,
  getDMThread,
  listDMs,
  sendDM,
  uploadImage,
  type DMMessage,
  type DMThread,
} from "@/lib/api";
import { Talk2Socket } from "@/lib/socket";
import { onDMOpen } from "@/lib/dm-bus";
import { useSession } from "@/context/session";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const MAX_IMAGES = 4;

interface Pick {
  file: File;
  preview: string;
}

function extFor(file: File): string {
  if (file.type === "image/png") return ".png";
  if (file.type === "image/webp") return ".webp";
  return ".jpg";
}

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
  const [picks, setPicks] = React.useState<Pick[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const cardRef = React.useRef<HTMLDivElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const fresh: Pick[] = [];
    let err: string | null = null;
    for (const f of files) {
      if (picks.length + fresh.length >= MAX_IMAGES) break;
      if (!["image/jpeg", "image/png", "image/webp"].includes(f.type)) {
        err = "only jpeg, png, webp images allowed";
        continue;
      }
      if (f.size > 5 * 1024 * 1024) {
        err = "each image must be 5 MB or smaller";
        continue;
      }
      fresh.push({ file: f, preview: URL.createObjectURL(f) });
    }
    if (err) setError(err);
    if (fresh.length > 0)
      setPicks((prev) => [...prev, ...fresh].slice(0, MAX_IMAGES));
  }

  function removePick(i: number) {
    setPicks((prev) => {
      URL.revokeObjectURL(prev[i].preview);
      return prev.filter((_, j) => j !== i);
    });
  }

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
        // POC snappy: render the pushed message instantly, refresh list in bg.
        const msg = pl as unknown as DMMessage;
        if (active && typeof msg?.id === "number" &&
          (msg.from_id === active.with_user_id || msg.to_id === active.with_user_id)) {
          setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        }
        loadThreads();
        const from = pl.from_id as number;
        const to = pl.to_id as number;
        if (active && (from === active.with_user_id || to === active.with_user_id)) {
          // Already appended above; background refresh just reconciles.
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
    if (!token || !user || busy || !active) return;
    const text = draft.trim();
    if (!text && picks.length === 0) return;
    setBusy(true);
    try {
      const keys: string[] = [];
      for (const p of picks) {
        const key = `tmp/${user.id}/${crypto.randomUUID()}${extFor(p.file)}`;
        await uploadImage(token, key, p.file);
        keys.push(key);
      }
      const sent = await sendDM(token, { to_user_id: active.with_user_id, text, image_keys: keys });
      // POC snappy: show own message instantly (single REST RTT), reconcile in bg.
      setMessages((prev) => (prev.some((m) => m.id === sent.id) ? prev : [...prev, sent]));
      picks.forEach((p) => URL.revokeObjectURL(p.preview));
      setPicks([]);
      setDraft("");
      setError(null);
      loadThreads();
      loadMessages(active.with_user_id);
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
                  {m.text !== "" ? (
                    <span>{m.text}</span>
                  ) : (
                    (m.images ?? []).length > 0 && (
                      <span className="italic opacity-70">
                        {mine ? "You sent an image" : `@${m.from_username} sent an image`}
                      </span>
                    )
                  )}
                  {(m.images ?? []).length > 0 && (
                    <span className={`mt-1 grid gap-1 ${(m.images ?? []).length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
                      {(m.images ?? []).map((im) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          key={im.key}
                          src={im.url}
                          alt=""
                          loading="lazy"
                          className="max-h-48 w-full rounded-lg object-cover"
                        />
                      ))}
                    </span>
                  )}
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
          {picks.length > 0 && (
            <div className="grid grid-cols-4 gap-2">
              {picks.map((p, i) => (
                <div key={p.preview} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.preview}
                    alt=""
                    className="aspect-square w-full rounded-md object-cover"
                  />
                  <button
                    type="button"
                    aria-label="remove image"
                    onClick={() => removePick(i)}
                    className="bg-background absolute top-1 right-1 rounded-full border p-0.5"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex shrink-0 gap-2 border-t pt-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              className="hidden"
              onChange={(e) => addFiles(e.target.files)}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="attach images"
              onClick={() => fileRef.current?.click()}
              disabled={picks.length >= MAX_IMAGES}
            >
              <ImagePlus className="size-4" />
            </Button>
            <Input
              placeholder="message…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") send();
              }}
            />
            <Button type="button" onClick={send} disabled={busy || (!draft.trim() && picks.length === 0)}>
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
                {t.last_text !== "" ? t.last_text : "📷 sent an image"}
              </span>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}
