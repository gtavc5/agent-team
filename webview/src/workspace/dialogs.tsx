import { useState, useRef, useEffect, useMemo, useId } from "react";
import type { TelemetryConfirmation } from "../../../shared/telemetry";
import { recordTelemetry } from "../telemetry";
import { useWorkspaceT } from "../i18n/workspace";
import { EffortSelect, effortOf } from "./EffortSelect";
import type { AgentPreset, CodexAuthState, ModelOption, HostInfo } from "../state/useServer";
import { isImageAvatar } from "./avatar";
import { DialogFrame } from "./DialogFrame";
import { copyText } from "../chat/clipboard";

import { CODEX_SETUP_VALUE, isCodexSetup, needsCodexSetup, usableModels } from "./models";
export const CODEX_LOGIN_COMMAND = "npx codex login";

// Small modal confirmation used for destructive actions (purging archived
// workspaces). Enter confirms, Escape cancels.
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger = false,
  telemetryAction,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
  telemetryAction?: TelemetryConfirmation;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const tr = useWorkspaceT();
  const resolvedConfirmLabel = confirmLabel ?? tr("confirm");
  const opened = useRef<TelemetryConfirmation>(undefined);
  useEffect(() => {
    if (telemetryAction && opened.current !== telemetryAction)
      recordTelemetry(telemetryAction, "open");
    opened.current = telemetryAction;
  }, [telemetryAction]);
  const cancel = () => {
    if (telemetryAction) recordTelemetry(telemetryAction, "cancel");
    onClose();
  };
  return (
    <DialogFrame title={title} className="dialog-confirm" onClose={cancel}>
      <p className="dialog-body">{body}</p>
      <div className="dialog-actions">
        <button
          data-dialog-focus={danger ? "" : undefined}
          type="button"
          className="btn-secondary"
          onClick={cancel}
        >
          {tr("cancel")}
        </button>
        <button
          data-dialog-focus={danger ? undefined : ""}
          type="button"
          className={danger ? "btn-danger" : "btn-primary"}
          onClick={() => {
            if (telemetryAction) recordTelemetry(telemetryAction, "confirm");
            onConfirm();
            onClose();
          }}
        >
          {resolvedConfirmLabel}
        </button>
      </div>
    </DialogFrame>
  );
}

const BACKEND_GROUPS: Array<[ModelOption["backend"], string]> = [
  ["pi", "Pi"],
  ["codex", "Codex"],
];

function defaultAddSelection(
  selectableModels: ModelOption[],
  preset: AgentPreset | undefined,
  fallback: string,
) {
  const available = selectableModels.find((m) => m.id === preset?.model);
  const model = available?.id ?? fallback;
  const effort =
    (!preset?.model || available) &&
    preset?.effort &&
    effortOf(selectableModels, model).levels.includes(preset.effort)
      ? preset.effort
      : "";
  return { model, effort };
}

