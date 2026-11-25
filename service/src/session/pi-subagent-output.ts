import * as fs from "node:fs";
import * as path from "node:path";

const METADATA_LIMIT = 1024 * 1024;
const SESSION_TAIL_LIMIT = 256 * 1024;
const OUTPUT_LIMIT = 64 * 1024;

export interface PiSubagentOutputRequest {
  resultsDir: string;
  runId: string;
  stepIndex: number;
  ownsSession: (sessionId: string) => boolean;
  // Host-known roots only, never roots supplied by a completion record or result.
  artifactRoots?: readonly string[];
  sessionRoots?: readonly string[];
  now?: number;
}

export interface PiSubagentFinalOutput {
  text: string;
  truncated: boolean;
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

function relativeFile(root: string, file: string): string | undefined {
  const relative = path.relative(root, file);
  if (
    relative &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  ) {
    return relative;
  }
}

function readContained<T>(
  file: string,
  roots: readonly string[],
  read: (fd: number, size: number) => T | undefined,
): T | undefined {
  if (!path.isAbsolute(file)) return;
  for (const root of roots) {
    if (!path.isAbsolute(root)) continue;
    const relative = relativeFile(root, file);
    if (!relative) continue;
    let fd: number | undefined;
    try {
      if (!fs.lstatSync(root).isDirectory()) continue;
      const expected = path.join(fs.realpathSync(root), relative);
      const before = fs.lstatSync(file);
      if (!before.isFile() || before.nlink !== 1 || fs.realpathSync(file) !== expected) continue;
      fd = fs.openSync(
        expected,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
      );
      const opened = fs.fstatSync(fd);
      // Confirm that opening the path did not cross a replaced file or directory.
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        fs.realpathSync(expected) !== expected
      )
        continue;
      return read(fd, opened.size);
    } catch {
      // Files may have expired, moved or been removed while the run was closing.
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}

function readBytes(fd: number, length: number, start = 0): Buffer | undefined {
  const buffer = Buffer.allocUnsafe(length);
  for (let offset = 0; offset < length;) {
    const n = fs.readSync(fd, buffer, offset, length - offset, start + offset);
    if (n === 0) return;
    offset += n;
  }
  return buffer;
}

function readMetadata(file: string, root: string): Record<string, unknown> | undefined {
  return readContained(file, [root], (fd, size) => {
    if (size > METADATA_LIMIT) return;
    const bytes = readBytes(fd, size);
    if (bytes) return object(JSON.parse(bytes.toString("utf8")));
  });
}

function decodeUtf8Tail(bytes: Buffer): string {
  let start = 0;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.toString("utf8", start);
}

function boundedOutput(text: string, partial = false): PiSubagentFinalOutput | undefined {
  if (!text.trim()) return;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= OUTPUT_LIMIT) return { text, truncated: partial };
  return { text: decodeUtf8Tail(bytes.subarray(-OUTPUT_LIMIT)), truncated: true };
}

function readOutputArtifact(file: string, roots: readonly string[], partial: boolean) {
  return readContained(file, roots, (fd, size) => {
    const start = Math.max(size - OUTPUT_LIMIT, 0);
    const bytes = readBytes(fd, size - start, start);
    if (bytes) return boundedOutput(decodeUtf8Tail(bytes), partial || start > 0);
  });
}

function readSessionOutput(file: string, roots: readonly string[], partial: boolean) {
  if (path.extname(file) !== ".jsonl") return;
  return readContained(file, roots, (fd, size) => {
    const head = readBytes(fd, Math.min(size, 4096));
    const headerEnd = head?.indexOf(0x0a) ?? -1;
    if (!head || headerEnd === -1) return;
    const header = object(JSON.parse(head.toString("utf8", 0, headerEnd)));
    if (header?.type !== "session" || header.version !== 3) return;

    const start = Math.max(size - SESSION_TAIL_LIMIT, 0);
    const tail = readBytes(fd, size - start, start);
    if (!tail) return;
    const firstNewline = tail.indexOf(0x0a);
    if (firstNewline === -1) return;
    const entries = new Map<string, Record<string, unknown>>();
    let leaf: Record<string, unknown> | undefined;
    // Skip the header, or the record potentially split by the byte window.
    for (const line of tail.toString("utf8", firstNewline + 1).split("\n")) {
      if (!line.trim()) continue;
      const entry = object(JSON.parse(line));
      if (typeof entry?.id !== "string" || entries.has(entry.id)) return;
      entries.set(entry.id, entry);
      leaf = entry;
    }
    // Walk only the active branch, not older sibling replies or tool output.
    while (leaf && typeof leaf.id === "string") {
      if (leaf.type === "message") {
        const message = object(leaf.message);
        if (
          message?.role !== "assistant" ||
          message.errorMessage ||
          message.stopReason === "error" ||
          message.stopReason === "aborted" ||
          message.stopReason === "toolUse"
        )
          return;
        const text =
          typeof message.content === "string"
            ? message.content
            : Array.isArray(message.content)
              ? message.content
                  .flatMap((value: unknown) => {
                    const part = object(value);
                    return part?.type === "text" && typeof part.text === "string"
                      ? [part.text]
                      : [];
                  })
                  .join("\n")
              : "";
        return boundedOutput(text, partial || message.stopReason === "length");
      }
      entries.delete(leaf.id);
      leaf = typeof leaf.parentId === "string" ? entries.get(leaf.parentId) : undefined;
    }
  });
}

/** Read only canonical, unexpired pi-subagents completion output attributable to one step. */
export function readPiSubagentFinalOutput(
  request: PiSubagentOutputRequest,
): PiSubagentFinalOutput | undefined {
  const { resultsDir, runId, stepIndex, ownsSession, now = Date.now() } = request;
  if (
    !path.isAbsolute(resultsDir) ||
    !runId ||
    runId.length > 255 ||
    !Number.isSafeInteger(stepIndex) ||
    stepIndex < 0
  )
    return;
  let fileName: string;
  try {
    fileName = `${encodeURIComponent(runId)}.json`;
  } catch {
    return;
  }
  if (fileName.length > 255) return;

  const archivePath = path.join(resultsDir, "output-archives", fileName);
  const replay = readMetadata(path.join(resultsDir, "completion-replay", fileName), resultsDir);
  const completion = object(replay?.completion);
  if (
    replay?.version !== 1 ||
    replay.runId !== runId ||
    completion?.runId !== runId ||
    typeof replay.sessionId !== "string" ||
    !replay.sessionId ||
    !ownsSession(replay.sessionId) ||
    typeof replay.completedAt !== "number" ||
    !Number.isFinite(replay.completedAt) ||
    typeof replay.expiresAt !== "number" ||
    !Number.isFinite(replay.expiresAt) ||
    replay.expiresAt <= now ||
    replay.archivePath !== archivePath ||
    completion.archivePath !== archivePath
  )
    return;
  const child = Array.isArray(completion.results)
    ? object(completion.results[stepIndex])
    : undefined;
  if (!child) return;
  const archive = readMetadata(archivePath, resultsDir);
  if (
    archive?.version !== 1 ||
    archive.runId !== runId ||
    archive.createdAt !== replay.completedAt ||
    !Array.isArray(archive.entries)
  )
    return;

  // Unindexed summaries and agent names do not identify a child. Fail closed on duplicates.
  const entries = archive.entries.map(object).filter((entry) => entry?.resultIndex === stepIndex);
  const [entry] = entries;
  if (entries.length !== 1 || !entry || entry.agent !== child.agent) return;
  const partial = entry.truncated === true || child.outputPartial === true;
  if (entry.source === "result-tail" && typeof entry.text === "string") {
    return boundedOutput(entry.text, partial);
  }
  if (typeof entry.path !== "string") return;
  if (
    entry.source === "output-artifact" &&
    entry.path === object(child.artifactPaths)?.outputPath
  ) {
    return readOutputArtifact(entry.path, request.artifactRoots ?? [], partial);
  }
  if (entry.source === "session" && entry.path === child.sessionFile) {
    return readSessionOutput(entry.path, request.sessionRoots ?? [], partial);
  }
}
