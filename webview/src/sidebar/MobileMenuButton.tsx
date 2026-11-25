import { Icon } from "../panels/Icon";
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
      <Icon name="menu" />
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
