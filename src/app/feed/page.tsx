"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { useSession } from "@/context/session";
import type { Post } from "@/lib/api";
import { ModeToggle } from "@/components/mode-toggle";
import { Composer } from "@/components/composer";
import { DMs } from "@/components/dms";
import { Rooms } from "@/components/rooms";
import { FeedView } from "@/components/feed-view";
import { Button } from "@/components/ui/button";
import { onDMOpen, type DMTarget } from "@/lib/dm-bus";
import { Talk2Socket } from "@/lib/socket";

type Tab = "feed" | "talk" | "rooms";

export default function FeedPage() {
  const { token, user, ready, logout } = useSession();
  const router = useRouter();
  const [online, setOnline] = React.useState(0);
  const [incoming, setIncoming] = React.useState<Post | null>(null);
  const [tab, setTab] = React.useState<Tab>("feed");
  const [talkTarget, setTalkTarget] = React.useState<DMTarget | null>(null);
  const [talkUnread, setTalkUnread] = React.useState(0);

  React.useEffect(() => {
    if (ready && !token) router.replace("/");
  }, [ready, token, router]);

  // Post Talk button -> jump to Talk tab and open the thread there.
  React.useEffect(() => {
    return onDMOpen((t) => {
      setTalkTarget(t);
      setTab("talk");
      setTalkUnread(0);
    });
  }, []);

  // Keep a lightweight listener mounted with the page so messages arriving
  // while the user is on Stream or Rooms can still produce a badge.
  React.useEffect(() => {
    if (!token || !user) return;
    const socket = new Talk2Socket(() => token);
    const off = socket.on((ev) => {
      if (ev.type !== "dm:receive" || tab === "talk") return;
      const payload = (ev.payload ?? {}) as Record<string, unknown>;
      if (payload.from_id !== user.id) {
        setTalkUnread((count) => Math.min(999, count + 1));
      }
    });
    socket.connect();
    return () => {
      off();
      socket.close();
    };
  }, [token, user, tab]);

  async function handleLogout() {
    await logout();
    router.replace("/");
  }

  if (!ready || !token) {
    return (
      <p className="text-muted-foreground flex min-h-screen items-center justify-center text-sm">
        loading…
      </p>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-4 p-4 pb-16">
      <header className="sticky top-0 z-10 bg-background/80 py-2 backdrop-blur">
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <h1 className="text-xl font-bold tracking-tight">Talk2</h1>
            <span className="text-muted-foreground text-xs">
              {online > 0 ? `${online} here` : "…"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">
              @{user?.username}
            </span>
            <ModeToggle />
            <Button
              variant="outline"
              size="icon"
              aria-label="log out"
              onClick={handleLogout}
            >
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      <Composer onPosted={setIncoming} />
      <nav className="flex gap-2" aria-label="sections">
        {(["feed", "talk", "rooms"] as Tab[]).map((t) => (
          <Button
            key={t}
            type="button"
            size="sm"
            variant={tab === t ? "default" : "outline"}
            onClick={() => {
              setTab(t);
              if (t === "talk") setTalkUnread(0);
            }}
          >
            {t === "feed" ? "Stream" : t === "talk" ? (
              <span className="inline-flex items-center gap-1.5">
                Talk
                {talkUnread > 0 && (
                  <span
                    aria-label={`${talkUnread} unread messages`}
                    className="inline-flex size-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none text-primary-foreground"
                  >
                    {talkUnread > 99 ? "99+" : talkUnread}
                  </span>
                )}
              </span>
            ) : "Rooms"}
          </Button>
        ))}
      </nav>
      {tab === "feed" && <FeedView onOnlineCount={setOnline} incoming={incoming} />}
      {tab === "talk" && <DMs target={talkTarget} />}
      {tab === "rooms" && <Rooms />}
    </div>
  );
}
