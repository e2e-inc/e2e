// Paste into the Microsoft Terminology Search page (javascript_tool), once per page load.
//
// msTerms()      the source terms and translations the report shows now, as lists.
//                They are NOT paired row by row: each table sorts on its own.
// await msFind(term)
//                after searching the term, scrolls the source table until the entry whose
//                text is exactly the term is rendered (the report loads about 20 rows at a
//                time and a common word is buried among compounds), clicks it so the
//                translation table filters to that entry, and returns its concept and
//                translations as JSON. `exact: false` means no entry is exactly the term.
window.msTerms = () => {
  const text = document.body.innerText.replaceAll('​', '');
  const split = text.indexOf('Language\nTranslated term');
  const sources = text.slice(0, split).split('Select Row').slice(1).map((chunk) => chunk.trim().split('\n')[0].trim());
  const translated = text.slice(split).split('Select Row').slice(1).map((chunk) => chunk.trim().split('\n')[1]?.trim()).filter(Boolean);
  return JSON.stringify({ src: [...new Set(sources)], tr: [...new Set(translated)] });
};

window.msFind = async (term) => {
  const clean = (s) => s.replaceAll('​', '').trim();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const source = document.querySelectorAll('.mid-viewport')[0];
  source.scrollTop = 0;
  await wait(200);
  let target;
  for (let top = 0; top <= source.scrollHeight + 300 && !target; top += 150) {
    source.scrollTop = top;
    await wait(110);
    target = [...source.querySelectorAll('[role=gridcell],[role=rowheader]')].find((cell) => clean(cell.innerText).toLowerCase() === term.toLowerCase());
  }
  if (!target) return JSON.stringify({ term, exact: false });
  target.click();
  await wait(1500);
  const text = document.body.innerText.replaceAll('​', '');
  const split = text.indexOf('Language\nTranslated term');
  const translations = text
    .slice(split)
    .split('Select Row')
    .slice(1)
    .map((chunk) => chunk.trim().split('\n').map((line) => line.trim()).filter(Boolean))
    .filter((row) => row.length > 1)
    .map((row) => `${row[1]} (${row[2] ?? ''}; ${row.at(-1)})`);
  const concept = text.slice(0, split).split('Select Row').slice(1).map((chunk) => chunk.trim().split('\n')).find((row) => clean(row[0]).toLowerCase() === term.toLowerCase())?.[1]?.slice(0, 90);
  return JSON.stringify({ term, exact: true, concept, es: [...new Set(translations)].slice(0, 6) });
};
