import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { screen, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { SettingsDialog } from './settings-dialog';
import { SettingsStore } from './settings-store';

@Component({
  selector: 'ctl-settings-host',
  imports: [SettingsDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" (click)="open.set(true)">Settings</button>
    <ctl-settings-dialog [(open)]="open" />
  `,
})
class Host {
  readonly open = signal(false);
}

async function setup() {
  const fixture = TestBed.createComponent(Host);
  document.body.appendChild(fixture.nativeElement);
  const store = TestBed.inject(SettingsStore);
  await store.loaded;
  await fixture.whenStable();
  const user = userEvent.setup();
  const opener = screen.getByRole('button', { name: 'Settings' });
  await user.click(opener);
  await fixture.whenStable();
  return { fixture, store, user, opener, dialog: screen.getByRole('dialog', { name: 'Settings' }) };
}

describe('SettingsDialog', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    delete document.documentElement.dataset['theme'];
    delete document.documentElement.dataset['motion'];
  });

  it('has every F1.1 section as a named group', async () => {
    const { dialog } = await setup();
    for (const name of ['Interface', 'Graphics', 'Audio', 'Controls', 'Units', 'Difficulty', 'Saves', 'Region']) {
      expect(within(dialog).getByRole('group', { name })).toBeTruthy();
    }
  });

  it('edits autosave: on or off, the interval and the slot count (F1.8b)', async () => {
    const { fixture, store, user, dialog } = await setup();
    const saves = within(dialog).getByRole('group', { name: 'Saves' });
    const autosave = within(saves).getByRole('checkbox', { name: 'Autosave' }) as HTMLInputElement;
    expect(autosave.checked).toBe(true);
    expect((within(saves).getByRole('combobox', { name: 'Autosave every' }) as HTMLSelectElement).value).toBe('300');
    await user.click(autosave);
    await user.selectOptions(within(saves).getByRole('combobox', { name: 'Autosave every' }), '900'); // 15 minutes
    await user.selectOptions(within(saves).getByRole('combobox', { name: 'Autosave slots' }), '5');
    await fixture.whenStable();
    expect(store.settings().autosave).toEqual({ enabled: false, intervalSeconds: 900, slotCount: 5 });

    // A stored interval that isn't offered is still shown, not a blank select.
    store.update('autosave', { intervalSeconds: 90 });
    await fixture.whenStable();
    const every = within(saves).getByRole('combobox', { name: 'Autosave every' }) as HTMLSelectElement;
    expect(every.selectedOptions[0]?.textContent?.trim()).toBe('1.5 minutes');

    await user.click(within(dialog).getByRole('button', { name: 'Restore defaults' }));
    expect(store.settings().autosave).toEqual({ enabled: true, intervalSeconds: 300, slotCount: 3 });
  });

  it('edits each section through labelled controls', async () => {
    const { fixture, store, user, dialog } = await setup();
    await user.click(within(dialog).getByRole('radio', { name: 'WebGL2 only' }));
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Pixel-ratio cap' }), '1.5×');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Invert vertical look' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Metric (mm, m, mm²)' }));
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Default for new games' }), 'Realistic');
    // jsdom/user-event don't step range inputs with arrow keys (Playwright covers that); set values directly.
    const slide = (name: string, value: string) => {
      const slider = within(dialog).getByRole('slider', { name }) as HTMLInputElement;
      slider.value = value;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return slider;
    };
    slide('Master volume', '95');
    const look = slide('Look sensitivity', '110');
    await fixture.whenStable();

    const s = store.settings();
    expect(s.graphics).toEqual({ backend: 'webgl2', pixelRatioCap: 1.5 });
    expect(s.controls.invertY).toBe(true);
    expect(s.controls.lookSensitivity).toBeCloseTo(1.1);
    expect(s.audio.master).toBeCloseTo(0.95);
    expect(s.display.units).toBe('metric');
    expect(s.gameplay.defaultDifficulty).toBe('realistic');
    expect(look.getAttribute('aria-valuetext')).toBe('110 percent');
  });

  it('sets the audio volumes from range inputs', async () => {
    const { store, dialog } = await setup();
    for (const [name, key] of [
      ['Master volume', 'master'],
      ['Effects volume', 'effects'],
      ['Ambience volume', 'ambience'],
      ['Interface volume', 'interface'],
    ] as const) {
      const slider = within(dialog).getByRole('slider', { name }) as HTMLInputElement;
      slider.value = '35';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      expect(store.settings().audio[key]).toBe(0.35);
    }
  });

  it('overrides the theme and motion on <html>, and Restore defaults undoes it', async () => {
    const { fixture, user, dialog } = await setup();
    await user.click(within(dialog).getByRole('radio', { name: 'Dark' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Reduce motion' }));
    await fixture.whenStable();
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(document.documentElement.dataset['motion']).toBe('reduce');
    await user.click(within(dialog).getByRole('radio', { name: 'Light' }));
    await fixture.whenStable();
    expect(document.documentElement.dataset['theme']).toBe('light');
    await user.click(within(dialog).getByRole('radio', { name: 'Full motion' }));
    await fixture.whenStable();
    expect(document.documentElement.dataset['motion']).toBe('full');

    await user.click(within(dialog).getByRole('button', { name: 'Restore defaults' }));
    await fixture.whenStable();
    expect(document.documentElement.dataset['theme']).toBeUndefined();
    expect(document.documentElement.dataset['motion']).toBeUndefined();
    expect((within(dialog).getByRole('radio', { name: 'Match system' }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole('radio', { name: 'Follow system' }) as HTMLInputElement).checked).toBe(true);
  });

  it('shows the region as NEC and disabled', async () => {
    const { dialog } = await setup();
    const region = within(dialog).getByRole('combobox', { name: 'Electrical code' }) as HTMLSelectElement;
    expect(region.disabled).toBe(true);
    expect(region.value).toBe('nec');
  });

  it('Key bindings… opens the rebinding dialog on top; Escape there closes only it and restores focus', async () => {
    const { fixture, user, dialog } = await setup();
    const button = within(dialog).getByRole('button', { name: 'Key bindings…' });
    await user.click(button);
    await fixture.whenStable();
    const bindings = screen.getByRole('dialog', { name: 'Key bindings' });
    expect(within(bindings).getByRole('table', { name: 'Edit' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await fixture.whenStable();
    expect(screen.queryByRole('dialog', { name: 'Key bindings' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(document.activeElement).toBe(button);

    // Closing settings closes the rebinding dialog too.
    await user.click(button);
    await fixture.whenStable();
    fixture.componentInstance.open.set(false);
    await fixture.whenStable();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Back closes the dialog and returns focus to the opener', async () => {
    const { fixture, user, dialog, opener } = await setup();
    within(dialog).getByRole('button', { name: 'Back' }).focus();
    await user.keyboard('{Enter}');
    await fixture.whenStable();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
