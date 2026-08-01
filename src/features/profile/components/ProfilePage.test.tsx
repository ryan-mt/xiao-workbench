// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentAccountUsage,
  AgentRuntimeState,
  CodexUsageSnapshot,
} from "../../../core/models/agent";
import { ProfilePage } from "./ProfilePage";

const runtime: AgentRuntimeState = {
  phase: "ready",
  profileId: null,
  taskId: null,
  threadId: null,
  turnId: null,
  turnStartedAt: null,
  error: null,
  eventsSeen: 1,
};

const usage: CodexUsageSnapshot = {
  days: [],
  totals: {
    totalTokens: 21_574,
    inputTokens: 21_560,
    cachedInputTokens: 0,
    outputTokens: 14,
    reasoningOutputTokens: 0,
  },
  activeDays: 79,
  currentStreak: 13,
  longestStreak: 54,
};

const accountUsage: AgentAccountUsage = {
  lifetimeTokens: 11_413_655_391,
  peakDailyTokens: 722_860_000,
  longestRunningTurnSec: 6_300,
  currentStreakDays: 13,
  longestStreakDays: 54,
  dailyUsageBuckets: [],
};

describe("ProfilePage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("separates account-wide and on-device usage into independent sources", () => {
    const markup = renderToStaticMarkup(
      <ProfilePage
        accountUsage={accountUsage}
        profile={{ name: "Xiao", avatarDataUrl: null }}
        runtime={runtime}
        usage={usage}
        onClose={() => undefined}
        onSaveProfile={() => undefined}
      />,
    );

    expect(markup).toContain('class="profile-shell"');
    expect(markup).toContain('class="profile-source profile-account"');
    expect(markup).toContain('class="profile-source profile-device"');
    expect(markup).toContain("Codex account");
    expect(markup).toContain("This device");
    expect(markup).toContain("Edit profile");
    expect(markup).toContain("Activity");
    expect(markup).toContain("Recorded locally");
    expect(markup).toContain("Sources are independent");
    expect(markup).toContain("11.41B");
    expect(markup).toContain('role="grid"');
    expect(markup).not.toContain("profile-sidebar");
    expect(markup).not.toContain("Runtime</dt>");
  });

  it("renders 365 real local dates aligned to the Sunday-first grid", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 20, 12));
    const calendarUsage: CodexUsageSnapshot = {
      ...usage,
      days: [
        {
          date: "2025-07-21",
          totalTokens: 10,
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        {
          date: "2026-07-20",
          totalTokens: 5,
          inputTokens: 5,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
      ],
    };

    const markup = renderToStaticMarkup(
      <ProfilePage
        accountUsage={null}
        profile={{ name: "Xiao", avatarDataUrl: null }}
        runtime={runtime}
        usage={calendarUsage}
        onClose={() => undefined}
        onSaveProfile={() => undefined}
      />,
    );

    expect(markup.match(/data-date="/g)).toHaveLength(365);
    expect(markup.match(/contribution-day--placeholder/g)).toHaveLength(1);
    expect(markup).toMatch(/class="contribution-day level-4"[^>]*data-date="2025-07-21"/);
    expect(markup).toMatch(/class="contribution-day level-2"[^>]*data-date="2026-07-20"/);
  });

  it("keeps the avatar from the last selection when image loads finish out of order", async () => {
    const readers: Array<FileReader & { complete: (result: string) => void }> = [];
    const images: Array<HTMLImageElement & { completeLoad: () => void }> = [];
    class DeferredReader {
      result: string | ArrayBuffer | null = null;
      onerror: FileReader["onerror"] = null;
      onload: FileReader["onload"] = null;
      complete = (result: string) => {
        this.result = result;
        this.onload?.call(
          this as unknown as FileReader,
          new ProgressEvent("load") as ProgressEvent<FileReader>,
        );
      };
      readAsDataURL() {}
      constructor() { readers.push(this as unknown as FileReader & { complete: (result: string) => void }); }
    }
    class DeferredImage {
      naturalWidth = 256;
      naturalHeight = 256;
      onerror: OnErrorEventHandler = null;
      onload: ((this: GlobalEventHandlers, ev: Event) => unknown) | null = null;
      src = "";
      completeLoad = () => this.onload?.call(this as unknown as GlobalEventHandlers, new Event("load"));
      constructor() { images.push(this as unknown as HTMLImageElement & { completeLoad: () => void }); }
    }
    vi.stubGlobal("FileReader", DeferredReader);
    vi.stubGlobal("Image", DeferredImage);
    let source = "";
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: (image: HTMLImageElement) => { source = image.src; },
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockImplementation(() => `avatar:${source}`);

    render(<ProfilePage
      accountUsage={null}
      profile={{ name: "Xiao", avatarDataUrl: null }}
      runtime={runtime}
      usage={usage}
      onClose={() => undefined}
      onSaveProfile={() => undefined}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(["first"], "first.png", { type: "image/png" })] } });
    fireEvent.change(input, { target: { files: [new File(["second"], "second.png", { type: "image/png" })] } });

    act(() => readers[1].complete("second"));
    act(() => images[0].completeLoad());
    await waitFor(() => expect(screen.getByAltText("Profile preview").getAttribute("src")).toBe("avatar:second"));

    act(() => readers[0].complete("first"));
    act(() => images[1].completeLoad());

    expect(screen.getByAltText("Profile preview").getAttribute("src")).toBe("avatar:second");
  });
});
