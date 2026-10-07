"use client";

import { MessageCircle, MessagesSquare, Trash2 } from "lucide-react";
import { useState } from "react";
import { deletePost, type Post } from "@/lib/api";
import { requestDMOpen } from "@/lib/dm-bus";
import { useSession } from "@/context/session";
import { Comments } from "@/components/comments";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function PostCard({ post }: { post: Post }) {
  const { token, user } = useSession();
  const mine = user != null && user.id === post.author_id;
  const [commentsOpen, setCommentsOpen] = useState(false);

  async function remove() {
    if (!token || !mine) return;
    try {
      await deletePost(token, post.id);
    } catch {
      // Socket post:retracted removes the card; a failure just leaves it.
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-baseline justify-between gap-2 pb-2">
        <span className="font-semibold">@{post.author_username}</span>
        <span className="text-muted-foreground flex items-center gap-2 text-xs whitespace-nowrap">
          {timeAgo(post.created_at)}
          {mine && (
            <button type="button" aria-label="delete post" onClick={remove} className="hover:text-foreground">
              <Trash2 className="size-3.5" />
            </button>
          )}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {post.text !== "" && (
          <p className="text-sm whitespace-pre-wrap">{post.text}</p>
        )}
        {post.images.length > 0 && (
          <div
            className={`grid gap-2 ${post.images.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}
          >
            {post.images.map((im) => (
              // Plain img: R2 URLs are external, no remotePatterns needed.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={im.key}
                src={im.url}
                alt=""
                loading="lazy"
                className="max-h-72 w-full rounded-md object-cover"
              />
            ))}
          </div>
        )}
        <div className="text-muted-foreground flex items-center justify-between gap-4 text-xs">
          <span className="flex items-center gap-4">
            <button
              type="button"
              aria-label={`${post.comment_count ?? 0} comments`}
              aria-expanded={commentsOpen}
              onClick={() => setCommentsOpen((open) => !open)}
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              <MessageCircle className="size-3.5" />
              {post.comment_count ?? 0}
            </button>
          </span>
          {!mine && (
            <button
              type="button"
              aria-label={`talk to @${post.author_username}`}
              onClick={() =>
                requestDMOpen({ id: post.author_id, username: post.author_username })
              }
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 font-medium hover:text-foreground"
            >
              <MessagesSquare className="size-3.5" />
              Talk
            </button>
          )}
        </div>
        <Comments postId={post.id} open={commentsOpen} />
      </CardContent>
    </Card>
  );
}
