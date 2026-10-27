import { focusableElements, restoreFocus } from './focusable';

describe('focusableElements', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it('returns tabbable elements in DOM order and skips disabled, negative tabindex, inert and hidden', () => {
    document.body.innerHTML = `
      <div id="root">
        <button id="a">A</button>
        <button id="b" disabled>B</button>
        <span id="c" tabindex="0">C</span>
        <span id="d" tabindex="-1">D</span>
        <div inert><button id="e">E</button></div>
        <div hidden><input id="f" /></div>
        <a id="g" href="#x">G</a>
        <a id="h">no href</a>
        <input id="i" type="hidden" />
        <select id="j"></select>
      </div>`;
    const ids = focusableElements(document.getElementById('root') as HTMLElement).map((el) => el.id);
    expect(ids).toEqual(['a', 'c', 'g', 'j']);
  });

  it('treats a named radio group as one tab stop: the checked radio, else the first', () => {
    document.body.innerHTML = `
      <div id="root">
        <input type="radio" name="theme" id="t1" />
        <input type="radio" name="theme" id="t2" checked />
        <input type="radio" name="theme" id="t3" />
        <input type="radio" name="units" id="u1" />
        <input type="radio" name="units" id="u2" />
        <input type="radio" id="lone" />
      </div>`;
    const ids = focusableElements(document.getElementById('root') as HTMLElement).map((el) => el.id);
    expect(ids).toEqual(['t2', 'u1', 'lone']);
  });
});

describe('restoreFocus', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it('focuses a connected element and refuses detached or missing ones', () => {
    document.body.innerHTML = '<button id="a">A</button>';
    const button = document.getElementById('a') as HTMLButtonElement;
    expect(restoreFocus(button)).toBe(true);
    expect(document.activeElement).toBe(button);
    const detached = document.createElement('button');
    expect(restoreFocus(detached)).toBe(false);
    expect(restoreFocus(null)).toBe(false);
  });
});
