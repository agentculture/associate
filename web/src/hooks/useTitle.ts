import { useEffect } from "react";

/** `<title> - associate` for the current screen (shape cited from qodo-cli's useTitle). */
export function useTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} - associate`;
  }, [title]);
}
