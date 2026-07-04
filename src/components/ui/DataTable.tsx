import type { CSSProperties, ReactNode } from "react";

export type DataTableColumn<T> = {
  key: string;
  header: ReactNode;
  render: (row: T, index: number) => ReactNode;
  align?: "left" | "right" | "center";
  headerClassName?: string;
  cellClassName?: string;
};

type DataTableProps<T> = {
  columns: DataTableColumn<T>[];
  rows: T[];
  getRowKey: (row: T, index: number) => string;
  gridTemplateColumns: string;
  minWidth?: string;
  className?: string;
  emptyState?: ReactNode;
};

export function DataTable<T>({
  className = "",
  columns,
  emptyState,
  getRowKey,
  gridTemplateColumns,
  minWidth = "760px",
  rows,
}: DataTableProps<T>) {
  const resolvedGridTemplateColumns = ensureFlexibleGridTemplate(gridTemplateColumns);
  const style = {
    "--xh-data-table-columns": resolvedGridTemplateColumns,
    "--xh-data-table-min-width": minWidth,
  } as CSSProperties;

  return (
    <div className={`xh-data-table ${className}`} style={style} role="table">
      <div className="xh-data-table-inner">
        <div className="xh-data-table-row xh-data-table-head" role="row">
          {columns.map((column) => (
            <div
              className={`xh-data-table-cell is-${column.align ?? "left"} ${column.headerClassName ?? ""}`}
              key={column.key}
              role="columnheader"
            >
              {column.header}
            </div>
          ))}
        </div>

        <div className="xh-data-table-body">
          {rows.length === 0 ? (
            <div className="xh-data-table-empty" role="row">
              {emptyState}
            </div>
          ) : (
            rows.map((row, index) => (
              <div className="xh-data-table-row xh-data-table-body-row" key={getRowKey(row, index)} role="row">
                {columns.map((column) => (
                  <div
                    className={`xh-data-table-cell is-${column.align ?? "left"} ${column.cellClassName ?? ""}`}
                    key={column.key}
                    role="cell"
                  >
                    {column.render(row, index)}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function ensureFlexibleGridTemplate(template: string) {
  if (/\bfr\b/.test(template)) {
    return template;
  }

  return template
    .split(/\s+/)
    .filter(Boolean)
    .map((track) => (/^\d+(?:\.\d+)?px$/.test(track) ? `minmax(${track}, 1fr)` : track))
    .join(" ");
}
