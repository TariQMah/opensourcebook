import { useEffect, useState } from "react";

let asked: Promise<boolean> | undefined;

/**
 * Whether this page is open in the browser on the computer Open Sourcebook runs on, as the proxy says (`/api/session`,
 * `as: "browser"`), and not on a paired phone. Asked once a page load; false until it answers, and when it cannot.
 */
export function onThisComputer(fetchImpl: typeof fetch = globalThis.fetch): Promise<boolean> {
  asked ??= fetchImpl("/api/session", { credentials: "same-origin", cache: "no-store" })
    .then(async (r) => r.ok && ((await r.json()) as { as?: string }).as === "browser")
    .catch(() => false);
  return asked;
}

/** For tests: the next call asks again. */
export function forgetThisComputer(): void {
  asked = undefined;
}

export function useThisComputer(): boolean {
  const [here, setHere] = useState(false);
  useEffect(() => {
    let live = true;
    void onThisComputer().then((yes) => live && setHere(yes));
    return () => {
      live = false;
    };
  }, []);
  return here;
}
