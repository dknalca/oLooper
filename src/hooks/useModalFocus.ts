import { useEffect } from "react";

/** A single focus/inert contract for existing and future application dialogs. */
export default function useModalFocus() {
  useEffect(() => {
    let dialog: HTMLElement | null = null;
    let previous: HTMLElement | null = null;
    const inert = new Map<HTMLElement, { inert: boolean; hidden: string | null }>();
    const controls = () => dialog ? Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]',
    )).filter((element) => element.getClientRects().length > 0) : [];
    const restore = () => {
      for (const [element, value] of inert) {
        element.inert = value.inert;
        if (value.hidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", value.hidden);
      }
      inert.clear();
    };
    const update = () => {
      const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
      const next = dialogs.length ? dialogs[dialogs.length - 1] : null;
      if (next === dialog) return;
      restore();
      if (dialog && previous?.isConnected) previous.focus();
      dialog = next;
      if (!dialog) return;
      previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      let node: HTMLElement = dialog;
      while (node.parentElement) {
        for (const sibling of node.parentElement.children) {
          if (sibling !== node && sibling instanceof HTMLElement) {
            inert.set(sibling, { inert: sibling.inert, hidden: sibling.getAttribute("aria-hidden") });
            sibling.inert = true;
            sibling.setAttribute("aria-hidden", "true");
          }
        }
        node = node.parentElement;
      }
      dialog.tabIndex = -1;
      const items = controls();
      (items.find((element) => element.hasAttribute("data-dialog-initial-focus")) ?? items[0] ?? dialog).focus();
    };
    const key = (event: KeyboardEvent) => {
      if (!dialog) return;
      if (event.key === "Escape") {
        const close = dialog.querySelector<HTMLButtonElement>('button.dialog-close:not([disabled])');
        if (close) { event.preventDefault(); event.stopImmediatePropagation(); close.click(); }
      }
      if (event.key !== "Tab") return;
      const items = controls();
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : (index + 1) % items.length;
      event.preventDefault();
      (items[next] ?? dialog).focus();
    };
    const focus = (event: FocusEvent) => {
      if (dialog && !dialog.contains(event.target as Node)) (controls()[0] ?? dialog).focus();
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("keydown", key, true);
    document.addEventListener("focusin", focus, true);
    update();
    return () => {
      observer.disconnect(); restore();
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("focusin", focus, true);
    };
  }, []);
}
