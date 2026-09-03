'use client';

import { useMemo, useState } from 'react';
import type { Trend } from '@/lib/types';
import { portalLabel } from './ui';

/**
 * Applications over time, one line per portal.
 *
 * Colour carries portal identity and is assigned in fixed order — never cycled, and never
 * re-assigned when a portal drops out of the range, so a filtered chart does not repaint the
 * survivors. Both palettes were validated for lightness band, chroma floor, colour-vision
 * separation and contrast against their own surface; the dark steps are chosen, not an
 * inversion of the light ones.
 *
 * Identity is never colour alone: every series is in the legend, and the hovered point names
 * its portal in the tooltip.
 */

const SERIES_ORDER = ['linkedin', 'indeed', 'dice'] as const;

const PAD = { top: 16, right: 18, bottom: 30, left: 40 };
const WIDTH = 760;
const HEIGHT = 220;

interface Point {
  bucket: string;
  values: Record<string, number>;
  total: number;
}

function niceCeiling(max: number): number {
  if (max <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = magnitude * step;
    if (candidate >= max) return candidate;
  }
  return magnitude * 10;
}

function shortLabel(bucket: string): string {
  // Buckets are either a date (2026-09-03) or an ISO week (2026-W36).
  if (/^\d{4}-W\d+$/.test(bucket)) return `W${bucket.split('-W')[1]}`;
  const date = new Date(bucket);
  if (Number.isNaN(date.getTime())) return bucket;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function TrendChart({ trend, title }: { trend: Trend; title?: string }) {
  const [hover, setHover] = useState<number | null>(null);

  const { points, portals, yMax } = useMemo(() => {
    const buckets = new Map<string, Record<string, number>>();
    const seen = new Set<string>();

    for (const row of trend.series) {
      seen.add(row.portal);
      const entry = buckets.get(row.bucket) ?? {};
      entry[row.portal] = (entry[row.portal] ?? 0) + row.count;
      buckets.set(row.bucket, entry);
    }

    const activePortals = SERIES_ORDER.filter((p) => seen.has(p));
    const ordered = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));

    const pts: Point[] = ordered.map(([bucket, values]) => ({
      bucket,
      values,
      total: activePortals.reduce((sum, p) => sum + (values[p] ?? 0), 0),
    }));

    const peak = Math.max(0, ...pts.flatMap((p) => activePortals.map((portal) => p.values[portal] ?? 0)));

    return { points: pts, portals: activePortals, yMax: niceCeiling(peak) };
  }, [trend]);

  if (!points.length) {
    return (
      <div className="empty">
        <span className="empty-title">No applications in this range</span>
        <span className="empty-note">The chart fills in once runs start submitting.</span>
      </div>
    );
  }

  // One bucket is not a trend. A line through a single point is 200px of empty plot that
  // says less than the numbers themselves, so show the numbers instead.
  if (points.length === 1) {
    const only = points[0]!;
    return (
      <div className="chart">
        {title && <div className="chart-title">{title}</div>}
        <div className="single-bucket">
          <div className="tile-label">All activity so far · {shortLabel(only.bucket)}</div>
          <div className="single-bucket-rows">
            {portals.map((portal) => (
              <span className="legend-item" key={portal}>
                <span className="legend-swatch" data-series={portal} />
                {portalLabel(portal)}
                <span className="tip-num">{only.values[portal] ?? 0}</span>
              </span>
            ))}
          </div>
          <span className="empty-note">
            A trend needs more than one {trend.interval}. This becomes a chart once activity
            spans a second {trend.interval}.
          </span>
        </div>
      </div>
    );
  }

  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  const x = (i: number) => PAD.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH;

  // Four gridlines including zero, each labelled with a value the scale actually reaches.
  const ticks = [0, yMax / 2, yMax].map((v) => Math.round(v));
  const uniqueTicks = [...new Set(ticks)];

  // Thin out x labels so they never collide at ~50px each.
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.floor(plotW / 58)));

  const active = hover !== null ? points[hover] : null;

  return (
    <div className="chart">
      {title && <div className="chart-title">{title}</div>}

      <div className="chart-legend">
        {portals.map((portal) => (
          <span className="legend-item" key={portal}>
            <span className="legend-swatch" data-series={portal} />
            {portalLabel(portal)}
          </span>
        ))}
      </div>

      <div className="chart-frame">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={`Applications per ${trend.interval} by portal`}
          onMouseLeave={() => setHover(null)}
        >
          {uniqueTicks.map((tick) => (
            <g key={tick}>
              <line className="grid" x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} />
              <text className="axis" x={PAD.left - 8} y={y(tick) + 4} textAnchor="end">
                {tick}
              </text>
            </g>
          ))}

          {points.map((point, i) =>
            i % labelEvery === 0 ? (
              <text className="axis" key={point.bucket} x={x(i)} y={HEIGHT - 10} textAnchor="middle">
                {shortLabel(point.bucket)}
              </text>
            ) : null,
          )}

          {portals.map((portal) => {
            const path = points
              .map((point, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(point.values[portal] ?? 0).toFixed(1)}`)
              .join(' ');
            return (
              <path
                key={portal}
                className="series-line"
                data-series={portal}
                d={path}
                fill="none"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          })}

          {/* Markers only when the range is short enough that they do not merge into the line. */}
          {points.length <= 20 &&
            portals.map((portal) =>
              points.map((point, i) => (
                <circle
                  key={`${portal}-${i}`}
                  className="series-dot"
                  data-series={portal}
                  cx={x(i)}
                  cy={y(point.values[portal] ?? 0)}
                  r={hover === i ? 4.5 : 3}
                />
              )),
            )}

          {active && <line className="crosshair" x1={x(hover!)} x2={x(hover!)} y1={PAD.top} y2={PAD.top + plotH} />}

          {/* Full-height hit bands: a bigger target than the marks themselves. */}
          {points.map((point, i) => (
            <rect
              key={`hit-${point.bucket}`}
              x={x(i) - plotW / Math.max(1, points.length * 2) - 2}
              y={PAD.top}
              width={plotW / Math.max(1, points.length) + 4}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>

        {active && (
          <div
            className="chart-tip"
            style={{
              left: `${(x(hover!) / WIDTH) * 100}%`,
              transform: x(hover!) > WIDTH * 0.7 ? 'translateX(-100%)' : 'none',
            }}
          >
            <strong>{shortLabel(active.bucket)}</strong>
            {portals.map((portal) => (
              <span key={portal} className="tip-row">
                <span className="legend-swatch" data-series={portal} />
                {portalLabel(portal)}
                <span className="tip-num">{active.values[portal] ?? 0}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Horizontal bars for a categorical breakdown — designation, company, portal. */
export function BreakdownBars({
  rows,
  emptyTitle,
}: {
  rows: { label: string; count: number }[];
  emptyTitle: string;
}) {
  if (!rows.length) return <div className="empty"><span className="empty-title">{emptyTitle}</span></div>;
  const max = Math.max(1, ...rows.map((r) => r.count));

  return (
    <div className="bars">
      {rows.map((row) => (
        <div className="bar-row wide" key={row.label}>
          <span title={row.label}>{row.label}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(row.count / max) * 100}%` }} />
          </div>
          <span className="bar-num">{row.count}</span>
        </div>
      ))}
    </div>
  );
}
