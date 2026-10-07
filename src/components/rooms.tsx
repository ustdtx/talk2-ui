"use client";

import * as React from "react";
import { ArrowLeft } from "lucide-react";
import {
  ApiError,
  createRoom,
  getRoomMessages,
  joinRoom,
  leaveRoom,
  listRooms,
  sendRoomMessage,
  type Room,
  type RoomMessage,
} from "@/lib/api";
import { Talk2Socket } from "@/lib/socket";
import { useSession } from "@/context/session";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function Rooms() {
  const { token, user } = useSession();
  const [rooms, setRooms] = React.useState<Room[]>([]);
  const [active, setActive] = React.useState<Room | null>(null);
  const [messages, setMessages] = React.useState<RoomMessage[]>([]);
  const [roomName, setRoomName] = React.useState("");
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const loadRooms = React.useCallback(async () => {
    if (!token) return;
    try {
      const res = await listRooms(token);
      setRooms(res.rooms);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "rooms failed");
    }
  }, [token]);

  React.useEffect(() => {
    const timer = setTimeout(() => { void loadRooms(); }, 0);
    return () => clearTimeout(timer);
  }, [loadRooms]);
  React.useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, active]);

  React.useEffect(() => {
    if (!token) return;
    const socket = new Talk2Socket(() => token);
    const off = socket.on((ev) => {
      const pl = (ev.payload ?? {}) as Record<string, unknown>;
      if (ev.type === "room:created" || ev.type === "room:updated" || ev.type === "room:deleted") {
        loadRooms();
        const id = (pl.id as number | undefined) ?? (pl.room_id as number | undefined);
        if (ev.type === "room:deleted" && active?.id === id) {
          setActive(null);
          setMessages([]);
        }
      } else if (ev.type === "room:message" && active?.id === (pl.room_id as number)) {
        const message = pl as unknown as RoomMessage;
        setMessages((prev) => prev.some((item) => item.id === message.id) ? prev : [...prev, message]);
      } else if (ev.type === "room:message_retracted" && active?.id === (pl.room_id as number)) {
        setMessages((prev) => prev.filter((item) => item.id !== (pl.message_id as number)));
      } else if (ev.type === "presence:offline") {
        loadRooms();
      }
    });
    socket.connect();
    return () => { off(); socket.close(); };
  }, [token, active, loadRooms]);

  async function openRoom(room: Room) {
    if (!token) return;
    setBusy(true);
    try {
      const joined = await joinRoom(token, room.id);
      const res = await getRoomMessages(token, room.id);
      setActive(joined);
      setMessages(res.messages);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not open room");
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!token || busy || !roomName.trim()) return;
    setBusy(true);
    try {
      const created = await createRoom(token, roomName);
      setRoomName("");
      setRooms((prev) => [created, ...prev.filter((room) => room.id !== created.id)]);
      setActive(created);
      setMessages([]);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not create room");
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    if (!token || !active || busy) return;
    const roomId = active.id;
    setBusy(true);
    try {
      await leaveRoom(token, roomId);
      setActive(null);
      setMessages([]);
      await loadRooms();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not leave room");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!token || !active || busy || !draft.trim()) return;
    setBusy(true);
    try {
      const message = await sendRoomMessage(token, active.id, draft);
      setMessages((prev) => prev.some((item) => item.id === message.id) ? prev : [...prev, message]);
      setDraft("");
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not send message");
    } finally {
      setBusy(false);
    }
  }

  if (active) {
    return (
      <Card className="flex h-[calc(100dvh-320px)] min-h-[380px] flex-col">
        <CardHeader className="flex shrink-0 flex-row items-center gap-2 pb-2">
          <Button type="button" variant="ghost" size="icon" aria-label="back to rooms" onClick={() => { setActive(null); setMessages([]); loadRooms(); }}>
            <ArrowLeft className="size-4" />
          </Button>
          <span className="flex-1 text-sm font-semibold">#{active.name}</span>
          <Button type="button" variant="outline" size="sm" onClick={leave}>Leave</Button>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-2">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
            <div className="flex flex-col gap-1.5">
              {messages.map((message) => {
                const mine = user?.id === message.author_id;
                return (
                  <div key={message.id} className={`max-w-[80%] rounded-2xl px-3 py-1.5 text-sm ${mine ? "self-end rounded-br-sm bg-primary text-primary-foreground" : "self-start rounded-bl-sm bg-muted"}`}>
                    {!mine && <span className="mb-0.5 block text-[10px] font-semibold opacity-70">@{message.author_username}</span>}
                    {message.text}
                  </div>
                );
              })}
              {messages.length === 0 && <p className="text-muted-foreground text-xs">Nothing here yet — say hello.</p>}
            </div>
          </div>
          {error && <p className="text-destructive text-xs">{error}</p>}
          <div className="flex shrink-0 gap-2 border-t pt-2">
            <Input placeholder="message…" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }} />
            <Button type="button" onClick={send} disabled={busy || !draft.trim()}>Send</Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2 text-sm font-semibold">Rooms — online only</CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-muted-foreground text-xs">Create a room or open one to talk. Your messages disappear when you leave or go offline.</p>
        <div className="flex gap-2">
          <Input placeholder="room name…" value={roomName} onChange={(e) => setRoomName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") create(); }} />
          <Button type="button" onClick={create} disabled={busy || !roomName.trim()}>Create</Button>
        </div>
        {error && <p className="text-destructive text-xs">{error}</p>}
        {rooms.length === 0 && <p className="text-muted-foreground text-xs">No live rooms.</p>}
        {rooms.map((room) => (
          <button key={room.id} type="button" disabled={busy} onClick={() => openRoom(room)} className="rounded-md border p-2 text-left hover:bg-muted">
            <span className="block text-sm font-semibold">#{room.name}</span>
            <span className="text-muted-foreground block text-xs">{room.member_count} {room.member_count === 1 ? "person" : "people"} here</span>
          </button>
        ))}
      </CardContent>
    </Card>
  );
}
