"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ModeToggle } from "@/components/mode-toggle";
import { AuthCard } from "@/components/auth-card";
import { useSession } from "@/context/session";

export default function Home() {
  const { token, ready } = useSession();
  const router = useRouter();

  React.useEffect(() => {
    if (ready && token) router.replace("/feed");
  }, [ready, token, router]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 p-6">
      <div className="flex w-full max-w-md items-center justify-end">
        <ModeToggle />
      </div>
      {(!ready || token) && (
        <p className="text-muted-foreground text-sm">loading…</p>
      )}
      {ready && !token && <AuthCard />}
    </div>
  );
}
