// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ProvenyxRD

import { useEffect, useState } from "react";
import emblem from "../assets/lexescrow-emblem.png";

/**
 * Launch splash. Full-window near-black backdrop with the LexEscrow emblem,
 * wordmark, and tagline, plus a gold progress bar that fills over ~2s. After
 * 2 seconds it fades out (500ms) and calls `onFinish` to reveal the app. No
 * click needed.
 */
export function Splash({ onFinish }: { onFinish: () => void }) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const fade = setTimeout(() => setLeaving(true), 2000);
    const done = setTimeout(() => onFinish(), 2500);
    return () => {
      clearTimeout(fade);
      clearTimeout(done);
    };
  }, [onFinish]);

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-app-bg transition-opacity duration-500 ${
        leaving ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
    >
      <img
        src={emblem}
        alt="LexEscrow"
        width={320}
        height={320}
        className="splash-emblem h-80 w-80 select-none"
        draggable={false}
      />

      <h1 className="mt-2 text-5xl font-bold tracking-tight text-gold">LexEscrow</h1>

      <p className="mt-3 text-sm font-medium uppercase tracking-[0.28em] text-text-muted">
        Legal Trust. On-Chain.
      </p>

      <div className="mt-9 h-1 w-52 overflow-hidden rounded-full bg-app-input">
        <div className="splash-bar h-full rounded-full bg-gradient-to-r from-gold to-gold-light" />
      </div>
    </div>
  );
}
