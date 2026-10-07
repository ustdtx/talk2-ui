// Typed client for the Talk2 API (contracts verified live in TASK-1..5).

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8081";

export interface User {
  id: number;
  username: string;
  created_at: string;
}

export interface PostImage {
  key: string;
  url: string;
}

export interface Post {
  id: number;
  author_id: number;
  author_username: string;
  text: string;
  images: PostImage[];
  created_at: string;
  comment_count?: number;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(
  path: string,
  token: string | null,
  init?: RequestInit,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body && !(init.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      res.status,
      typeof data?.error === "string" ? data.error : `request failed (${res.status})`,
    );
  }
  return data as T;
}

export function login(username: string, password: string) {
  return request<{ user: User; token: string }>("/auth/login", null, {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function register(username: string, password: string) {
  return request<{ user: User; token: string }>("/auth/register", null, {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function logout(token: string) {
  return request<{ status: string }>("/auth/logout", token, { method: "POST" });
}

export function getFeed(token: string, limit = 50, before?: number) {
  const q = before ? `/feed?limit=${limit}&before=${before}` : `/feed?limit=${limit}`;
  return request<{ posts: Post[] }>(q, token);
}

export function deletePost(token: string, postId: number) {
  return request<{ deleted: number }>(`/posts/${postId}`, token, {
    method: "DELETE",
  });
}

export interface CommentT {
  id: number;
  post_id: number;
  author_id: number;
  author_username: string;
  text: string;
  images: PostImage[];
  created_at: string;
  parent_id?: number;
  reply_to_id?: number;
  reply_to_name?: string;
}

export interface ThreadedComment extends CommentT {
  replies: CommentT[];
}

export function getComments(token: string, postId: number) {
  return request<{ comments: ThreadedComment[] }>(
    `/posts/${postId}/comments`,
    token,
  );
}

export function addComment(
  token: string,
  postId: number,
  body: { text: string; image_keys?: string[]; parent_id?: number },
) {
  return request<CommentT>(`/posts/${postId}/comments`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function createPost(
  token: string,
  body: { text: string; image_keys?: string[] },
) {
  return request<Post>("/posts", token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function uploadImage(token: string, key: string, file: File) {
  const form = new FormData();
  form.set("key", key);
  form.set("file", file);
  return request<{ key: string; url: string }>("/media/upload", token, {
    method: "POST",
    body: form,
  });
}

export function wsUrl(token: string) {
  return `${API_URL.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;
}

// --- Presence (plan F2) ---

export interface OnlineMember {
  user_id: number;
  username: string;
}

export function getOnline(token: string) {
  return request<{ online: OnlineMember[] }>("/presence/online", token);
}

export function heartbeat(token: string) {
  return request<{ online: boolean }>("/presence/heartbeat", token, {
    method: "POST",
  });
}

// --- DMs (plan F5: online-only 1:1, full thread wipe) ---

export interface DMMessage {
  id: number;
  from_id: number;
  from_username: string;
  to_id: number;
  text: string;
  images: PostImage[];
  created_at: string;
}

export interface DMThread {
  with_user_id: number;
  with_username: string;
  last_text: string;
  last_at: string;
  message_count: number;
}

export function listDMs(token: string) {
  return request<{ threads: DMThread[] }>("/dms", token);
}

export function getDMThread(token: string, withUserId: number) {
  return request<{ messages: DMMessage[] }>(`/dms/${withUserId}`, token);
}

export function sendDM(
  token: string,
  body: { to_user_id: number; text: string; image_keys?: string[] },
) {
  return request<DMMessage>("/dms", token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// --- Rooms (online-only group chats) ---

export interface Room {
  id: number;
  name: string;
  creator_id: number;
  creator_username: string;
  member_count: number;
}

export interface RoomMessage {
  id: number;
  room_id: number;
  author_id: number;
  author_username: string;
  text: string;
  created_at: string;
}

export function listRooms(token: string) {
  return request<{ rooms: Room[] }>("/rooms", token);
}

export function createRoom(token: string, name: string) {
  return request<Room>("/rooms", token, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function joinRoom(token: string, roomId: number) {
  return request<Room>(`/rooms/${roomId}/join`, token, { method: "POST" });
}

export function getRoomMessages(token: string, roomId: number) {
  return request<{ messages: RoomMessage[] }>(`/rooms/${roomId}/messages`, token);
}

export function sendRoomMessage(token: string, roomId: number, text: string) {
  return request<RoomMessage>(`/rooms/${roomId}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export function leaveRoom(token: string, roomId: number) {
  return request<{ room_ids: number[] }>(`/rooms/${roomId}/leave`, token, {
    method: "POST",
  });
}
