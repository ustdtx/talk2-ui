"use client";

import * as React from "react";
import { ApiError, addComment, getComments, type ThreadedComment } from "@/lib/api";
import { useSession } from "@/context/session";
import { useThreadEvents } from "@/components/feed-view";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

// Live comment thread for one post (plan F4). Top-level oldest-first with
// one-level replies. Refetches on comment:new / comment:retracted for this
// post and drops when the post is retracted (parent removes the card).
export function Comments({
  postId,
  open,
}: {
  postId: number;
  open: boolean;
}) {
  const { token } = useSession();
  const [threads, setThreads] = React.useState<ThreadedComment[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const [replyTo, setReplyTo] = React.useState<{ id: number; name: string } | null>(null);
  const [busy, setBusy] = React.useState(false);

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

  useThreadEvents(
    postId,
    React.useCallback(() => load(), [load]),
  );

  async function send() {
    if (!token || busy) return;
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    try {
      await addComment(token, postId, {
        text,
        parent_id: replyTo?.id,
      });
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
            <Button type="button" size="sm" onClick={send} disabled={busy || !draft.trim()}>
              {busy ? "…" : "Comment"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
