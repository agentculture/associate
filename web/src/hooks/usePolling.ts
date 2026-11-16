import { useEffect, useRef } from "react";

/** How often a screen with a running run reads again: modest, the run takes minutes. */
export const REFRESH_MS = 5_000;

/**
 * Call `tick` every `REFRESH_MS` while `active` and the tab is visible. Hiding the tab pauses
 * it; showing it again ticks at once (the screen may be stale) and resumes. Inactive (nothing
 * running), it never ticks. No polling library: one interval and one visibility listener.
 */
export function usePolling(active: boolean, tick: () => void, ms: number = REFRESH_MS): void {
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    if (!active) return undefined;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => tickRef.current(), ms);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else if (timer === null) {
        tickRef.current();
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, ms]);
}
