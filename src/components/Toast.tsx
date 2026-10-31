// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

/**
 * Transient confirmation that a click did something (Zustand).
 *
 * Exists for actions whose only outcome happens outside the window — a file
 * lands in ~/Downloads, a print dialog opens elsewhere — where the screen
 * otherwise stays perfectly still and the officer cannot tell a working button
 * from a broken one. It is deliberately not an error channel: failures belong
 * in the screen that owns them, where they persist and can be acted on. A toast
 * is gone in 2.5 seconds and has no affordance.
 *
 * A store rather than a context so `toast()` works from anywhere, including
 * outside React, and so a component that fires one needs no provider around it
 * in tests — with no `<Toaster />` mounted the call is simply inert.
 */

import { create } from "zustand";

/** Fully visible before the fade begins. */
const VISIBLE_MS = 2_500;
/** Fade duration. Must match the `duration-300` on the toast itself. */
const FADE_MS = 300;

interface Toast {
  id: number;
  message: string;
  /** Fading. Kept mounted through the transition, then dropped. */
  leaving: boolean;
}

interface ToastState {
  toasts: Toast[];
  show: (message: string) => void;
}

let nextId = 0;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  show: (message) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, message, leaving: false }] }));

    // Removal is scheduled per toast rather than swept globally: two clicks a
    // second apart each get their full 2.5s, instead of the second one cutting
    // the first one short.
    setTimeout(() => {
      set((s) => ({
        toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)),
      }));
    }, VISIBLE_MS);
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, VISIBLE_MS + FADE_MS);
  },
}));

/** Fire a toast. Safe to call from an event handler before the real work. */
export function toast(message: string): void {
  useToasts.getState().show(message);
}

/**
 * Mount once, at the app root.
 *
 * `aria-live="polite"` on the container rather than on each toast: the region
 * has to exist before the text is inserted for a screen reader to notice the
 * change, which is also why the container renders even when empty.
 */
export function Toaster() {
  const toasts = useToasts((s) => s.toasts);

  return (
    <div
      // `pointer-events-none` so a toast in the corner never swallows a click
      // meant for the UI underneath it.
      className="pointer-events-none fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          // `bg-app-card` rather than a darker one-off: a toast is an elevated
          // surface and the palette already has one. The heavier shadow is what
          // separates it from the cards it floats over.
          className={`rounded-lg border border-app-border bg-app-card px-4 py-2.5 text-sm
            font-medium text-white shadow-2xl shadow-black/60 transition-opacity duration-300
            motion-reduce:transition-none ${t.leaving ? "opacity-0" : "opacity-100"}`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
