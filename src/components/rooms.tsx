"use client";

import * as React from "react";
import { ArrowLeft, ImagePlus, X } from "lucide-react";
import {
  ApiError,
  createRoom,
  getRoomMessages,
  joinRoom,
  leaveRoom,
  listRooms,
  sendRoomMessage,
  uploadImage,
  type Room,
  type RoomMessage,
} from "@/lib/api";
import { Talk2Socket } from "@/lib/socket";
import { useSession } from "@/context/session";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const MAX_IMAGES = 4;

interface Pick {
  file: File;
  preview: string;
}

function extFor(file: File): string {
  if (file.type === "image/png") return ".png";
  if (file.type === "image/webp") return ".webp";
  return ".jpg";
}

export function Rooms() {
  const { token, user } = useSession();
  const [rooms, setRooms] = React.useState<Room[]>([]);
  const [active, setActive] = React.useState<Room | null>(null);
  const [messages, setMessages] = React.useState<RoomMessage[]>([]);
  const [roomName, setRoomName] = React.useState("");
  const [draft, setDraft] = React.useState("");
  const [picks, setPicks] = React.useState<Pick[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const fresh: Pick[] = [];
    let err: string | null = null;
    for (const f of files) {
      if (picks.length + fresh.length >= MAX_IMAGES) break;
      if (!["image/jpeg", "image/png", "image/webp"].includes(f.type)) {
        err = "only jpeg, png, webp images allowed";
        continue;
      }
      if (f.size > 5 * 1024 * 1024) {
        err = "each image must be 5 MB or smaller";
        continue;
      }
      fresh.push({ file: f, preview: URL.createObjectURL(f) });
    }
    if (err) setError(err);
    if (fresh.length > 0)
      setPicks((prev) => [...prev, ...fresh].slice(0, MAX_IMAGES));
  }

  function removePick(i: number) {
    setPicks((prev) => {
      URL.revokeObjectURL(prev[i].preview);
      return prev.filter((_, j) => j !== i);
    });
  }

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
      picks.forEach((p) => URL.revokeObjectURL(p.preview));
      setPicks([]);
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
      picks.forEach((p) => URL.revokeObjectURL(p.preview));
      setPicks([]);
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
    if (!token || !user || !active || busy) return;
    const text = draft.trim();
    if (!text && picks.length === 0) return;
    setBusy(true);
    try {
      const keys: string[] = [];
      for (const p of picks) {
        const key = `tmp/${user.id}/${crypto.randomUUID()}${extFor(p.file)}`;
        await uploadImage(token, key, p.file);
        keys.push(key);
      }
      const message = await sendRoomMessage(token, active.id, {
        text,
        image_keys: keys,
      });
      setMessages((prev) => prev.some((item) => item.id === message.id) ? prev : [...prev, message]);
      picks.forEach((p) => URL.revokeObjectURL(p.preview));
      setPicks([]);
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
                    {message.text !== "" ? (
                      <span className="whitespace-pre-wrap">{message.text}</span>
                    ) : (
                      (message.images ?? []).length > 0 && (
                        <span className="italic opacity-70">
                          {mine ? "You sent an image" : `@${message.author_username} sent an image`}
                        </span>
                      )
                    )}
                    {(message.images ?? []).length > 0 && (
                      <span className={`mt-1 grid gap-1 ${(message.images ?? []).length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
                        {(message.images ?? []).map((im) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            key={im.key}
                            src={im.url}
                            alt=""
                            loading="lazy"
                            className="max-h-48 w-full rounded-lg object-cover"
                          />
                        ))}
                      </span>
                    )}
                  </div>
                );
              })}
              {messages.length === 0 && <p className="text-muted-foreground text-xs">Nothing here yet — say hello.</p>}
            </div>
          </div>
          {error && <p className="text-destructive text-xs">{error}</p>}
          {picks.length > 0 && (
            <div className="grid grid-cols-4 gap-2">
              {picks.map((p, i) => (
                <div key={p.preview} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.preview}
                    alt=""
                    className="aspect-square w-full rounded-md object-cover"
                  />
                  <button
                    type="button"
                    aria-label="remove image"
                    onClick={() => removePick(i)}
                    className="bg-background absolute top-1 right-1 rounded-full border p-0.5"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex shrink-0 gap-2 border-t pt-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              className="hidden"
              onChange={(e) => addFiles(e.target.files)}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="attach images"
              onClick={() => fileRef.current?.click()}
              disabled={picks.length >= MAX_IMAGES}
            >
              <ImagePlus className="size-4" />
            </Button>
            <Input placeholder="message…" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }} />
            <Button type="button" onClick={send} disabled={busy || (!draft.trim() && picks.length === 0)}>Send</Button>
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
