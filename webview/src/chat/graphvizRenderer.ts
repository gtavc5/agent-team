import { instance, type Viz } from "@viz-js/viz";

let vizLoading: Promise<Viz> | null = null;

function loadViz(): Promise<Viz> {
  vizLoading ??= instance().catch((error: unknown) => {
    vizLoading = null;
    throw error;
  });
  return vizLoading;
}

export async function renderGraphviz(source: string): Promise<string> {
  const viz = await loadViz();
  const rootStyle = getComputedStyle(document.documentElement);
  const token = (name: string) => rootStyle.getPropertyValue(name).trim();
  const text = token("--text-primary");
  const line = token("--text-secondary");
  return viz.renderString(source, {
    format: "svg",
    graphAttributes: { bgcolor: "transparent", fontcolor: text, color: line },
    nodeAttributes: { fontcolor: text, color: line },
    edgeAttributes: { fontcolor: text, color: line },
  });
}
