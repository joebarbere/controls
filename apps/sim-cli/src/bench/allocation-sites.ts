import { Session } from 'node:inspector';

/*
 * What the measured work allocates, by V8's sampling heap profiler (the simulation caveats: "Find a
 * site with the sampling heap profiler, never by guessing", and "Measuring allocation in a spec").
 * `sampledBytes` is how the snapshot-read gates measure a read: only allocations under the work's
 * frame count, so nothing else in the process (the profiler's own messages, a test runner's, the
 * heap's growth from a compile) reaches the gate. `allocationSites` explains a failing gate; it runs
 * only after a gate has failed. A Windows-only `tick-wired-plant` failure (exactly 320 B per tick) took
 * a day to place without it.
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
 * The bytes allocated under `work`, by site (caller > function:line in the bundle), by V8's sampling
 * heap profiler with collected objects kept, so a scavenge mid-window loses nothing.
 */
function sampledSites(work: () => void): Map<string, number> {
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
  return sites;
}

/** The bytes allocated under `work` (sampled: an unbiased estimate, exactly 0 if it allocates nothing). */
export function sampledBytes(work: () => void): number {
  let bytes = 0;
  for (const site of sampledSites(work).values()) bytes += site;
  return bytes;
}

/**
 * The top `top` allocation sites (caller > function:line in the bundle, bytes per unit) while `work`
 * runs `units` units (ticks, reads). Formatted for a gate's failure message: `"none sampled"` if empty.
 */
export function allocationSites(work: () => void, units: number, top = 5): string {
  const ranked = [...sampledSites(work)].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, top);
  if (ranked.length === 0) return 'none sampled';
  return ranked.map(([site, bytes]) => `${(bytes / units).toFixed(1)} B ${site}`).join('; ');
}
