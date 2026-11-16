import { Session } from 'node:inspector';

/*
 * Where a failing allocation gate's bytes come from (the simulation caveats: "Find a site with the
 * sampling heap profiler, never by guessing"). Run only after a gate has failed, so it costs nothing on
 * a passing bench; it doesn't decide the gate, it explains it. A Windows-only `tick-wired-plant`
 * failure (exactly 320 B per tick) took a day to place without it.
 */

interface ProfileNode {
  readonly callFrame: { readonly functionName: string; readonly url: string; readonly lineNumber: number };
  readonly selfSize: number;
  readonly children: readonly ProfileNode[];
}

/**
 * Runs the sampled work: only allocations under this frame count, never the profiler's own (the
 * inspector session's messages, which otherwise top the list).
 */
function sampledWork(work: () => void): void {
  work();
}

/** V8 samples an allocation every this many bytes on average (scaled to an unbiased estimate). */
const SAMPLING_INTERVAL = 64;

/**
 * The top `top` allocation sites (caller > function:line in the bundle, bytes per unit) while `work`
 * runs `units` units (ticks, reads), by V8's sampling heap profiler with collected objects kept, so a
 * scavenge mid-window loses nothing. Formatted for a gate's failure message: `"none sampled"` if empty.
 */
export function allocationSites(work: () => void, units: number, top = 5): string {
  const session = new Session();
  session.connect();
  let head: ProfileNode | null = null;
  try {
    const sampling = {
      samplingInterval: SAMPLING_INTERVAL,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    };
    // A session in the same thread answers each post synchronously.
    session.post('HeapProfiler.startSampling', sampling, (error) => {
      if (error) throw error;
    });
    sampledWork(work);
    session.post('HeapProfiler.stopSampling', (error, result) => {
      if (error) throw error;
      head = result.profile.head as ProfileNode;
    });
  } finally {
    session.disconnect();
  }
  if (head === null) throw new Error('HeapProfiler.stopSampling returned no profile');
  const sites = new Map<string, number>();
  const walk = (node: ProfileNode, inWork: boolean, caller: string) => {
    const { functionName, url, lineNumber } = node.callFrame;
    const name = `${functionName || '(anonymous)'} ${url.split(/[\\/]/).pop() ?? ''}:${lineNumber + 1}`;
    const counted = inWork || functionName === sampledWork.name;
    if (counted && node.selfSize > 0) {
      const site = `${caller} > ${name}`;
      sites.set(site, (sites.get(site) ?? 0) + node.selfSize);
    }
    for (const child of node.children) walk(child, counted, name);
  };
  walk(head, false, '(root)');
  const ranked = [...sites].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, top);
  if (ranked.length === 0) return 'none sampled';
  return ranked.map(([site, bytes]) => `${(bytes / units).toFixed(1)} B ${site}`).join('; ');
}
