import { useT } from "../i18n/chat";

// Top-of-list status for paginated history: what is happening while older
// messages load, and where the conversation begins.
export function HistoryHint({
  hasMore,
  loading,
  loaded,
  count,
}: {
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  count: number;
}) {
  const tr = useT();
  if (!loaded) {
    return (
      <div className="history-hint history-loading">
        <span className="spinner" /> {tr("loadingConversation")}
      </div>
    );
  }
  if (loading) {
    return (
      <div className="history-hint history-loading">
        <span className="spinner" /> {tr("loadingOlder")}
      </div>
    );
  }
  if (hasMore) return <div className="history-hint">{tr("olderMessages")}</div>;
  if (count > 0) {
    return <div className="history-hint history-start">{tr("beginningConversation")}</div>;
  }
  return null;
}
