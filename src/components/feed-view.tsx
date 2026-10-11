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

  // Realtime reveal queue: every socket-pushed post lands here and the
  // device drains it at its own pace — a push is never a render.
  // CPU safety (a 100-posts/sec storm must not pin a phone at 100%):
  //   - one setPosts per tick (never per post), hard 8ms time budget
  //   - adaptive rate: AIMD on measured tick cost (1..8 posts/tick)
  //   - input yield: skip the tick when a tap/scroll is pending, so the
  //     app shell, app switches and gestures always win over chat render
  //   - hidden tabs accumulate without rendering (cap enforced)
  //   - queue cap 300 + overflow pill; drops are backfilled by the next
  //     catch-up sweep (reconnect / refocus / pill tap)
  const revealQueue = React.useRef<Post[]>([]);
  const rateRef = React.useRef(2);
  const droppedRef = React.useRef(0);
  const nearBottomRef = React.useRef(true);
  const [pendingCount, setPendingCount] = React.useState(0);
  // Mirror of pendingCount for the interval closure (avoids stale reads).
  const pendingRef = React.useRef(0);
  const setPending = React.useCallback((n: number) => {
    if (pendingRef.current !== n) {
      pendingRef.current = n;
      setPendingCount(n);
    }
  }, []);
  const QUEUE_CAP = 300;
  const TICK_MS = 45;
  const TIME_BUDGET_MS = 8;
  // Store cap, not a DOM cap: the WindowVirtualizer below mounts only the
  // visible window (~dozens of cards), so the array can hold far more.
  // ~2000 text posts ≈ 2MB; images stay URLs until their row mounts.
  // Eviction is edge-only (history readers never lose rows) and lossless
  // (evicted ranges refetch via the before-cursor).
  const STORE_CAP = 2000;

  React.useEffect(() => {
    const onScroll = () => {
      const doc = document.documentElement;
      nearBottomRef.current =
        doc.scrollHeight - window.scrollY - window.innerHeight < 1000;
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  React.useEffect(() => {
    const t = setInterval(() => {
      const q = revealQueue.current;
      if (q.length === 0 && droppedRef.current === 0) {
        setPending(0);
        return;
      }
      // Let user input / compositor win: skip this tick entirely.
      const sched = (
        navigator as Navigator & {
          scheduling?: { isInputPending?: () => boolean };
        }
      ).scheduling;
      if (sched?.isInputPending?.()) return;
      if (document.hidden) {
        // No rendering while hidden — just enforce the cap.
        if (q.length > QUEUE_CAP) {
          droppedRef.current += q.length - QUEUE_CAP;
          revealQueue.current = q.slice(-QUEUE_CAP);
        }
        const waiting = revealQueue.current.length + droppedRef.current;
        setPending(waiting);
        return;
      }
      const start = performance.now();
      const fresh: Post[] = [];
      const rate = rateRef.current;
      while (fresh.length < rate && q.length > 0) {
        if (performance.now() - start > TIME_BUDGET_MS) break;
        const p = q.shift()!;
        if (seen.current.has(p.id)) continue;
        seen.current.add(p.id);
        fresh.push(p);
      }
      // AIMD on measured cost: slow tick -> halve, fast tick -> +1.
      const cost = performance.now() - start;
      if (cost > 10) rateRef.current = Math.max(1, Math.floor(rate / 2));
      else if (cost < 6 && q.length > 10)
        rateRef.current = Math.min(8, rate + 1);
      if (fresh.length > 0) {
        const atEdge = nearBottomRef.current;
        setPosts((prev) => {
          const next = [...prev, ...fresh];
          if (atEdge && next.length > STORE_CAP) {
            return next.slice(next.length - STORE_CAP);
          }
          return next;
        });
      }
      const waiting = q.length + droppedRef.current;
      setPending(waiting);
    }, TICK_MS);
    return () => clearInterval(t);
  }, [setPending]);

  const enqueueReveal = React.useCallback(
    (batch: Post[]) => {
      if (batch.length === 0) return;
      const q = revealQueue.current;
      q.push(...batch);
      if (q.length > QUEUE_CAP) {
        droppedRef.current += q.length - QUEUE_CAP;
        revealQueue.current = q.slice(-QUEUE_CAP);
      }
    },
    [QUEUE_CAP],
  );

  // Retracts/offline must hit the queue too, so a deleted post never
  // cascades in after its retract arrived.
  const purgeQueueById = React.useCallback((id: number) => {
    const q = revealQueue.current;
    for (let i = q.length - 1; i >= 0; i--) {
      if (q[i].id === id) q.splice(i, 1);
    }
  }, []);

  const purgeQueueByAuthor = React.useCallback((uid: number) => {
    const q = revealQueue.current;
    for (let i = q.length - 1; i >= 0; i--) {
      if (q[i].author_id === uid) q.splice(i, 1);
    }
  }, []);

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
      // Sockets keep delivering live; next focus/reconnect retries.
    }
  }, [token, bootstrap, enqueueReveal]);

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
    revealQueue.current = [];
    droppedRef.current = 0;
    setPending(0);
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
        // Live push: every new post arrives here and waits in the paced
        // reveal queue above — pushes never render directly.
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
            for (const p of revealQueue.current) {
              if (p.id === pid) p.comment_count = Math.max(0, (p.comment_count ?? 1) - 1);
            }
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
        {pendingCount > 3 && (
          <button
            type="button"
            onClick={() => {
              droppedRef.current = 0;
              catchUp();
              virtRef.current?.scrollToIndex(Math.max(0, posts.length - 1), {
                align: "end",
              });
            }}
            className="bg-primary text-primary-foreground sticky bottom-4 self-center rounded-full px-4 py-1.5 text-xs font-semibold shadow-lg"
          >
            ↓ {pendingCount} new — jump to live
          </button>
        )}
        {posts.length === 0 && (
          <p className="text-muted-foreground py-12 text-center text-sm">
            The stream is silent. Say something — it only lives while you do.
          </p>
        )}
      </div>
    </ThreadEventsContext.Provider>
  );
}
