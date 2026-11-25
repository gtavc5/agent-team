import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type Backend,
  SNAP_DIR,
  clientView,
  listFixtures,
  loadFixture,
  readRecording,
  recordingPath,
  replay,
  strip,
  transcript,
  agentMessages,
} from "./harness";

// Every <backend>/<name>.ts is one recorded interaction. The fixture's own
// verify() states why it exists; the pinned transcript catches everything
// else; the client aggregation must agree with the server's.
for (const backend of ["codex", "pi"] as Backend[]) {
  const names = listFixtures(backend);
  if (backend === "pi") {
    it("has all twelve Pi golden fixtures", () => {
      expect(names).toEqual([
        "antigravity-acp-turn",
        "basic-turn",
        "compaction-and-retry",
        "crash-and-restore",
        "extension-ui-dialog",
        "image-prompt",
        "interrupt-abort",
        "panel-tools-roundtrip",
        "pi-subagents-async",
        "pi-subagents-foreground",
        "single-queue-order",
        "tools-bash-edit",
      ]);
    });
  }
  const fixtures = await Promise.all(names.map((n) => loadFixture(backend, n)));
  describe(backend, () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
    afterEach(() => vi.useRealTimers());
    names.forEach((name, i) => {
      const fixture = fixtures[i];
      it(`${name}: ${fixture.description}`, async () => {
        const file = recordingPath(backend, name);
        if (!fs.existsSync(file)) {
          throw new Error(
            `${backend}/${name} has no recording; run: npm run capture -- ${backend} ${name}`,
          );
        }
        const rec = readRecording(file);
        expect(rec.header).toMatchObject({ backend, fixture: name });
        expect(rec.header.description, "description in the recording header").toBe(
          fixture.description,
        );
        if (backend === "pi") {
          expect(rec.header.source).toMatch(/pi --mode rpc|pi-deterministic E2E/);
          expect(rec.header.model).not.toMatch(/synthetic/);
          expect(Number.isFinite(Date.parse(rec.header.recordedAt))).toBe(true);
        }
        const result = await replay(backend, rec, fixture);
        if (backend === "pi") expect(fixture.verify).toBeTypeOf("function");
        fixture.verify?.(result);
        await expect(transcript(result.messages, backend)).toMatchFileSnapshot(
          path.join(SNAP_DIR, backend, `${name}.snap.md`),
        );
        const client = clientView(result.events, backend);
        const server = agentMessages(result);
        expect(client.length, "client message count").toBe(server.length);
        server.forEach((m, j) => {
          // Subagent summaries need Workspace's authoritative revision and count.
          // See broadcast.test.ts for their actual wire projection.
          expect(strip(client[j]), `message ${j + 1}`).toEqual(strip(m));
          if (backend === "pi") {
            // Asynchronous occupancy is tested through real workspace callbacks in broadcast.test.ts.
            const projection = ({ content, status, effort, thinking }: typeof m) => ({
              content,
              status,
              thinking,
              // Raw error events do not carry the effort from new_message.
              effort: status === "done" ? effort : undefined,
            });
            expect(projection(client[j]), `message ${j + 1} projection`).toEqual(projection(m));
          }
        });
      });
    });
  });
}
