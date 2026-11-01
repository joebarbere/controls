import { isRendererCrashRecovery, rendererCrashRecoveryUrl } from './recovery';

describe('renderer crash recovery URL', () => {
  it('adds the recovery query to the entry URL, which the page recognises', () => {
    const url = rendererCrashRecoveryUrl('app://game/index.html');
    expect(url).toBe('app://game/index.html?recovered=renderer-crash');
    expect(isRendererCrashRecovery(new URL(url).search)).toBe(true);
  });

  it('recognises only the exact value', () => {
    expect(isRendererCrashRecovery('')).toBe(false);
    expect(isRendererCrashRecovery('?recovered=1')).toBe(false);
    expect(isRendererCrashRecovery('?recovered=renderer-crash-x')).toBe(false);
    expect(isRendererCrashRecovery('?renderer=webgl2&recovered=renderer-crash')).toBe(true);
  });
});
