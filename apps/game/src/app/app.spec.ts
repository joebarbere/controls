import { TestBed } from '@angular/core/testing';
import type { Platform } from '@controls/platform-api';
import { App } from './app';
import { PLATFORM } from './platform.token';

describe('App', () => {
  const fakePlatform: Platform = {
    kind: 'electron',
    getAppInfo: async () => ({
      appVersion: '9.8.7',
      platform: 'linux',
      arch: 'x64',
      isPackaged: true,
      versions: { electron: '45.0.0' },
    }),
  };

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined); // jsdom has no WebGL/WebGPU
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: PLATFORM, useValue: fakePlatform }],
    }).compileComponents();
  });

  it('shows the title and the platform-reported version', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h1')?.textContent).toContain('Controls');
    expect(el.querySelector('[data-testid="about-version"]')?.textContent).toBe('9.8.7');
    expect(el.querySelector('[data-testid="about-platform"]')?.textContent).toContain('Electron 45.0.0');
  });
});
