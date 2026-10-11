"use client";

import * as React from "react";
import { ImagePlus, X } from "lucide-react";
import { ApiError, addComment, getComments, uploadImage, type ThreadedComment } from "@/lib/api";
import { useSession } from "@/context/session";
import { useThreadEvents } from "@/components/feed-view";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

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

function CommentImages({ images }: { images: { key: string; url: string }[] }) {
  if (!images || images.length === 0) return null;
  return (
    <span
      className={`mt-1 grid gap-1 ${images.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}
    >
      {images.map((im) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={im.key}
          src={im.url}
          alt=""
          loading="lazy"
          className="max-h-48 w-full rounded-md object-cover"
        />
      ))}
    </span>
  );
}

// Live comment thread for one post (plan F4). Top-level oldest-first with
// one-level replies. New comments arrive over the socket (comment:new via
// the feed's thread bus) and refetch instantly; retracts drop the same way.
// The parent card vanishes via post:retracted when the post is gone.
export function Comments({
  postId,
  open,
}: {
  postId: number;
  open: boolean;
}) {
  const { token, user } = useSession();
  const [threads, setThreads] = React.useState<ThreadedComment[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const [picks, setPicks] = React.useState<Pick[]>([]);
  const [replyTo, setReplyTo] = React.useState<{ id: number; name: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
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

  const load = React.useCallback(async () => {
    if (!token) return;
    try {
      const res = await getComments(token, postId);
      setThreads(res.comments);
      setError(null);
    } catch (err) {
      // 404/410 = post gone (author offline or deleted): parent card will
      // vanish via post:retracted; keep quiet instead of erroring.
      if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
        setThreads([]);
        return;
      }
      setError(err instanceof ApiError ? err.message : "comments failed");
    }
  }, [token, postId]);

  React.useEffect(() => {
    if (open) load();
  }, [open, load]);

  // Live updates only — no polling. comment:new / comment:retracted for
  // this post arrive via the thread bus below.
  useThreadEvents(
    postId,
    React.useCallback(() => load(), [load]),
  );

  async function send() {
    if (!token || !user || busy) return;
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
      await addComment(token, postId, {
        text,
        image_keys: keys,
        parent_id: replyTo?.id,
      });
      picks.forEach((p) => URL.revokeObjectURL(p.preview));
      setPicks([]);
      setDraft("");
      setReplyTo(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not comment");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t pt-2">
      {open && (
        <div className="flex flex-col gap-3">
          {error && <p className="text-destructive text-xs">{error}</p>}
          {threads.length === 0 && !error && (
            <p className="text-muted-foreground text-xs">No comments yet — start it.</p>
          )}
          {threads.map((t) => (
            <div key={t.id} className="flex flex-col gap-1">
              <p className="text-sm">
                <span className="font-semibold">@{t.author_username}</span>{" "}
                <span className="whitespace-pre-wrap">{t.text}</span>
              </p>
              <CommentImages images={t.images} />
              <button
                type="button"
                className="text-muted-foreground self-start text-[11px] hover:underline"
                onClick={() => setReplyTo({ id: t.id, name: t.author_username })}
              >
                reply
              </button>
              {t.replies.map((r) => (
                <div key={r.id} className="flex flex-col gap-1 pl-4">
                  <p className="text-sm">
                    <span className="font-semibold">@{r.author_username}</span>{" "}
                    {r.reply_to_name && (
                      <span className="text-muted-foreground">→ @{r.reply_to_name} </span>
                    )}
                    <span className="whitespace-pre-wrap">{r.text}</span>
                  </p>
                  <CommentImages images={r.images} />
                  <button
                    type="button"
                    className="text-muted-foreground self-start text-[11px] hover:underline"
                    onClick={() => setReplyTo({ id: r.id, name: r.author_username })}
                  >
                    reply
                  </button>
                </div>
              ))}
            </div>
          ))}
          <div className="flex flex-col gap-2">
            {replyTo && (
              <p className="text-muted-foreground text-xs">
                Replying in @{replyTo.name}&apos;s thread{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => setReplyTo(null)}
                >
                  cancel
                </button>
              </p>
            )}
            <Textarea
              rows={2}
              placeholder={replyTo ? `reply to @${replyTo.name}…` : "join the discussion…"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
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
            <div className="flex items-center gap-2">
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
              <Button type="button" size="sm" onClick={send} disabled={busy || (!draft.trim() && picks.length === 0)} className="flex-1">
                {busy ? "…" : "Comment"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
