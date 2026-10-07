"use client";

import * as React from "react";
import { ApiError, getFeed, getOnline, type Post } from "@/lib/api";
import { Talk2Socket, type SocketEvent } from "@/lib/socket";
import { useSession } from "@/context/session";
import { PostCard } from "@/components/post-card";

// Per-post thread event bus: the shared socket lives here, comment threads
// in PostCards subscribe for live refetch triggers.
type ThreadFn = (ev: SocketEvent) => void;
const ThreadEventsContext = React.createContext<{
  subscribe: (postId: number, fn: ThreadFn) => () => void;
} | null>(null);

export function useThreadEvents(postId: number, fn: ThreadFn) {
  const bus = React.useContext(ThreadEventsContext);
  React.useEffect(() => {
    if (!bus) return;
    return bus.subscribe(postId, fn);
  }, [bus, postId, fn]);
}

export function FeedView({
  onOnlineCount,
  incoming,
}: {
  onOnlineCount: (n: number) => void;
  incoming: Post | null;
}) {
  const { token, logout } = useSession();
  const [posts, setPosts] = React.useState<Post[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const seen = React.useRef(new Set<number>());
  const threadSubs = React.useRef(new Map<number, Set<ThreadFn>>());

  const subscribe = React.useCallback(
    (postId: number, fn: ThreadFn) => {
      let set = threadSubs.current.get(postId);
      if (!set) {
        set = new Set();
        threadSubs.current.set(postId, set);
      }
      set.add(fn);
      return () => {
        set.delete(fn);
      };
    },
    [],
  );

  const bus = React.useMemo(() => ({ subscribe }), [subscribe]);

  const notifyThread = React.useCallback((postId: number, ev: SocketEvent) => {
    threadSubs.current.get(postId)?.forEach((fn) => fn(ev));
  }, []);

  const prepend = React.useCallback((p: Post) => {
    if (seen.current.has(p.id)) return;
    seen.current.add(p.id);
    setPosts((prev) => [p, ...prev]);
  }, []);

  // Optimistic insert from our own composer (socket echo dedupes by id).
  React.useEffect(() => {
    if (incoming) prepend(incoming);
  }, [incoming, prepend]);

  React.useEffect(() => {
    if (!token) return;
    seen.current = new Set<number>();
    let alive = true;
    const socket = new Talk2Socket(() => token);

    const handle = (ev: SocketEvent) => {
      if (!alive) return;
      const pl = (ev.payload ?? {}) as Record<string, unknown>;
      const refreshOnline = () => {
        if (!token) return;
        getOnline(token)
          .then((r) => {
            if (alive) onOnlineCount(r.online.length);
          })
          .catch(() => {});
      };
      switch (ev.type) {
        case "welcome": {
          const online = Array.isArray(pl.online) ? pl.online.length : 0;
          onOnlineCount(online);
          break;
        }
        case "presence:online":
        case "presence:update":
          refreshOnline();
          break;
        case "feed:new_post":
          prepend({
            id: pl.id as number,
            author_id: pl.author_id as number,
            author_username: pl.author_username as string,
            text: pl.text as string,
            images: (pl.images as Post["images"]) ?? [],
            created_at: pl.created_at as string,
          });
          break;
        case "comment:new": {
          const pid = pl.post_id as number;
          if (typeof pid === "number") {
            setPosts((prev) =>
              prev.map((p) =>
                p.id === pid
                  ? { ...p, comment_count: (p.comment_count ?? 0) + 1 }
                  : p,
              ),
            );
            notifyThread(pid, ev);
          }
          break;
        }
        case "comment:retracted": {
          const pid = pl.post_id as number;
          if (typeof pid === "number") {
            setPosts((prev) =>
              prev.map((p) =>
                p.id === pid
                  ? { ...p, comment_count: Math.max(0, (p.comment_count ?? 1) - 1) }
                  : p,
              ),
            );
            notifyThread(pid, ev);
          }
          break;
        }
        case "post:retracted": {
          const pid = pl.post_id as number;
          seen.current.delete(pid);
          setPosts((prev) => prev.filter((p) => p.id !== pid));
          break;
        }
        case "presence:offline": {
          const uid = pl.user_id as number;
          setPosts((prev) => prev.filter((p) => p.author_id !== uid));
          refreshOnline();
          break;
        }
      }
    };

    getFeed(token)
      .then((res) => {
        if (!alive) return;
        res.posts.forEach((p) => seen.current.add(p.id));
        setPosts(res.posts);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          logout().catch(() => {});
          return;
        }
        setError(err instanceof ApiError ? err.message : "feed failed to load");
      });

    const off = socket.on(handle);
    socket.connect();
    return () => {
      alive = false;
      off();
      socket.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (error) return <p className="text-destructive text-sm">{error}</p>;
  if (posts.length === 0) {
    return (
      <p className="text-muted-foreground py-12 text-center text-sm">
        The stream is silent. Say something — it only lives while you do.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {posts.map((p) => (
        <PostCard key={p.id} post={p} />
      ))}
    </div>
  );
}
