import { useEffect, useMemo, useRef, useState } from "react";
import { usePanelT } from "../i18n/panels";

export const INLINE_IMAGE_LIMIT = 10 * 1024 * 1024;

type Preview = { src: string; blob?: Blob } | { error: unknown };

class ImageLoadError extends Error {
  constructor(
    readonly key: "imageResponseInvalid" | "imageReadFailed",
    message: string,
  ) {
    super(message);
  }
}

async function fetchImage(raw: string, signal: AbortSignal): Promise<Blob | undefined> {
  const response = await fetch(raw, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  // Some lightweight fetch implementations only expose JSON.
  if (typeof response.blob !== "function") return;
  const blob = await response.blob();
  if (!blob) return;
  if (!blob.type.startsWith("image/"))
    throw new ImageLoadError("imageResponseInvalid", "The response is not an image.");
  return blob;
}

function readDataUrl(blob: Blob, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const reader = new FileReader();
    const abort = () => reader.abort();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () =>
      reject(reader.error ?? new ImageLoadError("imageReadFailed", "Image read failed"));
    reader.onabort = () => reject(new DOMException("Image read aborted", "AbortError"));
    reader.onloadend = () => signal.removeEventListener("abort", abort);
    reader.readAsDataURL(blob);
    signal.addEventListener("abort", abort, { once: true });
  });
}

// Share the preview's fetch and its original bytes with the toolbar action.
export function useImagePreview(raw: string, size: number | null): Preview | null {
  const request = useMemo(() => ({ raw, size }), [raw, size]);
  const [loaded, setLoaded] = useState<{ request: typeof request; preview: Preview }>();
  useEffect(() => {
    setLoaded(undefined);
    if (request.size === null || request.size > INLINE_IMAGE_LIMIT) return;
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      try {
        const blob = await fetchImage(request.raw, signal);
        const src =
          blob && blob.size <= INLINE_IMAGE_LIMIT ? await readDataUrl(blob, signal) : request.raw;
        if (!signal.aborted) setLoaded({ request, preview: { src, blob } });
      } catch (error) {
        if (!signal.aborted) {
          setLoaded({ request, preview: { error } });
        }
      }
    })();
    return () => controller.abort();
  }, [request]);
  if (size === null) return null;
  if (size > INLINE_IMAGE_LIMIT) return { src: raw };
  return loaded?.request === request ? loaded.preview : null;
}

export function ImagePreview({ preview, alt }: { preview: Preview | null; alt: string }) {
  const t = usePanelT();
  if (!preview) return <div className="file-note">{t("loading")}</div>;
  if ("error" in preview) {
    const error =
      preview.error instanceof ImageLoadError ? t(preview.error.key) : String(preview.error);
    return <div className="file-note file-error">{t("imageLoadFailed", { error })}</div>;
  }
  return (
    <div className="file-image">
      <img src={preview.src} alt={alt} />
    </div>
  );
}

async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const url = URL.createObjectURL(blob);
  try {
    // Use the browser's image decoder, including SVG and ICO support.
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (png) => (png ? resolve(png) : reject(new Error("PNG encoding failed"))),
        "image/png",
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function CopyImageButton({ raw, preview }: { raw: string; preview: Preview | null }) {
  const t = usePanelT();
  const [feedback, setFeedback] = useState<"copied" | "copyImageFailed" | null>(null);
  const copying = useRef<AbortController | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () => () => {
      copying.current?.abort();
      clearTimeout(timeout.current);
    },
    [],
  );
  if (typeof ClipboardItem !== "function" || typeof navigator.clipboard?.write !== "function")
    return null;

  async function copy(blob?: Blob) {
    if (copying.current) return;
    const controller = new AbortController();
    copying.current = controller;
    const { signal } = controller;
    clearTimeout(timeout.current);
    setFeedback(null);
    const png = (async () => {
      const image = blob ?? (await fetchImage(raw, signal));
      if (!image) throw new Error("No image bytes");
      signal.throwIfAborted();
      const result = await toPng(image);
      signal.throwIfAborted();
      return result;
    })();
    try {
      // Call write during the click's activation, even if PNG conversion is asynchronous.
      await Promise.all([
        png,
        (async () => navigator.clipboard.write([new ClipboardItem({ "image/png": png })]))(),
      ]);
      if (!signal.aborted) setFeedback("copied");
    } catch {
      if (!signal.aborted) setFeedback("copyImageFailed");
    } finally {
      copying.current = null;
      if (!signal.aborted) timeout.current = setTimeout(() => setFeedback(null), 1500);
    }
  }

  return (
    <button
      className="fp-btn"
      title={t("copyImage")}
      disabled={!preview || "error" in preview}
      onClick={() => {
        if (preview && "src" in preview) void copy(preview.blob);
      }}
    >
      {t(feedback ?? "copyImage")}
    </button>
  );
}
