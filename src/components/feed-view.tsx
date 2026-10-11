"use client";

import * as React from "react";
import { WindowVirtualizer, type WindowVirtualizerHandle } from "virtua";
import { ApiError, getFeed, getFeedAfter, getOnline, type Post } from "@/lib/api";
import { Talk2Socket, type SocketEvent } from "@/lib/socket";
import { useSession } from "@/context/session";
import { PostCard } from "@/components/post-card";

// Per-post thread event bus: the shared socket lives here, comment threads
// in PostCards subscribe for live refetch triggers (comment:new /
// comment:retracted for their post).
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

  // Store mirror for cursor reads (newest/oldest id) inside callbacks.
  const postsRef = React.useRef<Post[]>([]);
  React.useEffect(() => {
    postsRef.current = posts;
  }, [posts]);

  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const loadingTop = React.useRef(false);
  const exhaustedRef = React.useRef(false);
  const bootInflight = React.useRef(false);
  const topRef = React.useRef<HTMLDivElement>(null);
  const virtRef = React.useRef<WindowVirtualizerHandle>(null);
  const topArmed = React.useRef(false);

  // History prepend. The WindowVirtualizer's `shift` prop owns scroll
  // compensation, so this is a plain prepend.
  const prependInstant = React.useCallback((batch: Post[]) => {
    const fresh = batch.filter((p) => !seen.current.has(p.id));
    if (fresh.length === 0) return;
    fresh.forEach((p) => seen.current.add(p.id));
    setPosts((prev) => [...fresh, ...prev]);
  }, []);

  // POC snappy: push === render. No paced queue, no AIMD, no caps.
  // Every socket post appends instantly; retracts filter instantly.

  const enqueueReveal = React.useCallback((batch: Post[]) => {
    const fresh = batch.filter((p) => !seen.current.has(p.id));
    if (fresh.length === 0) return;
    fresh.forEach((p) => seen.current.add(p.id));
    setPosts((prev) => [...prev, ...fresh].sort((a, b) => a.id - b.id));
  }, []);

  // No queue anymore — retracts only touch rendered posts.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const purgeQueueById = React.useCallback((_id?: number) => {}, []);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const purgeQueueByAuthor = React.useCallback((_uid?: number) => {}, []);

  // Bootstrap: newest page, oldest-first into the store. Idempotent
  // (seen-filtered), so reconnects can safely rerun it when empty.
  const bootstrap = React.useCallback(async () => {
    if (!token || bootInflight.current) return;
    bootInflight.current = true;
    try {
      const res = await getFeed(token, 50);
      const fresh = [...res.posts]
        .reverse()
        .filter((p) => !seen.current.has(p.id));
      if (fresh.length > 0) {
        fresh.forEach((p) => seen.current.add(p.id));
        setPosts((prev) => [...prev, ...fresh].sort((a, b) => a.id - b.id));
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (window.scrollY < 200)
              window.scrollTo(0, document.documentElement.scrollHeight);
          }),
        );
      }
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        logout().catch(() => {});
        return;
      }
      setError(e instanceof ApiError ? e.message : "feed failed to load");
    } finally {
      bootInflight.current = false;
    }
  }, [token, logout]);

  // Catch-up: everything newer than our newest id (missed pushes from a
  // disconnect, sleep, or flood overflow). Dedupe via seen ids.
  // Then reconcile: any missed retract (reconnect gap, dropped push, slow
  // client) leaves a ghost post nothing will ever remove — refresh was the
  // only cure. The newest page is ground truth for its window, so prune
  // locals inside that window that aren't live anymore.
  const catchUp = React.useCallback(async () => {
    if (!token) return;
    const cur = postsRef.current;
    if (cur.length === 0) {
      bootstrap();
      return;
    }
    try {
      const res = await getFeedAfter(token, cur[cur.length - 1].id, 100);
      enqueueReveal(res.posts);
    } catch {
      // Sockets keep delivering live; next focus retries.
    }
    try {
      const live = await getFeed(token, 100);
      if (live.posts.length === 0) return;
      const ids = new Set(live.posts.map((p) => p.id));
      const floor = live.posts[live.posts.length - 1].id;
      const ghosts = new Set<number>();
      for (const p of postsRef.current) {
        if (p.id >= floor && !ids.has(p.id)) ghosts.add(p.id);
      }
      if (ghosts.size === 0) return;
      ghosts.forEach((id) => {
        seen.current.delete(id);
        purgeQueueById(id);
      });
      setPosts((prev) => prev.filter((p) => !ghosts.has(p.id)));
    } catch {
      // Next sweep retries.
    }
  }, [token, bootstrap, enqueueReveal, purgeQueueById]);

  // History: one older page above the current top (reverse scroll).
  const loadOlder = React.useCallback(async () => {
    if (!token || loadingTop.current || exhaustedRef.current) return;
    const oldest = postsRef.current[0]?.id;
    if (!oldest) return;
    loadingTop.current = true;
    setLoadingOlder(true);
    try {
      const res = await getFeed(token, 50, oldest);
      if (res.posts.length === 0) {
        exhaustedRef.current = true;
        return;
      }
      prependInstant([...res.posts].reverse());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        logout().catch(() => {});
      }
      // Sentinel stays armed; scrolling retriggers.
    } finally {
      loadingTop.current = false;
      setLoadingOlder(false);
    }
  }, [token, logout, prependInstant]);

  // Top sentinel: reverse scroll loads older. It starts visible, so only
  // load once the user has scrolled past it and back up.
  // (Initial load lives in the socket effect below: it bootstraps even if
  // the socket itself fails, so there is exactly one owner.)
  React.useEffect(() => {
    if (!token) return;
    const topEl = topRef.current;
    if (!topEl) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) {
            topArmed.current = true;
          } else if (topArmed.current) {
            loadOlder();
          }
        }
      },
      { rootMargin: "400px" },
    );
    io.observe(topEl);
    return () => {
      io.disconnect();
    };
  }, [token, loadOlder]);

  // Refocus wakes the edge (covers sleep and missed pushes).
  React.useEffect(() => {
    if (!token) return;
    const onFocus = () => {
      catchUp();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [token, catchUp]);

  // Own new post joins the reveal queue (lands below, one by one).
  React.useEffect(() => {
    if (incoming) enqueueReveal([incoming]);
  }, [incoming, enqueueReveal]);

  React.useEffect(() => {
    if (!token) return;
    // Fresh mount per account (parent keys on token), so all refs start
    // clean; the guards below are idempotent backstops.
    seen.current = new Set<number>();
    topArmed.current = false;
    exhaustedRef.current = false;
    bootstrap();
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
          // (Re)connected: pull anything posted while we were away.
          catchUp();
          break;
        }
        case "presence:online":
        case "presence:update":
          refreshOnline();
          break;
        // Live push: POC snappy — render instantly.
        case "feed:new_post": {
          const post = pl as unknown as Post;
          if (
            typeof post?.id === "number" &&
            typeof post?.author_id === "number"
          ) {
            enqueueReveal([post]);
          }
          break;
        }
        // Live threads: wake the open thread for this post; each Comments
        // box refetches its own page. Closed threads update their count
        // when next opened.
        case "comment:new": {
          const pid = (pl as unknown as { post_id: number }).post_id;
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
          purgeQueueById(pid);
          setPosts((prev) => prev.filter((p) => p.id !== pid));
          break;
        }
        case "presence:offline": {
          const uid = pl.user_id as number;
          purgeQueueByAuthor(uid);
          setPosts((prev) => prev.filter((p) => p.author_id !== uid));
          refreshOnline();
          break;
        }
      }
    };

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
  return (
    <ThreadEventsContext.Provider value={bus}>
      <div className="flex flex-col gap-4">
        <div ref={topRef} />
        {loadingOlder && (
          <p className="text-muted-foreground self-center text-xs">loading older…</p>
        )}
        {/* Windowed rendering: only the visible window mounts (~dozens of
            cards no matter how deep the store grows). `shift` keeps the read
            position stable when history prepends above; stable post-id keys
            are required for it (never indices). Spacing lives on the item
            wrapper (parent gap can't reach inside the virtual container). */}
        <WindowVirtualizer ref={virtRef} shift>
          {posts.map((p) => (
            <div key={p.id} className="pb-4">
              <PostCard post={p} />
            </div>
          ))}
        </WindowVirtualizer>
        {posts.length === 0 && (
          <p className="text-muted-foreground py-12 text-center text-sm">
            The stream is silent. Say something — it only lives while you do.
          </p>
        )}
      </div>
    </ThreadEventsContext.Provider>
  );
}
