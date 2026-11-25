import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createTranslator } from "../i18n/core";
import type { AgentInfo } from "../state/useServer";
import { AgentAvatar } from "../workspace/avatar";
import { shortModel } from "../workspace/models";
import { getDefaultAgent } from "./targetRouting";

const catalog = {
  sendTarget: {
    en: "Send target: {name} (click to switch)",
    "zh-CN": "发送目标：{name}（点击切换）",
  },
  mentionOverride: {
    en: "Sending to @{name} via mention (click to change locked target)",
    "zh-CN": "本次将通过 @ 提及发送给 {name}（点击更改锁定目标）",
  },
  sendTo: { en: "Send messages to", "zh-CN": "发送消息给" },
  defaultBadge: { en: "default", "zh-CN": "默认" },
  overrideHint: {
    en: "@{name} in input overrides this message",
    "zh-CN": "输入框中的 @{name} 将临时覆盖本条消息",
  },
} as const;

const { useT } = createTranslator(catalog);

export interface TargetAgentSelectProps {
  agents: AgentInfo[];
  effectiveAgent: AgentInfo | null;
  lockedAgent: AgentInfo | null;
  isMentionOverride: boolean;
  disabled?: boolean;
  onSelectTarget: (agentId: string | null) => void;
}

export function TargetAgentSelect(props: TargetAgentSelectProps) {
  const { agents, effectiveAgent, lockedAgent, isMentionOverride, disabled, onSelectTarget } =
    props;
  const tr = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = `target-select-${id}`;

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
      setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  if (agents.length <= 1 || !effectiveAgent) return null;

  const baseAgent = lockedAgent ?? getDefaultAgent(agents);
  const triggerLabel = isMentionOverride
    ? tr("mentionOverride", { name: effectiveAgent.name })
    : tr("sendTarget", { name: effectiveAgent.name });
  const triggerClass = [
    "target-select-btn",
    lockedAgent && !lockedAgent.isDefault && !isMentionOverride ? "is-locked" : "",
    isMentionOverride ? "is-override" : "",
    open ? "open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  function navigate(event: KeyboardEvent) {
    if (!open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    const actions = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(".target-select-option") ?? [],
    );
    const index = actions.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? index + 1 : index < 0 ? -1 : index - 1;
    event.preventDefault();
    actions[(next + actions.length) % actions.length]?.focus();
  }

  function select(agent: AgentInfo) {
    setOpen(false);
    onSelectTarget(agent.isDefault ? null : agent.id);
  }

  return (
    <div ref={rootRef} className="target-select" onKeyDown={navigate}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClass}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        disabled={disabled}
        aria-label={triggerLabel}
        title={triggerLabel}
        onClick={() => setOpen((v) => !v)}
      >
        <AgentAvatar agent={effectiveAgent} size={16} />
        <span className="target-select-at" aria-hidden="true">
          @
        </span>
        <span className="target-select-name">{effectiveAgent.name}</span>
        <span className="target-select-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div
          id={popoverId}
          ref={panelRef}
          className="target-select-popover"
          role="listbox"
          aria-label={tr("sendTo")}
        >
          <div className="target-select-header">{tr("sendTo")}</div>
          {isMentionOverride && (
            <div className="target-select-note">
              {tr("overrideHint", { name: effectiveAgent.name })}
            </div>
          )}
          {agents.map((a) => {
            const isBaseSelected = baseAgent !== null && a.id === baseAgent.id;
            return (
              <button
                key={a.id}
                type="button"
                role="option"
                aria-selected={isBaseSelected}
                className={`target-select-option${isBaseSelected ? " selected" : ""}`}
                onClick={() => select(a)}
              >
                <AgentAvatar agent={a} size={18} />
                <span className="target-select-option-main">
                  <span className="target-select-option-name">{a.name}</span>
                  <span className="target-select-option-model">{shortModel(a.model)}</span>
                </span>
                {a.isDefault && <span className="target-select-badge">{tr("defaultBadge")}</span>}
                <span className="target-select-check" aria-hidden="true">
                  {isBaseSelected ? "✓" : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
