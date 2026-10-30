/* Registers the service worker and keeps the page it serves current. A new worker installs and takes control by itself (see sw.ts), but a page already open keeps the scripts and markup it loaded from the old version, so once a new worker has taken control the page reloads, never while the visitor is looking at it. */

/**
 * Registers the worker and arranges for the page to follow it when it updates. A browser looks for a new worker when a page loads and at most once a day beyond that, so a tab left open also asks when it becomes visible again.
 * @param root - The path back to the site root.
 */
export function registerServiceWorker(root: string): void {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  const { serviceWorker } = navigator;
  // The first worker to take control of a page is not an update: the page it controls is already the current version.
  const hadController = serviceWorker.controller !== null;
  let reloading = false;
  const reload = (): void => {
    if (!reloading) {
      reloading = true;
      location.reload();
    }
  };
  serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) {
      return;
    }
    if (document.visibilityState === "hidden") {
      reload();
    } else {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          reload();
        }
      });
    }
  });
  void serviceWorker.register(`${root}sw.js`, { scope: root === "" ? "./" : root }).then((registration) => {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        void registration.update();
      }
    });
  });
}