export function AddAgentDialog({
  presets,
  models,
  codexAuth,
  onOpenCodexSetup,
  suspended = false,
  onClose,
  onAdd,
}: {
  presets: AgentPreset[];
  models: ModelOption[];
  codexAuth?: CodexAuthState | null;
  onOpenCodexSetup?: () => void;
  suspended?: boolean;
  onClose: () => void;
  onAdd: (name: string, model: string, avatar: string, color: string, effort?: string) => void;
}) {
  const tr = useWorkspaceT();
  const showCodexHint = needsCodexSetup(codexAuth);
  const selectableModels = useMemo(() => usableModels(models, codexAuth), [codexAuth, models]);

  const [selectedPreset, setSelectedPreset] = useState(0);
  const initial = defaultAddSelection(selectableModels, presets[0], selectableModels[0]?.id ?? "");
  const [model, setModel] = useState(initial.model);
  const [effort, setEffort] = useState(initial.effort);

  // When models refresh live (e.g. after signing in to Codex and clicking
  // Re-check), pick a valid model if nothing usable was selected yet.
  useEffect(() => {
    if (model && selectableModels.some((m) => m.id === model)) return;
    const next = defaultAddSelection(
      selectableModels,
      presets[selectedPreset],
      selectableModels[0]?.id ?? "",
    );
    setModel(next.model);
    setEffort(next.effort);
  }, [selectableModels, model, presets, selectedPreset]);

  const chooseModel = (next: string) => {
    if (isCodexSetup(next)) {
      onOpenCodexSetup?.();
      return;
    }
    setModel(next);
    if (!effortOf(selectableModels, next).levels.includes(effort)) setEffort("");
  };
  const [customName, setCustomName] = useState("");

  const preset = presets[selectedPreset];
  const finalName = customName || preset?.name || "Agent";

  return (
    <DialogFrame
      title={tr("addAgentTitle")}
      onClose={onClose}
      suspended={suspended}
      onSubmit={(event) => {
        event.preventDefault();
        if (!model) return;
        onAdd(
          finalName,
          model,
          preset?.avatar ?? "🤖",
          preset?.color ?? "#888",
          effort || undefined,
        );
        onClose();
      }}
    >
      <div className="preset-grid" role="group" aria-label="Agent presets">
        {presets.map((p, i) => (
          <button
            key={p.name}
            type="button"
            className="preset-item"
            aria-pressed={i === selectedPreset}
            onClick={() => {
              setSelectedPreset(i);
              if (p.model || p.effort) {
                const next = defaultAddSelection(selectableModels, p, model);
                setModel(next.model);
                setEffort(next.effort);
              }
              setCustomName("");
            }}
          >
            <span
              className="agent-avatar"
              aria-hidden="true"
              style={{
                width: 36,
                height: 36,
                background: isImageAvatar(p.avatar) ? "transparent" : p.color,
                fontSize: 18,
              }}
            >
              {isImageAvatar(p.avatar) ? (
                <img
                  src={p.avatar}
                  alt=""
                  style={{ width: 36, height: 36, borderRadius: "50%", objectFit: "cover" }}
                />
              ) : (
                p.avatar
              )}
            </span>
            <span>{p.name}</span>
          </button>
        ))}
      </div>

      <label className="dialog-field">
        <span>{tr("nameOrUsePreset")}</span>
        <input
          data-dialog-focus
          value={customName}
          onChange={(e) => setCustomName(e.target.value)}
          placeholder={preset?.name}
        />
      </label>

      <div className="dialog-field">
        <label className="dialog-field-label" htmlFor="add-agent-model">
          {tr("modelLabel")}
        </label>
        <select id="add-agent-model" value={model} onChange={(e) => chooseModel(e.target.value)}>
          {selectableModels.length === 0 && (
            <option value="" disabled>
              {tr("noModelsAvailable")}
            </option>
          )}
          {BACKEND_GROUPS.map(([backend, label]) => {
            const group = selectableModels.filter((m) => m.backend === backend);
            if (group.length > 0) {
              return (
                <optgroup key={backend} label={label}>
                  {group.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
              );
            }
            if (backend === "codex" && showCodexHint) {
              return (
                <optgroup key={backend} label={label}>
                  <option value={CODEX_SETUP_VALUE} className="codex-unauth-option">
                    {tr("codexNotSignedIn")}
                  </option>
                </optgroup>
              );
            }
            return null;
          })}
        </select>
        {showCodexHint && onOpenCodexSetup && (
          <button type="button" className="codex-auth-hint" onClick={onOpenCodexSetup}>
            {tr("signInToCodexEllipsis")}
          </button>
        )}
      </div>

      {effortOf(selectableModels, model).levels.length > 0 && (
        <label className="dialog-field">
          <span>{tr("effortLabel")}</span>
          <EffortSelect
            {...effortOf(selectableModels, model)}
            value={effort}
            onChange={setEffort}
            label={tr("reasoningEffort")}
            fresh
          />
        </label>
      )}

      <div className="dialog-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>
          {tr("cancel")}
        </button>
        <button type="submit" className="btn-primary" disabled={!model}>
          {tr("add")}
        </button>
      </div>
    </DialogFrame>
  );
}

export function CodexSetupDialog({
  codexAuth,
  rechecking,
  onRecheck,
  onClose,
}: {
  codexAuth: CodexAuthState | null;
  rechecking: boolean;
  onRecheck: () => void;
  onClose: () => void;
}) {
  const tr = useWorkspaceT();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [checkRequested, setCheckRequested] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const sawRecheckingRef = useRef(false);

  useEffect(() => {
    return () => clearTimeout(copyTimerRef.current);
  }, []);

  useEffect(() => {
    if (rechecking) {
      sawRecheckingRef.current = true;
      return;
    }
    if (sawRecheckingRef.current && codexAuth?.authenticated) {
      sawRecheckingRef.current = false;
      onClose();
    }
  }, [rechecking, codexAuth?.authenticated, onClose]);

  const handleCopy = async () => {
    const ok = await copyText(CODEX_LOGIN_COMMAND);
    setCopyState(ok ? "copied" : "failed");
    clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyState("idle"), 2000);
  };

  const handleRecheck = () => {
    setCheckRequested(true);
    onRecheck();
  };

  const statusNote = (() => {
    if (rechecking) return "Checking Codex sign-in…";
    if (codexAuth?.authenticated) return tr("codexSignedIn");
    if (codexAuth?.status === "error") {
      return codexAuth.error
        ? tr("checkFailed", { error: codexAuth.error })
        : "Check failed. Try Re-check again.";
    }
    if (codexAuth?.status === "unavailable") {
      return tr("codexCliUnavailable");
    }
    if (!codexAuth?.checkedAt) return "Waiting for the Codex sign-in status…";
    return checkRequested ? tr("codexStillNotSignedIn") : null;
  })();

  return (
    <DialogFrame
      title={tr("signInToCodex")}
      className="dialog-codex-setup"
      overlayClass="dialog-codex-setup-overlay"
      priority={1}
      onClose={onClose}
    >
      <p className="dialog-body">{tr("codexSetupBody")}</p>
      <div className="codex-cmd-box">
        <code className="codex-cmd-code">{CODEX_LOGIN_COMMAND}</code>
        <button
          type="button"
          className="btn-secondary codex-copy-btn"
          onClick={() => void handleCopy()}
        >
          {copyState === "copied"
            ? tr("copied")
            : copyState === "failed"
              ? tr("copyFailed")
              : tr("copy")}
        </button>
      </div>
      {statusNote && (
        <p
          className={`codex-auth-status${codexAuth?.authenticated ? " authenticated" : ""}`}
          role="status"
        >
          {statusNote}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>
          {tr("close")}
        </button>
        <button
          data-dialog-focus
          type="button"
          className="btn-primary"
          disabled={rechecking}
          onClick={handleRecheck}
        >
          {rechecking ? tr("checking") : tr("recheck")}
        </button>
      </div>
    </DialogFrame>
  );
}

// Projects can be organisational-only: no repository or checkout is needed.
export function CreateProjectDialog({
  hosts = [],
  onListDirs,
  dirSuggestions,
  onClose,
  onCreate,
}: {
  hosts?: HostInfo[];
  onClose: () => void;
  onCreate: (name: string, root: string | null) => void;
} & DirectorySource) {
  const tr = useWorkspaceT();
  const [name, setName] = useState("");
  const [withoutGit, setWithoutGit] = useState(false);
  const local = hosts.find((host) => host.type === "local");
  const {
    path: root,
    field,
    dismiss,
  } = useDirectoryField({
    onListDirs: local?.connected === false ? undefined : onListDirs,
    dirSuggestions,
    disabled: withoutGit,
    label: tr("repositoryPath"),
    placeholder: withoutGit ? tr("noRepository") : "/path/to/repository",
  });
  const onEscape = () => {
    if (!dismiss()) onClose();
  };
  const canSubmit = name.trim().length > 0 && (withoutGit || root.trim().length > 0);
  return (
    <DialogFrame
      title={tr("newProjectTitle")}
      onClose={onClose}
      onEscape={onEscape}
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        onCreate(name.trim(), withoutGit ? null : root.trim());
        onClose();
      }}
    >
      <label className="dialog-field">
        <span>{tr("nameLabel")}</span>
        <input
          data-dialog-focus
          value={name}
          placeholder={tr("projectNamePlaceholder")}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {field}
      <label className="dialog-checkbox">
        <input
          type="checkbox"
          checked={withoutGit}
          onChange={(e) => setWithoutGit(e.target.checked)}
        />
        <span>{tr("createWithoutGit")}</span>
      </label>
      <p className="dialog-help">{tr("createWithoutGitHelp")}</p>
      <div className="dialog-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>
          {tr("cancel")}
        </button>
        <button type="submit" className="btn-primary" disabled={!canSubmit}>
          {tr("createProject")}
        </button>
      </div>
    </DialogFrame>
  );
}

