import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EventItem } from "../src/chat/messages";
import { FileOpenContext } from "../src/chat/fileRef";
import type { StreamEvent } from "../../service/src/session/types";
import { summarizeEvent } from "../../service/src/workspace/summary";

const image = (path = "/tmp/one.png", over: Partial<StreamEvent> = {}): StreamEvent => ({
  kind: "tool_use",
  toolName: "ViewImage",
  toolUseId: "image-1",
  content: `**ViewImage** \`${path}\``,
  ...over,
});

describe("ViewImage paths", () => {
  it.each(["/tmp/one.png", "C:\\captures\\one image.png"])(
    "opens the displayed path through FileOpenContext: %s",
    (path) => {
      const open = vi.fn();
      const { getByRole, queryByRole } = render(
        <FileOpenContext.Provider value={open}>
          <EventItem ev={image(path, { toolResult: "" })} />
        </FileOpenContext.Provider>,
      );
      const ref = getByRole("button", { name: path });
      expect(ref.tagName).toBe("CODE");
      fireEvent.click(ref);
      expect(open).toHaveBeenCalledExactlyOnceWith(path, { literalPath: true });
      expect(queryByRole("button", { name: /open file/i })).toBeNull();
    },
  );

  it("retries loading a truncated summary, then opens the full path once", async () => {
    const path = `artifacts/${"nested/".repeat(30)}one.png`;
    const full = image(path, { toolResult: "" });
    const summary = summarizeEvent(full);
    expect(summary.content.endsWith("…")).toBe(true);
    const open = vi.fn();
    const load = vi.fn();
    const { container, rerender } = render(
      <FileOpenContext.Provider value={open}>
        <EventItem ev={summary} onLoadDetails={load} />
      </FileOpenContext.Provider>,
    );
    const truncated = container.querySelector(".event-summary-line code")!.textContent;
    fireEvent.click(container.querySelector(".event-summary-line code")!);
    expect(load).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    // A disconnected send is dropped; another activation must retry it.
    fireEvent.click(container.querySelector(".event-summary-line code")!);
    expect(load).toHaveBeenCalledTimes(2);
    expect(open).not.toHaveBeenCalled();

    rerender(
      <FileOpenContext.Provider value={open}>
        <EventItem ev={full} />
      </FileOpenContext.Provider>,
    );
    await waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith(path, { literalPath: true }));
    expect(open).not.toHaveBeenCalledWith(truncated, { literalPath: true });
  });

  it("loads every line of a multiline filename before opening", async () => {
    const path = "artifacts/one.png\nfinal.png";
    const full = image(path, { toolResult: "" });
    const summary = summarizeEvent(full);
    expect(summary.content.endsWith("…")).toBe(true);
    const open = vi.fn();
    const load = vi.fn();
    const { container, queryByRole, rerender } = render(
      <FileOpenContext.Provider value={open}>
        <EventItem ev={summary} onLoadDetails={load} />
      </FileOpenContext.Provider>,
    );
    expect(queryByRole("button", { name: "Details" })).toBeNull();
    fireEvent.click(container.querySelector(".event-summary-line code")!);
    expect(load).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();

    rerender(
      <FileOpenContext.Provider value={open}>
        <EventItem ev={full} />
      </FileOpenContext.Provider>,
    );
    await waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith(path, { literalPath: true }));
    expect(container.querySelector(".event-content")).toBeNull();
  });
});

describe.each(["live", "summary"] as const)("ViewImage %s results", (mode) => {
  const project = (event: StreamEvent) => (mode === "summary" ? summarizeEvent(event) : event);
  const load = () => (mode === "summary" ? vi.fn() : undefined);

  it.each(["", "done"])("hides the %j placeholder without hiding the path", (toolResult) => {
    const { container, queryByRole } = render(
      <EventItem ev={project(image(undefined, { toolResult }))} onLoadDetails={load()} />,
    );
    expect(queryByRole("button", { name: /^Result/ })).toBeNull();
    expect(container.querySelector(".event-result")).toBeNull();
    expect(container.querySelector(".event-summary-line code")?.textContent).toBe("/tmp/one.png");
  });

  it.each(["", "done"])("preserves an error even when its body is %j", (toolResult) => {
    const onLoadDetails = load();
    const { container, getByRole } = render(
      <EventItem
        ev={project(image(undefined, { toolResult, toolResultIsError: true }))}
        onLoadDetails={onLoadDetails}
      />,
    );
    fireEvent.click(getByRole("button", { name: /^Result/ }));
    if (mode === "live") expect(container.querySelector(".event-result")).not.toBeNull();
    else expect(onLoadDetails).toHaveBeenCalledOnce();
  });

  it.each(["real", "image rendered"])("preserves the real result %j", (toolResult) => {
    const onLoadDetails = load();
    const { container, getByRole } = render(
      <EventItem ev={project(image(undefined, { toolResult }))} onLoadDetails={onLoadDetails} />,
    );
    fireEvent.click(getByRole("button", { name: /^Result/ }));
    if (mode === "live") {
      expect(container.querySelector(".event-result")?.textContent).toContain(toolResult);
    } else {
      expect(onLoadDetails).toHaveBeenCalledOnce();
    }
  });
});
