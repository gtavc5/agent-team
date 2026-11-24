import type { Fixture } from "./fixture.ts";

// Capture and replay share the public inputs; replies come only from Pi stdout.
export const captures = {
  "antigravity-acp-turn": {
    description: "Antigravity ACP emits reasoning and a read tool call before settlement.",
    steps: [
      { op: "send", text: "Read fixture.ts with the read tool and quote the value in it." },
      { op: "check", name: "stats" },
    ],
  },
  "tools-bash-edit": {
    description: "Pi built-ins preserve full Markdown arguments and structured file inputs.",
    steps: [
      {
        op: "send",
        text: "Use bash to run exactly pwd with timeout 4. Then read fixture.ts. Use edit to change sample to example in fixture.ts. Finally use grep for example in fixture.ts. Use each tool once and finish.",
      },
    ],
  },
  "single-queue-order": {
    description: "Without a steering boundary, Pi dispatches queued prompts FIFO after settlement.",
    steps: [
      { op: "send", text: "First prompt." },
      { op: "send", text: "Second prompt." },
      { op: "send", text: "Third prompt." },
      { op: "check", name: "queued" },
      { op: "check", name: "second" },
      { op: "check", name: "third" },
    ],
  },
  "basic-turn": {
    description: "Pi streams thinking and text, then settles with usage and context.",
    steps: [
      { op: "send", text: "Compute 317 times 293 minus 784. Answer with the number only." },
      { op: "check", name: "stats" },
    ],
  },
  "image-prompt": {
    description: "Pi reads a seeded, temporary 1×1 PNG through the workspace attachment envelope.",
    steps: [
      { op: "image", text: "Describe this pixel.", seed: 17 },
      { op: "check", name: "dispatched" },
      { op: "check", name: "retained" },
    ],
  },
  "extension-ui-dialog": {
    description: "A blocking extension dialog still allows stdout frames before the user responds.",
    steps: [
      { op: "send", text: "Calculate 313 times 291 minus 511 and reply with just the number." },
      { op: "check", name: "dialogOpen" },
      { op: "uiDialogResponse", requestId: "confirmation", confirmed: true },
    ],
  },
  "interrupt-abort": {
    description: "An interrupt sends abort alone and settles as interrupted.",
    steps: [
      { op: "send", text: "Start a reply." },
      { op: "interrupt" },
      { op: "check", name: "aborting" },
    ],
  },
} satisfies Record<string, Fixture>;
