import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Sidebar } from "../src/sidebar/Sidebar";

it("links a newly connected empty panel to human and machine-readable service diagnostics", () => {
  const noop = vi.fn();
  render(
    <Sidebar
      connected
      activeWsId={null}
      workspaces={[]}
      groupOverrides={{}}
      finishedStatus={{}}
      searchQuery=""
      searchHits={null}
      systemStatus={null}
      onSelect={noop}
      onDelete={noop}
      onToggleGroup={noop}
      onSearchChange={noop}
      onJump={noop}
      onCreate={noop}
      onCreateIn={noop}
      onReplayDemo={noop}
      onDebugSnapshot={noop}
      onPurgeArchived={noop}
    />,
  );
  expect(screen.getByRole("link", { name: "Service diagnostics" }).getAttribute("href")).toBe(
    "api/diagnostics?format=text",
  );
  expect(screen.getByRole("link", { name: "JSON" }).getAttribute("href")).toBe("api/diagnostics");
});
