import { useRunsList } from "../hooks/useRunsList";

/**
 * The shell header from the artboards: the brand dot and the `associate` wordmark, and on the
 * right how many runs are in progress, counted from the runs list itself. There is no avatar:
 * nothing in the API says who is signed in, and none is invented.
 *
 * Shape cited from qodo-cli web/src/components/Header.tsx @ ee73d5682a02952a76567887995b4f2e3aca5ea2
 * (cite-don't-import: this repo owns its copy). Adapted: no tabs (two screens, linked from each
 * other), the in-progress count in place of the key status.
 */
export function inProgressWords(n: number): string {
  if (n === 0) return "No run in progress";
  return n === 1 ? "1 run in progress" : `${n} runs in progress`;
}

export function Header() {
  const { inProgress } = useRunsList();
  return (
    <header className="app-header">
      <div className="app-header__brand">
        <span className="brand-dot" aria-hidden="true" />
        <span className="app-header__wordmark">associate</span>
      </div>
      <p className="app-header__status" aria-live="polite">
        {inProgress === null ? "" : inProgressWords(inProgress)}
      </p>
    </header>
  );
}

export default Header;
