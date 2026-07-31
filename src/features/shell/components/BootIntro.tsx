import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type AnimationEvent,
  type CSSProperties,
  type ReactNode,
} from "react";

import { APP_DISPLAY_NAME } from "../../../core/branding";

import "../styles/boot-intro.css";

/** Full cinematic boot when motion is allowed. */
export const BOOT_INTRO_DURATION_MS = 2_450;
/** Instant settle path for reduced-motion / forced skip. */
export const BOOT_INTRO_REDUCED_MS = 280;
/** Overlay dissolve after the main sequence. */
export const BOOT_INTRO_EXIT_MS = 520;
export const BOOT_INTRO_EXIT_REDUCED_MS = 120;
/** Safety cap so a stuck animation never blocks the desk. */
export const BOOT_INTRO_FAILSAFE_MS = 4_200;

export const XIAO_MARK_SRC = "/xiao-mark.png";

export type BootIntroPhase = "playing" | "exiting" | "done";

export type BootIntroProps = {
  children: ReactNode;
  /** Force-skip without waiting for the sequence (tests / debug). */
  disabled?: boolean;
  /** Override reduced-motion detection (tests). */
  preferReducedMotion?: boolean;
  onComplete?: () => void;
};

const readPrefersReducedMotion = () => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

export function bootIntroDurationMs(preferReducedMotion: boolean): number {
  return preferReducedMotion ? BOOT_INTRO_REDUCED_MS : BOOT_INTRO_DURATION_MS;
}

export function bootIntroExitMs(preferReducedMotion: boolean): number {
  return preferReducedMotion ? BOOT_INTRO_EXIT_REDUCED_MS : BOOT_INTRO_EXIT_MS;
}

/**
 * Exclusive cold-open for Xiao: mycelium filaments converge on the real
 * mushroom mark, then the workbench settles in underneath. Children mount
 * immediately so project/state hydration is not blocked.
 */
