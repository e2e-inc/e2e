// The controls page: each control is one case the engine got wrong once, read
// and driven by tests/controls.e2e.ts.

const someFiles = document.querySelector('#some-files');
someFiles.addEventListener('click', () => someFiles.setAttribute('aria-checked', 'true'));

const attachment = document.querySelector('[data-testid="attachment"]');
attachment.addEventListener('change', () => {
  document.querySelector('[data-testid="attachment-count"]').textContent = `${attachment.files.length} files`;
});

document.querySelector('#guard').addEventListener('click', () => {
  window.addEventListener('beforeunload', (event) => event.preventDefault());
});

// Covers the button, renders it anew while covered, then uncovers it: a tap that waited on the first button must find the new one.
document.querySelector('#rerender-start').addEventListener('click', () => {
  const cover = document.createElement('div');
  cover.id = 'cover';
  document.body.append(cover);
  setTimeout(() => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Save draft';
    button.addEventListener('click', () => {
      document.querySelector('[data-testid="draft-status"]').textContent = 'Saved';
    });
    document.querySelector('#rerender-host').replaceChildren(button);
  }, 400);
  setTimeout(() => cover.remove(), 800);
});

document.querySelector('#scroll-under').addEventListener('click', () => {
  const target = document.querySelector('#under-header');
  window.scrollTo(0, target.getBoundingClientRect().top + window.scrollY - 20);
});
document.querySelector('#under-header').addEventListener('click', () => {
  document.querySelector('[data-testid="under-header-status"]').textContent = 'Tapped';
});

// Typeahead: a key moves the selection to the first option it starts.
const planets = document.querySelector('#planets');
planets.addEventListener('keydown', (event) => {
  const next = [...planets.querySelectorAll('[role="option"]')].find((option) => option.textContent.toLowerCase().startsWith(event.key.toLowerCase()));
  if (next === undefined) return;
  for (const option of planets.querySelectorAll('[role="option"]')) option.setAttribute('aria-selected', String(option === next));
});

document.querySelector('#tip-anchor').addEventListener('mouseenter', () => {
  document.querySelector('[data-testid="tip"]').textContent = 'Tip shown';
});

const hold = document.querySelector('#hold');
hold.addEventListener('pointerdown', () => {
  document.querySelector('[data-testid="hold-state"]').textContent = 'down';
});
hold.addEventListener('pointerup', () => {
  document.querySelector('[data-testid="hold-state"]').textContent = 'up';
});

// What an editor that keeps its own model sees: the last beforeinput.
document.querySelector('[data-testid="tracked"]').addEventListener('beforeinput', (event) => {
  document.querySelector('[data-testid="tracked-event"]').textContent = event.inputType;
});

const scheme = window.matchMedia('(prefers-color-scheme: dark)');
const showScheme = () => {
  document.querySelector('[data-testid="scheme"]').textContent = scheme.matches ? 'dark' : 'light';
};
scheme.addEventListener('change', showScheme);
showScheme();

// An HTML drag: the drop reads what dragstart put in the data transfer, which only a real drag carries.
const tray = document.querySelector('#tray');
document.querySelector('#card').addEventListener('dragstart', (event) => {
  event.dataTransfer.setData('text/plain', 'card');
});
tray.addEventListener('dragover', (event) => event.preventDefault());
tray.addEventListener('drop', (event) => {
  event.preventDefault();
  document.querySelector('[data-testid="tray-status"]').textContent = `Tray holds ${event.dataTransfer.getData('text/plain')}`;
});
