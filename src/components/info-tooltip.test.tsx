// @vitest-environment jsdom
/**
 * InfoTooltip — the ⓘ explainer next to a field label.
 *
 * Driven through real clicks and key events rather than server-rendered,
 * because everything worth asserting here is a dismissal path. A popover that
 * opens is trivial; one that cannot be closed without hitting the ⓘ again is
 * the actual failure mode, and it only shows up under a real event loop.
 *
 * The external-link path is asserted against a mocked opener for the same
 * reason the vault tests use the real vault in reverse: what matters is *which*
 * mechanism is used, since a plain `<a href>` inside the desktop shell would
 * navigate the app window away from itself.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InfoTooltip } from "./InfoTooltip";

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (url: string) => openUrl(url) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const TIP = {
  title: "Chain ID",
  explanation: "A number that identifies the blockchain network.",
};

/** The ⓘ button, found the way a screen reader would announce it. */
const trigger = () => screen.getByRole("button", { name: /More information: Chain ID/i });

describe("InfoTooltip", () => {
  it("renders the ⓘ button", () => {
    render(<InfoTooltip {...TIP} />);

    const button = trigger();
    expect(button.textContent).toBe("ⓘ");
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows nothing but the button on first render", () => {
    render(<InfoTooltip {...TIP} />);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(TIP.explanation)).toBeNull();
  });

  it("opens a popover carrying both the title and the explanation", () => {
    render(<InfoTooltip {...TIP} />);
    fireEvent.click(trigger());

    const popover = screen.getByRole("dialog");
    expect(popover.textContent).toContain("Chain ID");
    expect(popover.textContent).toContain(TIP.explanation);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("closes again when the ⓘ is clicked a second time", () => {
    render(<InfoTooltip {...TIP} />);
    fireEvent.click(trigger());
    fireEvent.click(trigger());

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on a click outside itself", () => {
    render(
      <div>
        <InfoTooltip {...TIP} />
        <button type="button">elsewhere</button>
      </div>,
    );
    fireEvent.click(trigger());
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole("button", { name: "elsewhere" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays open for a click inside the popover — the text is selectable", () => {
    render(<InfoTooltip {...TIP} />);
    fireEvent.click(trigger());

    fireEvent.mouseDown(screen.getByText(TIP.explanation));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes on Escape", () => {
    render(<InfoTooltip {...TIP} />);
    fireEvent.click(trigger());

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ignores other keys", () => {
    render(<InfoTooltip {...TIP} />);
    fireEvent.click(trigger());

    fireEvent.keyDown(document, { key: "Enter" });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("renders a learn-more control when a URL is supplied", () => {
    render(<InfoTooltip {...TIP} learnMore="https://www.alchemy.com" />);
    fireEvent.click(trigger());

    expect(screen.getByRole("button", { name: /Learn more/i })).toBeTruthy();
  });

  it("omits the learn-more control when no URL is supplied", () => {
    render(<InfoTooltip {...TIP} />);
    fireEvent.click(trigger());

    expect(screen.queryByRole("button", { name: /Learn more/i })).toBeNull();
  });

  it("leaves the app window alone when opening a link outside Tauri", () => {
    // No `__TAURI_INTERNALS__` in jsdom, so this is the browser fallback path:
    // a new tab, opened with the opener severed.
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);

    render(<InfoTooltip {...TIP} learnMore="https://www.alchemy.com" />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: /Learn more/i }));

    expect(windowOpen).toHaveBeenCalledWith(
      "https://www.alchemy.com",
      "_blank",
      "noopener,noreferrer",
    );
    expect(openUrl).not.toHaveBeenCalled();
    windowOpen.mockRestore();
  });

  it("does not carry the ⓘ into the accessible name of the field it explains", () => {
    // The button is a sibling of the label, not a child of it. If that ever
    // inverts, this input stops being reachable by its own label text — and so
    // does every existing blockchain-config assertion.
    render(
      <div>
        <div className="flex items-center">
          <label htmlFor="chain">Chain ID</label>
          <InfoTooltip {...TIP} />
        </div>
        <input id="chain" defaultValue="11155111" />
      </div>,
    );

    const input = screen.getByLabelText(/^Chain ID$/) as HTMLInputElement;
    expect(input.value).toBe("11155111");
  });
});
