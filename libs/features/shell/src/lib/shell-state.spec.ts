import { TestBed } from '@angular/core/testing';
import { ShellState } from './shell-state';

describe('ShellState', () => {
  it('starts at the menu with no session, and New sandbox enters the workspace', () => {
    const shell = TestBed.inject(ShellState);
    expect(shell.screen()).toBe('menu');
    expect(shell.menuOpen()).toBe(true);
    expect(shell.sessionActive()).toBe(false);

    shell.resume(); // nothing to resume yet
    expect(shell.screen()).toBe('menu');

    shell.openDialog('settings');
    shell.newSandbox();
    expect(shell.screen()).toBe('workspace');
    expect(shell.dialog()).toBeNull();
    expect(shell.sessionActive()).toBe(true);
  });

  it('returns to the menu and resumes, and tracks the open dialog', () => {
    const shell = TestBed.inject(ShellState);
    shell.newSandbox();
    shell.openMenu();
    expect(shell.menuOpen()).toBe(true);
    shell.resume();
    expect(shell.screen()).toBe('workspace');
    shell.openDialog('about');
    expect(shell.dialog()).toBe('about');
    shell.closeDialog();
    expect(shell.dialog()).toBeNull();
  });
});
