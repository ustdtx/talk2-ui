"use client";

import * as React from "react";
import { ImagePlus, X } from "lucide-react";
import { ApiError, createPost, uploadImage, type Post } from "@/lib/api";
import { useSession } from "@/context/session";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

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

export function Composer({ onPosted }: { onPosted: (p: Post) => void }) {
  const { token, user } = useSession();
  // Uncontrolled textarea (ref, not state): keystrokes never fight React
  // re-renders, so fast typing can't lose characters to DOM/state desync.
  const textRef = React.useRef<HTMLTextAreaElement>(null);
  const [charCount, setCharCount] = React.useState(0);
  const [picks, setPicks] = React.useState<Pick[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
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
    if (fresh.length > 0) setPicks((prev) => [...prev, ...fresh].slice(0, MAX_IMAGES));
    if (fileRef.current) fileRef.current.value = "";
  }

  function removePick(i: number) {
    setPicks((prev) => {
      URL.revokeObjectURL(prev[i].preview);
      return prev.filter((_, j) => j !== i);
    });
  }

  async function send() {
    if (!token || !user || busy) return;
    const trimmed = (textRef.current?.value ?? "").trim();
    if (!trimmed && picks.length === 0) {
      setError("say something or attach an image");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const keys: string[] = [];
      for (const p of picks) {
        const key = `tmp/${user.id}/${crypto.randomUUID()}${extFor(p.file)}`;
        await uploadImage(token, key, p.file);
        keys.push(key);
      }
      const post = await createPost(token, {
        text: trimmed,
        image_keys: keys,
      });
      picks.forEach((p) => URL.revokeObjectURL(p.preview));
      setPicks([]);
      if (textRef.current) textRef.current.value = "";
      setCharCount(0);
      onPosted(post);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "could not post, try again",
      );
    } finally {
      setBusy(false);
    }
  }

  const canSend = charCount > 0 || picks.length > 0;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-6">
        <Textarea
          ref={textRef}
          placeholder="what's moving through you?"
          rows={3}
          onChange={(e) => setCharCount(e.target.value.trim().length)}
        />
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
        {error && <p className="text-destructive text-sm">{error}</p>}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
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
            <span className="text-muted-foreground text-xs">
              {charCount > 0 && `${charCount} chars`}
              {charCount > 0 && picks.length > 0 && " · "}
              {picks.length > 0 && `${picks.length}/${MAX_IMAGES} imgs`}
            </span>
          </div>
          <Button type="button" onClick={send} disabled={busy || !canSend}>
            {busy ? "saying…" : "Say it"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
