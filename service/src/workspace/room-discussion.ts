import {
  MAX_PEER_RELAY_HOPS,
  roomProse,
  type DiscussionLabel,
  type DiscussionRounds,
  type RoomAgent,
} from "../../../shared/room-targets";
import type { Message } from "./workspace";

const GUARDRAIL =
  "Peer discussion turn: discuss, verify, and critique the proposal only. Do not modify files, run mutating commands, or dispatch/start workers until the user confirms.";

const MAX_EXCERPT = 2_000;

export function roomExcerpt(text: string): string {
  return text.length <= MAX_EXCERPT ? text : `${text.slice(0, MAX_EXCERPT)}… [truncated]`;
}

export function conclusionOf(message: Message): string {
  let after = 0;
  for (const event of message.events ?? []) {
    if (["tool_use", "tool_result", "subagent_start"].includes(event.kind)) {
      after = Math.max(after, event.contentOffset ?? 0);
    }
  }
  return message.content.slice(after).trim();
}

export function roomUpdates(
  messages: readonly Message[],
  agents: ReadonlyMap<string, { info: RoomAgent }>,
  recipient: string,
  cursor: number,
  through: number,
  exclude?: ReadonlySet<string>,
): string {
  const updates = messages
    .filter((message) => {
      const sequence = message.roomSequence ?? 0;
      return (
        sequence > cursor &&
        sequence <= through &&
        !exclude?.has(message.id) &&
        message.agentId !== recipient &&
        !message.roomRecipients?.includes(recipient)
      );
    })
    .sort((a, b) => a.roomSequence! - b.roomSequence!)
    .map((message) => {
      const author = message.agentId
        ? (agents.get(message.agentId)?.info.name ?? message.roomAuthor)
        : "User";
      const text = message.kind === "agent" ? conclusionOf(message) : message.content.trim();
      return author && text ? `- ${author}: ${roomExcerpt(text).replace(/\n/g, "\n  ")}` : "";
    })
    .filter(Boolean);
  return updates.length
    ? `[Room updates since your last turn]\n${updates.join("\n")}\n[End room updates]`
    : "";
}

export interface DiscussionTurn {
  id: string;
  parentId: string;
  agentId: string;
  text: string;
  label: DiscussionLabel;
  covered: ReadonlySet<string>;
  through: number;
}

type Reply = { messageId: string; agentId: string; text: string };
type Participant = { inputId: string; reply?: Reply; pending: boolean };

interface Review {
  proposal: string;
  synthesizer?: string;
  rounds: 1 | 2;
  round: number;
  participants: Map<string, Participant>;
}

// Orchestrates rooms only. Workspace owns delivery, transcript and queue state.
// Nothing is scheduled here; a cancelled run cannot outlive its input ids.
export class RoomDiscussion {
  private review?: Review;
  private parentId = "";
  private relay = new Set<string>();
  private hop = 0;

  constructor(
    private readonly agents: () => RoomAgent[],
    private readonly clock: () => number,
    private readonly nextId: () => string,
    private readonly enqueue: (turn: DiscussionTurn) => void,
  ) {}

  cancel(): void {
    this.review = undefined;
    this.parentId = "";
    this.relay.clear();
    this.hop = 0;
  }

  begin(
    parentId: string,
    inputs: Array<{ agentId: string; id: string }>,
    rounds: DiscussionRounds,
    proposal: string,
    synthesizer?: string,
  ): void {
    this.parentId = parentId;
    if (rounds && inputs.length > 1) {
      this.review = {
        proposal: roomExcerpt(proposal),
        synthesizer,
        rounds,
        round: 0,
        participants: new Map(
          inputs.map(({ agentId, id }) => [agentId, { inputId: id, pending: true }]),
        ),
      };
    } else {
      this.relay = new Set(inputs.map(({ id }) => id));
      this.hop = 0;
    }
  }

  remove(agentId: string): void {
    if (this.review?.participants.delete(agentId)) this.advance(this.review);
  }

  get inDraftRound(): boolean {
    return this.review?.round === 0;
  }

  isPendingTurn(agentId: string, inputId?: string): boolean {
    const participant = this.review?.participants.get(agentId);
    return !!participant?.pending && participant.inputId === inputId;
  }

