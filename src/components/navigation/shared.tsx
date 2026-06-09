import type { PageKey } from "../../types";
import type { NavItem } from "./types";

export function renderNavItems(items: NavItem[], currentPage: PageKey, onPage: (page: PageKey) => void, showCode = false) {
  return items.map(([page, label, Icon], index) => (
    <button key={page} className={`nav-item ${currentPage === page ? "active" : ""}`} onClick={() => onPage(page)}>
      <Icon className="nav-icon" aria-hidden="true" />
      {showCode ? <span className="nav-code">{String(index + 1).padStart(2, "0")}</span> : null}
      <span>{label}</span>
    </button>
  ));
}