export function BootIntro({
  children,
  disabled = false,
  preferReducedMotion,
  onComplete,
}: BootIntroProps) {
  const reduced =
    typeof preferReducedMotion === "boolean"
      ? preferReducedMotion
      : readPrefersReducedMotion();
  const [phase, setPhase] = useState<BootIntroPhase>(() =>
    disabled ? "done" : "playing",
  );
  const completedRef = useRef(disabled);
  const onCompleteRef = useRef(onComplete);
  const titleId = useId();

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  const finish = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    setPhase("done");
    onCompleteRef.current?.();
  }, []);

  const beginExit = useCallback(() => {
    if (completedRef.current) return;
    setPhase((current) => {
      if (current === "done" || current === "exiting") return current;
      return "exiting";
    });
  }, []);

  useEffect(() => {
    if (disabled || phase === "done") return;

    if (phase === "playing") {
      const duration = bootIntroDurationMs(reduced);
      const exitTimer = window.setTimeout(beginExit, duration);
      const failsafeTimer = window.setTimeout(finish, BOOT_INTRO_FAILSAFE_MS);
      return () => {
        window.clearTimeout(exitTimer);
        window.clearTimeout(failsafeTimer);
      };
    }

    if (phase === "exiting") {
      const settleTimer = window.setTimeout(finish, bootIntroExitMs(reduced));
      return () => window.clearTimeout(settleTimer);
    }

    return undefined;
  }, [beginExit, disabled, finish, phase, reduced]);

  const handleOverlayAnimationEnd = (event: AnimationEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (phase !== "exiting") return;
    const name = event.animationName;
    if (name.includes("xiao-boot-overlay-exit")) {
      finish();
    }
  };

  if (phase === "done") {
    return <>{children}</>;
  }

  const durationMs = bootIntroDurationMs(reduced);
  const style = {
    "--xiao-boot-duration": `${durationMs}ms`,
  } as CSSProperties;

  return (
    <div
      className="xiao-boot-root"
      data-boot-phase={phase}
      data-reduced={reduced ? "true" : "false"}
    >
      <div
        aria-hidden={true}
        className="xiao-boot-app"
        data-boot-veil={phase === "exiting" ? "lifting" : "held"}
      >
        {children}
      </div>

      <div
        aria-labelledby={titleId}
        aria-live="polite"
        aria-busy={phase === "playing"}
        className="xiao-boot-overlay"
        data-phase={phase}
        data-reduced={reduced ? "true" : "false"}
        onAnimationEnd={handleOverlayAnimationEnd}
        role="dialog"
        style={style}
      >
        <div className="xiao-boot-atmosphere" aria-hidden="true">
          <span className="xiao-boot-glow xiao-boot-glow--a" />
          <span className="xiao-boot-glow xiao-boot-glow--b" />
          <span className="xiao-boot-grain" />
        </div>

        <svg
          aria-hidden="true"
          className="xiao-boot-mycelium"
          viewBox="0 0 720 420"
          xmlns="http://www.w3.org/2000/svg"
        >
          <g className="xiao-boot-mycelium__web" fill="none" strokeLinecap="round">
            <path className="xiao-boot-filament xiao-boot-filament--1" pathLength={1} d="M48 318 C140 290, 210 250, 360 210" />
            <path className="xiao-boot-filament xiao-boot-filament--2" pathLength={1} d="M672 312 C580 284, 500 246, 360 210" />
            <path className="xiao-boot-filament xiao-boot-filament--3" pathLength={1} d="M96 96 C170 140, 250 180, 360 210" />
            <path className="xiao-boot-filament xiao-boot-filament--4" pathLength={1} d="M624 88 C550 138, 470 176, 360 210" />
            <path className="xiao-boot-filament xiao-boot-filament--5" pathLength={1} d="M40 210 C140 210, 240 210, 360 210" />
            <path className="xiao-boot-filament xiao-boot-filament--6" pathLength={1} d="M680 210 C580 210, 470 210, 360 210" />
            <path className="xiao-boot-filament xiao-boot-filament--7" pathLength={1} d="M180 360 C240 300, 300 250, 360 210" />
            <path className="xiao-boot-filament xiao-boot-filament--8" pathLength={1} d="M540 360 C480 300, 420 250, 360 210" />
            <path className="xiao-boot-filament xiao-boot-filament--9" pathLength={1} d="M300 40 C320 110, 340 160, 360 210" />
            <path className="xiao-boot-filament xiao-boot-filament--10" pathLength={1} d="M420 40 C400 110, 380 160, 360 210" />
          </g>
          <g className="xiao-boot-nodes" fill="currentColor">
            <circle className="xiao-boot-node xiao-boot-node--1" cx="48" cy="318" r="2.4" />
            <circle className="xiao-boot-node xiao-boot-node--2" cx="672" cy="312" r="2.4" />
            <circle className="xiao-boot-node xiao-boot-node--3" cx="96" cy="96" r="2.2" />
            <circle className="xiao-boot-node xiao-boot-node--4" cx="624" cy="88" r="2.2" />
            <circle className="xiao-boot-node xiao-boot-node--5" cx="40" cy="210" r="2" />
            <circle className="xiao-boot-node xiao-boot-node--6" cx="680" cy="210" r="2" />
            <circle className="xiao-boot-node xiao-boot-node--7" cx="180" cy="360" r="2.1" />
            <circle className="xiao-boot-node xiao-boot-node--8" cx="540" cy="360" r="2.1" />
            <circle className="xiao-boot-node xiao-boot-node--9" cx="300" cy="40" r="1.8" />
            <circle className="xiao-boot-node xiao-boot-node--10" cx="420" cy="40" r="1.8" />
            <circle className="xiao-boot-node xiao-boot-node--core" cx="360" cy="210" r="3.2" />
          </g>
        </svg>

        <div className="xiao-boot-mark-stage" aria-hidden="true">
          <div className="xiao-boot-mark-ring" />
          <div className="xiao-boot-mark-bloom" />
          <div className="xiao-boot-mark">
            <img
              alt=""
              className="xiao-boot-mark__img"
              draggable={false}
              height={180}
              src={XIAO_MARK_SRC}
              width={180}
            />
          </div>
        </div>

        <div className="xiao-boot-copy">
          <p className="xiao-boot-kicker">Local desk · Codex-native</p>
          <h1 className="xiao-boot-title" id={titleId}>
            {APP_DISPLAY_NAME}
          </h1>
          <p className="xiao-boot-status">
            <span className="xiao-boot-status__dot" />
            Waking the desk
          </p>
        </div>
      </div>
    </div>
  );
}