  settled(agentId: string, inputId: string, reply?: Reply): boolean {
    const review = this.review;
    if (review) {
      const participant = review.participants.get(agentId);
      if (participant?.inputId !== inputId || !participant.pending) return false;
      participant.pending = false;
      participant.reply = reply;
      this.advance(review);
      return false;
    }
    if (!this.relay.delete(inputId) || !reply) return false;
    const agents = this.agents();
    const sender = agents.find((a) => a.id === agentId);
    const peer = firstPeerMention(
      reply.text,
      agents.filter((a) => a.id !== agentId),
    );
    if (!sender || !peer) return false;
    if (this.hop >= MAX_PEER_RELAY_HOPS) return true;
    const id = this.nextId();
    // A chain holds one baton: parallel drafts cannot branch into extra hops.
    this.relay = new Set([id]);
    this.enqueue({
      id,
      parentId: this.parentId,
      agentId: peer.id,
      text: `${GUARDRAIL}\n\n${sender.name} requested your input. Respond concisely to the point they raised.\n\n${replyBlock([reply], agents)}`,
      label: { kind: "relay", from: sender.name, hop: ++this.hop },
      covered: new Set([reply.messageId]),
      through: this.clock(),
    });
    return false;
  }

  private advance(review: Review): void {
    if ([...review.participants.values()].some((p) => p.pending)) return;
    const agents = this.agents();
    const available = new Set(agents.map((a) => a.id));
    const replies = [...review.participants.values()].flatMap(({ reply }) =>
      reply && available.has(reply.agentId) ? [reply] : [],
    );
    if (replies.length < 2) {
      this.review = undefined;
      return;
    }
    const through = this.clock();
    const covered = new Set(replies.map(({ messageId }) => messageId));
    const proposal = `Original proposal:\n${review.proposal}`;
    if (review.round === review.rounds) {
      this.review = undefined;
      const agentId =
        replies.find((r) => r.agentId === review.synthesizer)?.agentId ?? replies[0].agentId;
      this.enqueue({
        id: this.nextId(),
        parentId: this.parentId,
        agentId,
        text: `${GUARDRAIL}\n\nSynthesize a crisp conclusion under: Consensus / Remaining trade-offs / Recommended plan.\n\n${proposal}\n\n${replyBlock(replies, agents)}`,
        label: { kind: "synthesis" },
        through,
        covered,
      });
      return;
    }
    const round = ++review.round;
    const turns = replies.map(({ agentId }): DiscussionTurn => ({
      id: this.nextId(),
      parentId: this.parentId,
      agentId,
      text: `${GUARDRAIL}\n\nCross-review ${round}/${review.rounds}: Verify peers' assumptions, identify gaps and risks, and refine your recommendation concisely.\n\n${proposal}\n\n${replyBlock(
        replies.filter((r) => r.agentId !== agentId),
        agents,
      )}`,
      label: { kind: "review", round, rounds: review.rounds },
      through,
      covered,
    }));
    review.participants = new Map(
      turns.map(({ agentId, id }) => [agentId, { inputId: id, pending: true }]),
    );
    for (const turn of turns) this.enqueue(turn);
  }
}

function replyBlock(replies: Reply[], agents: RoomAgent[]): string {
  return [
    "[Peer replies]",
    ...replies.map(
      ({ agentId, text }) =>
        `- ${agents.find((a) => a.id === agentId)?.name ?? agentId}: ${roomExcerpt(text).replace(/\n/g, "\n  ")}`,
    ),
    "[End peer replies]",
  ].join("\n");
}

function firstPeerMention(text: string, agents: RoomAgent[]): RoomAgent | undefined {
  for (const token of roomProse(text).split(/\s+/)) {
    if (!token.startsWith("@")) continue;
    const name = token.slice(1);
    const agent =
      agents.find((a) => a.name === name) ??
      agents.find(
        (a) =>
          name.startsWith(a.name) && /^[.,!?;:，。！？；：…)}\]]+$/.test(name.slice(a.name.length)),
      );
    if (agent) return agent;
  }
  return undefined;
}
