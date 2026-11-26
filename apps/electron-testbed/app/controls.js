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
