import { useEffect, useState, type ReactNode } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";

export function ExecutionTraceGroup({
  title,
  live,
  thought = false,
  children,
}: {
  title: string;
  live: boolean;
  thought?: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(live);

  useEffect(() => {
    setExpanded(live);
  }, [live]);

  return (
    <details
      className={`execution-trace${live ? " is-live" : ""}`}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        {thought ? null : (
          <XiaoIcon
            className="execution-trace__icon"
            name={title.startsWith("Edited") ? "edit" : "command"}
            size={13}
          />
        )}
        <span>{title}</span>
        <XiaoIcon className="execution-trace__caret" name="caret" size={12} />
      </summary>
      <div className="execution-trace__content">{children}</div>
    </details>
  );
}
