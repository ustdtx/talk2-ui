// Cross-component DM opener: PostCards emit requestDMOpen, the feed page
// switches to the Talk tab and the DMs panel opens the thread.
export interface DMTarget {
  id: number;
  username: string;
}

type Fn = (t: DMTarget) => void;

const subs = new Set<Fn>();

export function requestDMOpen(t: DMTarget) {
  subs.forEach((fn) => fn(t));
}

export function onDMOpen(fn: Fn): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
