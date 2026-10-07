"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ApiError } from "@/lib/api";
import { useSession } from "@/context/session";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function AuthForm({ mode }: { mode: "login" | "register" }) {
  const { login, register } = useSession();
  const router = useRouter();
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const nameOk = username.trim().length >= 3;
  const passOk = password.length >= 8;
  const formOk = nameOk && passOk;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") await login(username, password);
      else await register(username, password);
      router.push("/feed");
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "something went wrong",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Input
        placeholder="username"
        autoComplete="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        minLength={3}
        maxLength={32}
        required
      />
      <Input
        type="password"
        placeholder="password (8+ chars)"
        autoComplete={mode === "login" ? "current-password" : "new-password"}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        minLength={8}
        required
      />
      {error && <p className="text-destructive text-sm">{error}</p>}
      {!formOk && (
        <p className="text-muted-foreground text-xs">
          Username needs 3+ characters, password 8+ — the button unlocks when
          both are met.
        </p>
      )}
      <Button type="submit" disabled={busy || !formOk}>
        {busy ? "…" : mode === "login" ? "Enter the stream" : "Join the stream"}
      </Button>
    </form>
  );
}

export function AuthCard() {
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Talk2</CardTitle>
        <CardDescription>
          You are only here while you are here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="login">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="login">Log in</TabsTrigger>
            <TabsTrigger value="register">Register</TabsTrigger>
          </TabsList>
          <TabsContent value="login" className="pt-4">
            <AuthForm mode="login" />
          </TabsContent>
          <TabsContent value="register" className="pt-4">
            <AuthForm mode="register" />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
