import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useFocusTrap } from "../hooks/useFocusTrap";

function TestModal({ onClose }: { onClose: () => void }) {
  const ref = useFocusTrap<HTMLDivElement>(onClose);
  return (
    <div ref={ref} data-testid="modal">
      <button>First</button>
      <button>Last</button>
    </div>
  );
}

describe("useFocusTrap (P2 a11y — drawer focus trap)", () => {
  it("moves focus into the first focusable element on mount", () => {
    render(
      <div>
        <button>Outside</button>
        <TestModal onClose={() => {}} />
      </div>,
    );
    expect(screen.getByText("First")).toHaveFocus();
  });

  it("wraps Tab from the last focusable back to the first", () => {
    render(<TestModal onClose={() => {}} />);
    const last = screen.getByText("Last");
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(screen.getByText("First")).toHaveFocus();
  });

  it("wraps Shift+Tab from the first focusable back to the last", () => {
    render(<TestModal onClose={() => {}} />);
    const first = screen.getByText("First");
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(screen.getByText("Last")).toHaveFocus();
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    render(<TestModal onClose={onClose} />);
    fireEvent.keyDown(screen.getByTestId("modal"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the previously focused element once the trap unmounts", () => {
    function Wrapper({ show }: { show: boolean }) {
      return (
        <div>
          <button data-testid="trigger">Trigger</button>
          {show && <TestModal onClose={() => {}} />}
        </div>
      );
    }
    const { rerender } = render(<Wrapper show={false} />);
    screen.getByTestId("trigger").focus();
    expect(screen.getByTestId("trigger")).toHaveFocus();

    rerender(<Wrapper show={true} />);
    expect(screen.getByText("First")).toHaveFocus();

    rerender(<Wrapper show={false} />);
    expect(screen.getByTestId("trigger")).toHaveFocus();
  });
});
