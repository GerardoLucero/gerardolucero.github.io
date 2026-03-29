import { useEffect, useState } from "preact/hooks";

type Day = { date: string; count: number; level: 0 | 1 | 2 | 3 | 4 };
type Week = { month: string; days: (Day | null)[] };

const COLORS = [
  "color-mix(in srgb, var(--color-text-muted) 20%, var(--color-surface-light))",
  "color-mix(in srgb, var(--color-primary) 30%, var(--color-surface))",
  "color-mix(in srgb, var(--color-primary) 55%, var(--color-surface))",
  "color-mix(in srgb, var(--color-primary) 80%, var(--color-surface))",
  "var(--color-primary)",
];

function buildWeeks(days: Day[]): { weeks: Week[]; monthLabels: string[] } {
  if (!days.length) return { weeks: [], monthLabels: [] };
  const firstDow = new Date(days[0].date).getDay();
  const padded: (Day | null)[] = [...Array(firstDow).fill(null), ...days];
  const weeks: Week[] = [];
  for (let i = 0; i < padded.length; i += 7) {
    const chunk = padded.slice(i, i + 7);
    while (chunk.length < 7) chunk.push(null);
    const first = chunk.find(d => d !== null);
    weeks.push({
      month: first
        ? new Date(first.date).toLocaleString("en-US", { month: "short" })
        : "",
      days: chunk,
    });
  }
  const monthLabels = weeks.map((w, i) =>
    i === 0 || weeks[i - 1].month !== w.month ? w.month : ""
  );
  return { weeks, monthLabels };
}

export default function ContributionHeatmap({ username }: { username: string }) {
  const [weeks, setWeeks] = useState<Week[]>([]);
  const [monthLabels, setMonthLabels] = useState<string[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`https://github-contributions-api.jogruber.de/v4/${username}?y=last`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.contributions) return;
        const { weeks: w, monthLabels: ml } = buildWeeks(data.contributions);
        setWeeks(w);
        setMonthLabels(ml);
        const year = new Date().getFullYear();
        setTotal(data.total?.[year] ?? data.contributions.reduce((s: number, d: Day) => s + d.count, 0));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [username]);

  if (loading) {
    return (
      <div style="height:100px;background:var(--color-surface);border-radius:8px;animation:shimmer 1.5s infinite;background:linear-gradient(90deg,var(--color-surface) 25%,var(--color-surface-light) 50%,var(--color-surface) 75%);background-size:200% 100%" />
    );
  }

  if (!weeks.length) return null;

  return (
    <div style="overflow-x:auto;padding-bottom:0.5rem">
      {/* Total count */}
      {total > 0 && (
        <p style="font-size:0.8rem;color:var(--color-text-muted);font-family:var(--font-mono);margin:0 0 0.75rem">
          <span style="color:var(--color-heading);font-weight:700">{total.toLocaleString()}</span>
          {" "}contributions in the last year
        </p>
      )}
      <div style="min-width:max-content">
        {/* Month labels */}
        <div style="display:flex;gap:2px;margin-bottom:4px">
          {weeks.map((_, i) => (
            <div
              key={i}
              style="width:13px;font-size:0.58rem;font-family:var(--font-mono);color:var(--color-text-muted);overflow:visible;white-space:nowrap"
            >
              {monthLabels[i]}
            </div>
          ))}
        </div>

        {/* Day grid */}
        <div style="display:flex;gap:2px">
          {weeks.map((week, wi) => (
            <div key={wi} style="display:flex;flex-direction:column;gap:2px">
              {week.days.map((day, di) => (
                <div
                  key={di}
                  title={day ? `${day.date}: ${day.count} contributions` : ""}
                  style={`width:11px;height:11px;border-radius:2px;background:${COLORS[day?.level ?? 0]}`}
                />
              ))}
            </div>
          ))}
        </div>

        {/* Legend */}
        <div style="display:flex;align-items:center;gap:3px;margin-top:6px;justify-content:flex-end">
          <span style="font-size:0.6rem;color:var(--color-text-muted);font-family:var(--font-mono)">Less</span>
          {[0,1,2,3,4].map(l => (
            <div key={l} style={`width:11px;height:11px;border-radius:2px;background:${COLORS[l]}`} />
          ))}
          <span style="font-size:0.6rem;color:var(--color-text-muted);font-family:var(--font-mono)">More</span>
        </div>
      </div>
    </div>
  );
}
