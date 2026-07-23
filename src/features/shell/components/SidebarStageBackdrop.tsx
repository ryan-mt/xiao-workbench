import type { AppStage } from "../../../core/branding";

export function SidebarStageBackdrop({ variant }: { variant: AppStage }) {
  const isBlueprint = variant !== "beta";

  return (
    <div
      aria-hidden="true"
      className={`sidebar-stage-backdrop sidebar-stage-backdrop--${variant}`}
    >
      <div className="sidebar-stage-backdrop__glow" />
      <div className="sidebar-stage-backdrop__texture" />
      {isBlueprint ? (
        <div className="sidebar-stage-backdrop__blueprint">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      ) : (
        <div className="sidebar-stage-backdrop__clouds">
          <span />
          <span />
          <span />
        </div>
      )}
    </div>
  );
}
