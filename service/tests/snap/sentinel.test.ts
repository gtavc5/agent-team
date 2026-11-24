import { readFileSync, readdirSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { steerReceipt, validateTurn } from "./pi-capture-contract";
import { piFrames } from "./pi-wire";
import { sanitizer } from "../../../scripts/capture-pi";
import { describe, expect, it } from "vitest";

const PI_DIR = fileURLToPath(new URL("./pi/", import.meta.url));
const allowedNames = new Set([
  "child.jsonl",
  "example.txt",
  "pixel.png",
  "fixture.ts",
  "pi-captures.ts",
]);

function privateHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return (
    !/(?:^|\.)(?:localhost|test|example|invalid)$/.test(name) &&
    !/(?:^|\.)example\.(?:com|net|org)$/.test(name)
  );
}

function publicIPv4(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const [a, b, c] = ip.split(".").map(Number);
  return !(
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function sourceStrings(text: string): string[] {
  const strings: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) strings.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest));
  return strings;
}

function audit(text: string, source = false): string[] {
  const violations = new Set<string>();
  if (/\/Users\/|\/home\/|[a-z]:\\+Users\\+/i.test(text)) violations.add("host path");
  if (/sk-|ghp_|AIza|ya29\.|Bearer [A-Za-z0-9._-]{20,}|BEGIN [^\r\n]*PRIVATE KEY/.test(text))
    violations.add("credential");
  if (/data:image\/|["']?\bdata\\?["']?\s*:\s*\\?["'][A-Za-z0-9+/_-]{101,}/i.test(text))
    violations.add("image payload");
  for (const [email] of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g))
    if (privateHost(email.split("@")[1])) violations.add("private email");
  for (const [address] of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g))
    if (publicIPv4(address)) violations.add("non-test IPv4");
  for (const [address] of text.matchAll(/(?<![\w:])[\da-f]*(?::[\da-f]*){2,}(?![\w:])/gi)) {
    if (isIP(address) === 6 && !/^(?:2001:db8:|::1$|f[cd])/i.test(address))
      violations.add("non-test IPv6");
  }
  // URL hosts include single-label private hosts. For standalone names, match
  // DNS suffixes typical of private or public hosts rather than TS member access.
  for (const [, host] of text.matchAll(/\b(?:https?|wss?|ssh):\/\/(?:[^\s/@]+@)?([\w.-]+)/gi))
    if (!isIP(host) && privateHost(host)) violations.add("private domain");
  for (const [name] of text.matchAll(
    /\b(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+(?:com|org|net|io|dev|ai|app|edu|gov|co|uk|cn|me|local|lan|internal|corp|intranet|home|arpa)\b/gi,
  ))
    if (privateHost(name)) violations.add("private domain");
  // In fixture sources, distinguish string data from TypeScript property access.
  // Tapes and snapshots contain only data, so all DNS-shaped names are audited.
  for (const payload of source ? sourceStrings(text) : [text]) {
    for (const [name] of payload.matchAll(
      /\b(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z][a-z\d-]{1,62}\b/gi,
    )) {
      if (!allowedNames.has(name.toLowerCase()) && privateHost(name))
        violations.add("private domain");
    }
  }
  return [...violations];
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

describe("Pi golden fixture privacy sentinel", () => {
  it("audits every tape, snapshot and fixture source without printing sensitive matches", () => {
    const paths = [...files(PI_DIR), join(PI_DIR, "../pi-captures.ts")];
    expect(paths.filter((file) => file.endsWith(".snap.md"))).toHaveLength(12);
    for (const path of paths) {
      expect(path).toMatch(/\.(?:jsonl|snap\.md|ts)$/);
      expect(
        audit(readFileSync(path, "utf8"), path.endsWith(".ts")),
        path.slice(PI_DIR.length),
      ).toEqual([]);
    }
  });

  it("rejects unexpected steer receipt details without printing them", () => {
    const [receipt] = piFrames("messages/steer");
    expect(steerReceipt(receipt)).toEqual(receipt);
    expect(() =>
      steerReceipt({ ...receipt, data: { disposition: "queued", details: "private" } }),
    ).toThrow("Unreviewed steer response");
  });

  it.each([
    "basic-turn",
    "antigravity-acp-turn",
    "tools-bash-edit",
    "interrupt-abort",
    "extension-ui-dialog",
    "image-prompt",
    "single-queue-order",
  ])("requires %s evidence before replacing its tape", (name) => {
    const frames = piFrames(name);
    validateTurn(name, frames);
    expect(() =>
      validateTurn(
        name,
        frames.filter((f) => !["agent_settled", "tool_execution_start"].includes(f.type)),
      ),
    ).toThrow();
    if (name === "tools-bash-edit" || name === "antigravity-acp-turn")
      expect(() =>
        validateTurn(
          name,
          frames.filter((f) => f.type !== "tool_execution_start"),
        ),
      ).toThrow(/tool calls/);
  });

  it("does not publish numeric payloads under familiar field names in tool arguments", () => {
    const args = { input: [65, 66, 67], usage: { input: 987654 }, limit: 12345 };
    expect(sanitizer()({ type: "toolCall", name: "extension", arguments: args })).toMatchObject({
      arguments: { input: [0, 0, 0], usage: { input: 0 }, limit: 0 },
    });
  });

  it.each([
    ["host path", "/Users/sentinel/work"],
    ["host path", "/home/sentinel/work"],
    ["host path", "C:\\\\Users\\\\sentinel"],
    ["credential", "sk-synthetic-sentinel"],
    ["credential", "ghp_synthetic"],
    ["credential", "AIzaSynthetic"],
    ["credential", "ya29.synthetic"],
    ["credential", "Bearer " + "x".repeat(20)],
    ["credential", "BEGIN OPENSSH PRIVATE KEY"],
    ["image payload", "data:image/png;base64," + "A".repeat(110)],
    ["image payload", JSON.stringify({ data: "A".repeat(101) })],
    ["image payload", JSON.stringify(JSON.stringify({ data: "A".repeat(101) }))],
    ["private email", "synthetic-user@sentinel.internal"],
    ["private domain", "build.sentinel.internal"],
    ["private domain", "https://sentinel/"],
    ["private domain", "private.sentinel.museum"],
    ["non-test IPv4", "11.0.0.1"],
    ["non-test IPv6", "[2600::1]"],
  ])("detects injected %s sentinel", (kind, sample) => {
    expect(audit(sample)).toContain(kind);
  });

  it("audits literals without misidentifying TypeScript property chains as host names", () => {
    expect(
      audit('const label = r.checkpoints.stats; const host = "private.sentinel.museum";', true),
    ).toEqual(["private domain"]);
    expect(audit("const label = r.checkpoints.stats;", true)).toEqual([]);
  });

  it("allows documentation addresses, RFC1918 test hosts and reserved domains", () => {
    expect(
      audit(
        "user@example.com api.synthetic.test 192.0.2.9 198.51.100.9 203.0.113.9 10.1.2.3 172.31.1.1 192.168.1.1 [2001:db8::9]",
      ),
    ).toEqual([]);
  });
});
