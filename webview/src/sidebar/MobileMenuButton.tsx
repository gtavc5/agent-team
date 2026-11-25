import { describeAttention, type AttentionSummary } from "./attention";

export function MobileMenuButton({
  attention,
  onClick,
}: {
  attention: AttentionSummary;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="mobile-menu-btn"
      aria-label={`Open workspace menu: ${describeAttention(attention, "background session")}`}
      onClick={onClick}
    >
      <span aria-hidden="true">&#9776;</span>
      {attention.count > 0 && (
        <span
          className={`attention-badge${attention.yourTurn > 0 ? " attention-badge-your-turn" : ""}`}
          aria-hidden="true"
        >
          {attention.count}
        </span>
      )}
    </button>
  );
}
