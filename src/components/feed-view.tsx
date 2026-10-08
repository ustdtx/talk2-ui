"use client";

import * as React from "react";
import { ApiError, getFeedBatch, getOnline, listFeedBatches, type Post } from "@/lib/api";
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

  // Time-window scroll batches: every sealed window holding posts is a batch.
  // Fresh users start at n-2 (two batches of context, clamped to oldest).
  // Scroll down at the bottom -> next batch below; scroll up at the top ->
  // previous batch above. Open windows are withheld until the seal tick.
  const batchesRef = React.useRef<number[]>([]);
  const topBatch = React.useRef<number | null>(null);
  const bottomBatch = React.useRef<number | null>(null);
  const postsRef = React.useRef<Post[]>([]);
  React.useEffect(() => {
    postsRef.current = posts;
  }, [posts]);
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const loadingTop = React.useRef(false);
  const loadingBottom = React.useRef(false);
  const newerCooldownUntil = React.useRef(0);
  const retryTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const topRef = React.useRef<HTMLDivElement>(null);
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const topArmed = React.useRef(false);
  const loadedOnce = React.useRef(false);

  // Instant prepend for history batches (above) with scroll restoration,
  // so the post you were reading stays exactly where it was.
  const prependInstant = React.useCallback((batch: Post[]) => {
    const fresh = batch.filter((p) => !seen.current.has(p.id));
    if (fresh.length === 0) return;
    fresh.forEach((p) => seen.current.add(p.id));
    const prevTop = window.scrollY;
    const prevHeight = document.documentElement.scrollHeight;
    setPosts((prev) => [...fresh, ...prev]);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const dh = document.documentElement.scrollHeight - prevHeight;
        if (dh > 0) window.scrollTo(0, prevTop + dh);
      }),
    );
  }, []);

  // Realtime reveal queue: new batches below appear one post at a time,
  // not 30 at once. History batches above skip the queue (instant).
  const revealQueue = React.useRef<Post[]>([]);
  React.useEffect(() => {
    const t = setInterval(() => {
      const q = revealQueue.current;
      if (q.length === 0) return;
      if (document.hidden) {
        const fresh = q.splice(0).filter((p) => !seen.current.has(p.id));
        if (fresh.length === 0) return;
        fresh.forEach((p) => seen.current.add(p.id));
        setPosts((prev) => [...prev, ...fresh]);
        return;
      }
      // Big sealed batches still cascade fast: more per tick when queued deep.
      const perTick = q.length > 120 ? 8 : q.length > 60 ? 3 : 1;
      for (let i = 0; i < perTick && q.length > 0; i++) {
        const p = q.shift()!;
        if (seen.current.has(p.id)) continue;
        seen.current.add(p.id);
        setPosts((prev) => [...prev, p]);
      }
    }, 45);
    return () => clearInterval(t);
  }, []);

  const enqueueReveal = React.useCallback((batch: Post[]) => {
    if (batch.length > 0) revealQueue.current.push(...batch);
  }, []);

  const scheduleRetry = React.useCallback((fn: () => void, ms: number) => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(fn, ms);
  }, []);

  // Fresh batch list (sealed, non-empty ids ascending).
  const refreshBatches = React.useCallback(async () => {
    if (!token) return [];
    const res = await listFeedBatches(token);
    batchesRef.current = res.batches;
    return res.batches;
  }, [token]);

  // Older batch above (reverse scroll). Skips sealed-but-emptied batches;
  // re-anchors if our top batch vanished (all its posts died).
  const loadPreviousBatch = React.useCallback(async () => {
    if (!token || loadingTop.current || topBatch.current === null) return;
    loadingTop.current = true;
    setLoadingOlder(true);
    try {
      let list = batchesRef.current;
      let idx = list.indexOf(topBatch.current);
      if (idx === -1) {
        list = await refreshBatches();
        const cands = list.filter((b) => b <= (topBatch.current as number));
        if (cands.length === 0) {
          if (list.length > 0) topBatch.current = list[0];
          return;
        }
        topBatch.current = cands[cands.length - 1];
        idx = list.indexOf(topBatch.current);
      }
      for (let hops = 0; hops < 12 && idx > 0; hops++) {
        idx -= 1;
        const res = await getFeedBatch(token, list[idx]);
        if (!res.complete) break;
        topBatch.current = list[idx];
        if (res.posts.length > 0) {
          prependInstant(res.posts);
          break;
        }
      }
    } catch {
      // Sentinel stays armed; scrolling retriggers.
    } finally {
      loadingTop.current = false;
      setLoadingOlder(false);
    }
  }, [token, prependInstant, refreshBatches]);

  // Newer batch below. Bootstrap starts at n-2 (clamped to oldest), so the
  // user gets two batches of context before the live edge. Withheld (open)
  // windows -> quiet cooldown; the seal tick wakes the live edge.
  const loadNextBatchRef = React.useRef<() => void>(() => {});
  const loadNextBatch = React.useCallback(async () => {
    if (!token || loadingBottom.current) return;
    if (Date.now() < newerCooldownUntil.current) return;
    loadingBottom.current = true;
    try {
      if (bottomBatch.current === null) {
        const list = await refreshBatches();
        if (list.length === 0) {
          scheduleRetry(() => loadNextBatchRef.current(), 8000);
          return;
        }
        const start = list[Math.max(0, list.length - 3)];
        const res = await getFeedBatch(token, start);
        if (!res.complete) {
          scheduleRetry(() => loadNextBatchRef.current(), 8000);
          return;
        }
        topBatch.current = start;
        bottomBatch.current = start;
        loadedOnce.current = true;
        enqueueReveal(res.posts);
        return;
      }
      let list = batchesRef.current;
      let idx = list.indexOf(bottomBatch.current);
      if (idx === -1) {
        // Our bottom batch died off: jump to the live edge.
        list = await refreshBatches();
        bottomBatch.current = list.length > 0 ? list[list.length - 1] : null;
        return;
      }
      if (idx + 1 >= list.length) {
        // At the edge: refresh once in case a seal was missed, else wait.
        list = await refreshBatches();
        idx = list.indexOf(bottomBatch.current);
        if (idx === -1) {
          bottomBatch.current = list.length > 0 ? list[list.length - 1] : null;
          return;
        }
        if (idx + 1 >= list.length) {
          newerCooldownUntil.current = Date.now() + 8000;
          return;
        }
      }
      for (let hops = 0; hops < 12 && idx + 1 < list.length; hops++) {
        idx += 1;
        const res = await getFeedBatch(token, list[idx]);
        if (!res.complete) break;
        bottomBatch.current = list[idx];
        if (res.posts.length > 0) {
          enqueueReveal(res.posts);
          break;
        }
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        logout().catch(() => {});
        return;
      }
      if (!loadedOnce.current && bottomBatch.current === null) {
        setError(e instanceof ApiError ? e.message : "feed failed to load");
      } else if (bottomBatch.current === null) {
        scheduleRetry(() => loadNextBatchRef.current(), 8000);
      } else {
        newerCooldownUntil.current = Date.now() + 8000;
      }
    } finally {
      loadingBottom.current = false;
    }
  }, [token, enqueueReveal, scheduleRetry, refreshBatches]);
  React.useEffect(() => {
    loadNextBatchRef.current = loadNextBatch;
  });

  // Window length changed server-side (crowd grew/shrank): batch numbers
  // mean new groupings now. Re-anchor from what is actually on screen —
  // seen-ids dedupe makes the transition lossless (overlap skipped, gaps
  // fetched by scrolling).
  const rebaseWindow = React.useCallback(async (windowSec: number) => {
    if (!token) return;
    let list: number[];
    try {
      list = await refreshBatches();
    } catch {
      return;
    }
    const cur = postsRef.current;
    if (cur.length === 0 || list.length === 0) {
      topBatch.current = null;
      bottomBatch.current = null;
      return;
    }
    const wMs = windowSec * 1000;
    const batchOf = (iso: string) => Math.floor(Date.parse(iso) / wMs);
    const snapDown = (id: number) => {
      let best = list[0];
      for (const b of list) {
        if (b <= id) best = b;
        else break;
      }
      return best;
    };
    topBatch.current = snapDown(batchOf(cur[0].created_at));
    bottomBatch.current = snapDown(batchOf(cur[cur.length - 1].created_at));
  }, [token, refreshBatches]);

  // A window sealed while we watch: refresh the list and auto-advance only
  // if the user is sitting at the live edge (history readers keep reading).
  const onBatchSealed = React.useCallback(async () => {
    if (!token || bottomBatch.current === null) return;
    const prev = batchesRef.current;
    const prevLatest = prev.length > 0 ? prev[prev.length - 1] : null;
    try {
      await refreshBatches();
    } catch {
      return;
    }
    if (bottomBatch.current === prevLatest) {
      loadNextBatch();
    }
  }, [token, refreshBatches, loadNextBatch]);

  React.useEffect(() => {
    if (!token) return;
    const topEl = topRef.current;
    const bottomEl = bottomRef.current;
    if (!topEl || !bottomEl) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.target === topEl) {
            // The top sentinel starts visible, so only load older once the
            // user has scrolled past it and back up (reverse scroll).
            if (!e.isIntersecting) {
              topArmed.current = true;
            } else if (topArmed.current) {
              loadPreviousBatch();
            }
          } else if (e.isIntersecting) {
            loadNextBatch();
          }
        }
      },
      { rootMargin: "400px" },
    );
    io.observe(topEl);
    io.observe(bottomEl);
    return () => {
      io.disconnect();
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [token, loadPreviousBatch, loadNextBatch]);

  // Own new post joins the reveal queue (lands below, one by one).
  React.useEffect(() => {
    if (incoming) enqueueReveal([incoming]);
  }, [incoming, enqueueReveal]);

  React.useEffect(() => {
    if (!token) return;
    seen.current = new Set<number>();
    batchesRef.current = [];
    topBatch.current = null;
    bottomBatch.current = null;
    topArmed.current = false;
    loadedOnce.current = false;
    revealQueue.current = [];
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
        // NOTE: no feed:new_post / comment:new socket handling and no polling.
        // New posts arrive as sealed time-window batches below; history loads
        // above in reverse scroll. One tiny seal tick per window wakes the
        // live edge. Retracts still pushed.
        case "feed:batch_sealed": {
          onBatchSealed();
          break;
        }
        case "feed:window_changed": {
          const w = (pl.window_sec as number) ?? 60;
          rebaseWindow(typeof w === "number" && w > 0 ? w : 60);
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

    // No initial fetch here: the bottom sentinel bootstraps from the latest
    // sealed batch (and retries until the first batch exists).

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
    <div className="flex flex-col gap-4">
      <div ref={topRef} />
      {loadingOlder && (
        <p className="text-muted-foreground self-center text-xs">loading older…</p>
      )}
      {posts.map((p) => (
        <PostCard key={p.id} post={p} />
      ))}
      <div ref={bottomRef} />
      {posts.length === 0 && (
        <p className="text-muted-foreground py-12 text-center text-sm">
          The stream is silent. Say something — it only lives while you do.
        </p>
      )}
    </div>
  );
}
