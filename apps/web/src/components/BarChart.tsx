/**
 * Single-series horizontal bar chart (dataviz method): one validated hue (--chart-1),
 * thin bars with 4px rounded data-ends anchored to a shared baseline, a direct value
 * label per bar (few bars), hover/focus tooltip per bar, and a table view.
 */
import { useState } from "react";
import { Table2 } from "lucide-react";
import type { Bar } from "../lib/benchmarks.server";
import { Button } from "./ui/button";

type Props = { bars: Bar[]; unit: string; decimals?: number; caption: string };

export function BarChart({ bars, unit, decimals = 0, caption }: Props) {
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...bars.map((b) => b.value), 0) || 1;
  const fmt = (v: number) => `${v.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: decimals })} ${unit}`;

  if (bars.length === 0) return <p className="text-sm text-muted-foreground">No recorded results in this build.</p>;

  return (
    <figure className="grid gap-3">
      {table ? (
        <table className="w-full text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-1.5 pr-3 font-medium">Case</th>
              <th className="py-1.5 pr-3 text-right font-medium">Value</th>
              <th className="py-1.5 font-medium">Details</th>
            </tr>
          </thead>
          <tbody>
            {bars.map((b) => (
              <tr key={b.label} className="border-b last:border-0">
                <td className="py-1.5 pr-3">{b.label}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(b.value)}</td>
                <td className="py-1.5 text-muted-foreground">{b.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="grid gap-2" role="list" aria-label={caption}>
          {bars.map((b, i) => (
            <div
              key={b.label}
              role="listitem"
              tabIndex={0}
              aria-label={`${b.label}: ${fmt(b.value)}. ${b.detail}`}
              className="relative grid grid-cols-[minmax(7rem,11rem)_1fr] items-center gap-3 rounded-md px-1 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
            >
              <span className="truncate text-sm">{b.label}</span>
              <div className="flex items-center gap-2">
                <div className="h-3 flex-1 border-l border-border">
                  <div
                    className="h-full rounded-r-[4px] bg-chart transition-opacity"
                    style={{ width: `${Math.max((b.value / max) * 100, 0.8)}%`, opacity: hover === null || hover === i ? 1 : 0.55 }}
                  />
                </div>
                <span className="w-24 shrink-0 text-right text-sm font-medium tabular-nums">{fmt(b.value)}</span>
              </div>
              {hover === i && (
                <div className="pointer-events-none absolute left-[11rem] top-full z-20 mt-1 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
                  <div className="font-semibold">{b.label}</div>
                  <div className="text-muted-foreground">{b.detail}</div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <figcaption className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{caption}</span>
        <Button variant="ghost" size="sm" onClick={() => setTable((t) => !t)} aria-pressed={table}>
          <Table2 /> {table ? "Show as chart" : "Show as table"}
        </Button>
      </figcaption>
    </figure>
  );
}
