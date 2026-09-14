import type { ReactNode } from 'react';

export function Panel({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="panel" open={defaultOpen}>
      <summary className="panel-heading">
        <h2>{title}</h2>
      </summary>
      <div className="panel-body">{children}</div>
    </details>
  );
}
