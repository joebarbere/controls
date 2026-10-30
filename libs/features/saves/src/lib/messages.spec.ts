import { SaveIoError } from '@controls/platform-api';
import type { LoadGameError } from '@controls/scripting-api';
import { SaveIoErrorCode as Codes } from '@controls/ipc-contract';
import { loadErrorReason, saveIoCodeOf, saveIoReason } from './messages';

const HOSTILE = '../../do-not-echo/<script>';

describe('save and load messages', () => {
  it('explain every refused save without echoing anything from the file', () => {
    const errors: LoadGameError[] = [
      { kind: 'not-a-zip', message: HOSTILE },
      { kind: 'unsupported-zip', message: HOSTILE },
      { kind: 'too-many-entries', limit: 64, message: HOSTILE },
      { kind: 'unsafe-path', entry: HOSTILE, message: HOSTILE },
      { kind: 'duplicate-entry', entry: HOSTILE, message: HOSTILE },
      { kind: 'entry-too-large', entry: HOSTILE, limit: 1, message: HOSTILE },
      { kind: 'corrupt-entry', entry: HOSTILE, message: HOSTILE },
      { kind: 'too-large', limit: 1, message: HOSTILE },
      { kind: 'total-too-large', limit: 1, message: HOSTILE },
      { kind: 'unexpected-entry', entry: HOSTILE, message: HOSTILE },
      { kind: 'missing-entry', entry: HOSTILE, message: HOSTILE },
      { kind: 'not-utf8', entry: HOSTILE, message: HOSTILE },
      { kind: 'not-json', entry: HOSTILE, message: HOSTILE },
      { kind: 'newer-than-build', found: 9, supported: 1, appVersion: HOSTILE, message: HOSTILE },
      { kind: 'version-mismatch', entry: HOSTILE, expected: 1, found: 2, message: HOSTILE },
      {
        kind: 'invalid-document',
        entry: HOSTILE,
        error: {
          kind: 'invalid',
          document: 'world document',
          version: 1,
          issues: [{ path: HOSTILE, message: HOSTILE }],
          message: HOSTILE,
        },
        message: HOSTILE,
      },
      {
        kind: 'invalid-document',
        entry: HOSTILE,
        error: { kind: 'migration-failed', document: 'world document', from: 1, to: 2, issues: [], message: HOSTILE },
        message: HOSTILE,
      },
      { kind: 'invalid-thumbnail', message: HOSTILE },
      { kind: 'end-tick-mismatch', worldTick: 1, endTick: 2, message: HOSTILE },
      { kind: 'invalid-device-state', issues: [{ path: HOSTILE, message: HOSTILE }], message: HOSTILE },
    ];
    for (const error of errors) {
      const reason = loadErrorReason(error);
      expect(reason.length).toBeGreaterThan(10);
      expect(reason).not.toContain('do-not-echo');
    }
    expect(loadErrorReason(errors[13])).toMatch(/newer version of Controls/);
    expect(loadErrorReason(errors[16])).toMatch(/can’t upgrade/);
    expect(loadErrorReason(errors[19])).toMatch(/devices/);
  });

  it('explain every platform refusal code, and treat anything else as an I/O failure', () => {
    for (const code of Codes.options) {
      const reason = saveIoReason(new SaveIoError(code, HOSTILE), 'save');
      expect(reason).not.toContain('do-not-echo');
      expect(reason.length).toBeGreaterThan(10);
    }
    expect(saveIoCodeOf(new Error(`save:read refused (exists). ${HOSTILE}`))).toBe('io');
    expect(saveIoReason(new Error(HOSTILE), 'load')).toBe('The file couldn’t be read.');
    expect(saveIoReason(new SaveIoError('too-large'), 'save')).toBe('The game is too large to save.');
    expect(saveIoReason(new SaveIoError('too-large'), 'load')).toBe('The save is too large to load.');
  });
});
