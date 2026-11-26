import { isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../panels/Icon";
import "./DiagramPreview.css";

export type DiagramLanguage = "mermaid" | "graphviz";
export type DiagramTheme = "light" | "dark";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? textOf(node.props.children) : "";
}

export function diagramSource(children: ReactNode): string {
  return textOf(children).replace(/\r?\n$/, "");
}

export function diagramLanguage(children: ReactNode): DiagramLanguage | null {
  if (!isValidElement<{ className?: string }>(children)) return null;
  const classes = children.props.className?.split(/\s+/) ?? [];
  const language = classes
    .find((name) => name.toLowerCase().startsWith("language-"))
    ?.slice(9)
    .toLowerCase();
  if (language === "mermaid") return "mermaid";
  if (language === "graphviz" || language === "dot") return "graphviz";
  return null;
}

function currentTheme(): DiagramTheme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function errorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message
      .split("\n")
      .find((line) => line.trim())
      ?.trim() || "Unknown rendering error"
  ).slice(0, 180);
}

interface DiagramPreviewProps {
  language: DiagramLanguage;
  source: string;
  onPreviewChange: (visible: boolean) => void;
  copy: ReactNode;
}

export function DiagramPreview({ language, source, onPreviewChange, copy }: DiagramPreviewProps) {
  const [requestedSource, setRequestedSource] = useState<string | null>(null);
  const [theme, setTheme] = useState<DiagramTheme>(currentTheme);
  const [renderedTheme, setRenderedTheme] = useState<DiagramTheme>(theme);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const renderId = useRef(0);
  const open = requestedSource !== null;

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (requestedSource === null || requestedSource === source) return;
    renderId.current++;
    setRequestedSource(null);
    setSvg("");
    setError("");
    setStatus("idle");
    onPreviewChange(false);
  }, [onPreviewChange, requestedSource, source]);

  useEffect(() => {
    if (requestedSource === null || requestedSource !== source) return;
    const id = ++renderId.current;
    // Keep an open preview in place until its replacement theme is ready.
    setStatus((previous) => (previous === "ready" ? previous : "loading"));
    setError("");
    let active = true;
    void import("./diagramRender")
      .then(({ renderDiagram }) => renderDiagram(requestedSource, language, theme))
      .then(
        (result) => {
          if (!active || renderId.current !== id) return;
          setSvg(result);
          setRenderedTheme(theme);
          setStatus("ready");
          onPreviewChange(true);
        },
        (cause: unknown) => {
          if (!active || renderId.current !== id) return;
          setSvg("");
          setError(errorReason(cause));
          setStatus("error");
          onPreviewChange(false);
        },
      );
    return () => {
      active = false;
    };
  }, [language, onPreviewChange, requestedSource, source, theme]);

  const toggle = () => {
    renderId.current++;
    if (open) {
      setRequestedSource(null);
      setSvg("");
      setError("");
      setStatus("idle");
      onPreviewChange(false);
    } else {
      setRequestedSource(source);
    }
  };
  const label = open ? "Show code" : "Preview diagram";

  return (
    <>
      <div className="code-block-actions">
        {copy}
        <button
          type="button"
          className="copy-btn diagram-toggle"
          aria-label={label}
          aria-pressed={open}
          title={label}
          onClick={toggle}
        >
          <Icon name={open ? "code" : "diagram"} />
        </button>
      </div>
      {status === "loading" && (
        <span className="diagram-preview-status" role="status">
          Rendering diagram…
        </span>
      )}
      {status === "error" && (
        <p className="diagram-preview-error" role="alert">
          Diagram preview failed: {error}
        </p>
      )}
      {status === "ready" && (
        <div
          className={`diagram-preview diagram-preview--${language}`}
          data-theme={renderedTheme}
          aria-label="Diagram preview"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </>
  );
}
