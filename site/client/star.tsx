/* Starring a dataset: the stars live in this browser's local storage, shared by every mount on a page and every tab through one store, so a star set on an entry page shows in the listing and in another tab. */

import { useSyncExternalStore, type ReactNode } from "react";
import { ActionIcon, Tooltip } from "@mantine/core";
import { parseStarred, serialiseStarred, STARRED_KEY, toggled } from "../starred";

const listeners = new Set<() => void>();

// The snapshot must be the same object until the stored text changes, or useSyncExternalStore re-renders for ever; the parsed set is therefore kept against the text it came from.
let snapshotText: string | null | undefined;
let snapshotSet: ReadonlySet<string> = new Set();

function snapshot(): ReadonlySet<string> {
  const text = localStorage.getItem(STARRED_KEY);
  if (text !== snapshotText) {
    snapshotText = text;
    snapshotSet = parseStarred(text);
  }

  return snapshotSet;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // `storage` fires in the other tabs of the origin, not in the one that wrote.
  window.addEventListener("storage", listener);

  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** @returns The ids starred in this browser, updated when any mount or tab changes them. */
export function useStarred(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * Stars a dataset or unstars it.
 * @param id - The dataset's canonical id.
 */
export function toggleStar(id: string): void {
  localStorage.setItem(STARRED_KEY, serialiseStarred(toggled(snapshot(), id)));
  for (const listener of listeners) {
    listener();
  }
}

/** The five-point star, outlined or filled. */
function StarGlyph({ filled }: { readonly filled: boolean }): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />
    </svg>
  );
}

/** The star button for one dataset: pressed when the dataset is starred. */
export function StarToggle({ id, name }: { readonly id: string; readonly name: string }): ReactNode {
  const starred = useStarred().has(id);

  return (
    <Tooltip label={starred ? "Starred" : "Star this dataset"} withArrow>
      <ActionIcon aria-label={`Star ${name}`} aria-pressed={starred} color={starred ? "yellow" : "gray"} size="sm" variant="subtle" onClick={() => { toggleStar(id); }}>
        <StarGlyph filled={starred} />
      </ActionIcon>
    </Tooltip>
  );
}