type DirectorySource = {
  onListDirs?: (prefix: string) => void;
  dirSuggestions?: { prefix: string; dirs: string[] };
};

function useDirectoryField({
  onListDirs,
  dirSuggestions,
  initialPath = "",
  disabled = false,
  label,
  placeholder,
}: DirectorySource & {
  initialPath?: string;
  disabled?: boolean;
  label: string;
  placeholder: string;
}) {
  const [dirPath, setDirPath] = useState(initialPath);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIdx, setSuggestIdx] = useState(-1);
  const inputId = useId();
  const listId = `${inputId}-directories`;
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      clearTimeout(debounceRef.current);
      clearTimeout(blurTimerRef.current);
    };
  }, []);

  const requestDirs = (value: string) => {
    clearTimeout(debounceRef.current);
    if (onListDirs) debounceRef.current = setTimeout(() => onListDirs(value), 120);
  };

  // The server echoes the prefix, so stale replies for older input are ignored.
  const suggestions =
    !disabled && onListDirs && dirSuggestions?.prefix === dirPath ? dirSuggestions.dirs : [];

  const expanded = suggestOpen && suggestions.length > 0;
  const activeIndex = expanded && suggestIdx < suggestions.length ? suggestIdx : -1;
  useEffect(() => {
    if (activeIndex !== -1) {
      document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
    }
  }, [activeIndex, listId]);

  const closeSuggestions = () => {
    setSuggestOpen(false);
    setSuggestIdx(-1);
  };

  const handlePathChange = (value: string) => {
    setDirPath(value);
    setSuggestOpen(true);
    setSuggestIdx(-1);
    requestDirs(value);
  };

  const pickSuggestion = (dir: string) => {
    clearTimeout(debounceRef.current);
    setDirPath(dir);
    closeSuggestions();
  };

  const handlePathKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || !expanded) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSuggestIdx((activeIndex + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSuggestIdx(activeIndex > 0 ? activeIndex - 1 : suggestions.length - 1);
    } else if (e.key === "Enter" && activeIndex !== -1) {
      e.preventDefault();
      pickSuggestion(suggestions[activeIndex]);
    }
  };

  const field = (
    <div className="dialog-field path-field">
      <label className="dialog-field-label" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={activeIndex !== -1 ? `${listId}-${activeIndex}` : undefined}
        value={dirPath}
        disabled={disabled}
        onChange={(e) => handlePathChange(e.target.value)}
        onKeyDown={handlePathKeyDown}
        onFocus={() => {
          clearTimeout(blurTimerRef.current);
          setSuggestOpen(true);
          requestDirs(dirPath);
        }}
        onBlur={() => {
          // Tapping/clicking anywhere else closes the list — the only way
          // to dismiss on mobile, where there is no Esc. Delayed so a
          // click that lands past the list (e.g. on Create after the
          // list shrinks) completes before the layout shifts. Picking a
          // suggestion never blurs: items preventDefault on mousedown.
          setSuggestIdx(-1);
          blurTimerRef.current = setTimeout(closeSuggestions, 150);
        }}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
      />
      {expanded && (
        <div
          className="dir-suggest"
          role="listbox"
          id={listId}
          aria-label={`${label} suggestions`}
          tabIndex={-1}
        >
          {suggestions.map((dir, i) => (
            <div
              key={dir}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              className={`dir-suggest-item${i === activeIndex ? " active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pickSuggestion(dir);
              }}
            >
              {dir}
            </div>
          ))}
        </div>
      )}
    </div>
  );
  return {
    path: dirPath,
    field,
    dismiss: () => {
      if (!expanded) return false;
      closeSuggestions();
      return true;
    },
  };
}

// A workspace is just a name plus a directory, a session of that folder's
// project (the server brings the project and its lead the first time). The
// path field lists matching directories from the server for explicit selection.
export function CreateWorkspaceDialog({
  hosts,
  onClose,
  onCreate,
  onListDirs,
  dirSuggestions,
  initialPath,
  projectFolders = [],
}: {
  hosts: HostInfo[];
  onClose: () => void;
  onCreate: (name: string, path: string, hostId?: string, projectName?: string) => void;
  onListDirs: (prefix: string) => void;
  dirSuggestions: { prefix: string; dirs: string[] };
  initialPath?: string;
  // Where the projects work (their repositories and worktrees): a folder
  // outside them all starts a project, which can be named here.
  projectFolders?: string[];
}) {
  const tr = useWorkspaceT();
  const [name, setName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [hostId, setHostId] = useState(hosts[0]?.id ?? "local");
  const {
    path: dirPath,
    field,
    dismiss,
  } = useDirectoryField({
    onListDirs,
    dirSuggestions,
    initialPath: initialPath ?? "~/",
    label: tr("directoryPath"),
    placeholder: "~/workspace/...",
  });
  const onEscape = () => {
    if (!dismiss()) onClose();
  };

  const canSubmit = dirPath.trim().length > 0;
  const defaultName = dirPath.split("/").filter(Boolean).pop() ?? "";
  const folder = dirPath.trim().replace(/\/+$/, "");
  const newProject =
    defaultName !== "" &&
    defaultName !== "~" &&
    !projectFolders.some((f) => folder === f || folder.startsWith(`${f}/`));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const finalName = (name.trim() || defaultName || "session").trim();
    const project = newProject ? projectName.trim() : "";
    onCreate(finalName, dirPath.trim(), hostId || undefined, project || undefined);
    onClose();
  };

  return (
    <DialogFrame
      title={tr("newSessionTitle")}
      onClose={onClose}
      onEscape={onEscape}
      onSubmit={handleSubmit}
    >
      <label className="dialog-field">
        <span>{tr("nameLabel")}</span>
        <input
          data-dialog-focus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={defaultName || tr("sessionNamePlaceholder")}
        />
      </label>
      {field}
      {newProject && (
        <label className="dialog-field">
          <span>{tr("projectLabel")}</span>
          <input
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder={defaultName}
          />
        </label>
      )}
      {hosts.length > 1 && (
        <label className="dialog-field">
          <span>{tr("hostLabel")}</span>
          <select value={hostId} onChange={(e) => setHostId(e.target.value)}>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>
          {tr("cancel")}
        </button>
        <button type="submit" className="btn-primary" disabled={!canSubmit}>
          {tr("createSession")}
        </button>
      </div>
    </DialogFrame>
  );
}
