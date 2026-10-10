import { h } from './lib/dom.js';
import {
  MODELS,
  cleanModelId,
  getSettings,
  updateSettings,
  getHistory,
  clearHistory,
} from './lib/storage.js';
import { checkKey, testConnection } from './lib/gemini.js';

const keyForm = document.getElementById('key-form');
const keyInput = document.getElementById('api-key');
const saveButton = keyForm.querySelector('[type="submit"]');
const keyStatus = document.getElementById('key-status');
const modelStatus = document.getElementById('model-status');
const toggleKey = document.getElementById('toggle-key');
const customRadio = h('input', {
  type: 'radio',
  name: 'model',
  value: 'custom',
  onchange: () => (customModel.value ? saveModel(customModel.value) : customModel.focus()),
});
const customModel = h('input', {
  class: 'input',
  id: 'custom-model',
  placeholder: 'e.g. gemini-3.7-flash',
  spellcheck: 'false',
  'aria-label': 'Custom model ID',
  oninput: () => {
    customRadio.checked = true;
  },
  onchange: (e) => saveModel(e.target.value),
});
// The stored key, to tell whether the field holds an edit that hasn't been saved.
let savedKey = '';
// Only the latest check may report, in case an earlier one answers late.
let keyCheck = 0;
let modelCheck = 0;

init();

async function init() {
  const settings = await getSettings();
  savedKey = settings.apiKey;
  keyInput.value = savedKey;
  renderModels(settings.model);
  showHistoryCount();
  showShortcut();
  if (!settings.apiKey) keyInput.focus();
}

keyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const check = ++keyCheck;
  const apiKey = keyInput.value.trim();
  if (!apiKey) {
    await updateSettings({ apiKey: '' });
    setStatus(keyStatus, 'Key removed.');
    return;
  }
  saveButton.disabled = true;
  setStatus(keyStatus, 'Checking your key…');
  try {
    const { model } = await getSettings();
    const problem = await checkKey({ apiKey, model });
    if (check !== keyCheck) return;
    await updateSettings({ apiKey });
    const note = problem
      ? `Saved, but the key could not be verified yet. ${problem.message}`
      : 'Saved. The key works; open an article and click the toolbar icon to begin.';
    setStatus(keyStatus, note, problem ? 'err' : 'ok');
  } catch (err) {
    if (check === keyCheck) setStatus(keyStatus, err.message, 'err');
  } finally {
    if (check === keyCheck) saveButton.disabled = false;
  }
});

toggleKey.addEventListener('click', () => {
  const hidden = keyInput.type === 'password';
  keyInput.type = hidden ? 'text' : 'password';
  toggleKey.textContent = hidden ? 'Hide' : 'Show';
});

function renderModels(current) {
  document.getElementById('model-list').replaceChildren(
    ...MODELS.map((m) =>
      h(
        'label',
        { class: 'model-option' },
        h('input', {
          type: 'radio',
          name: 'model',
          value: m.id,
          onchange: () => saveModel(m.id),
        }),
        h(
          'span',
          {},
          h('strong', {}, m.label),
          h('span', { class: 'hint' }, `${m.note} `),
          h('code', { class: 'hint' }, m.id),
        ),
      ),
    ),
    h(
      'label',
      { class: 'model-option' },
      customRadio,
      h(
        'span',
        { style: { flex: '1', display: 'grid', gap: '6px' } },
        h('strong', {}, 'Another Gemini model'),
        customModel,
      ),
    ),
  );
  showModel(current);
}

// Updates the radios in place; rebuilding them would take focus from the one in use.
function showModel(model) {
  const preset = MODELS.some((m) => m.id === model);
  const value = preset ? model : 'custom';
  for (const radio of document.getElementsByName('model')) radio.checked = radio.value === value;
  customModel.value = preset ? '' : model;
}

async function saveModel(value) {
  const model = cleanModelId(value);
  const check = ++modelCheck;
  if (!model) {
    showModel((await getSettings()).model);
    return;
  }
  showModel(model);
  const { apiKey } = await updateSettings({ model });
  if (check !== modelCheck) return;
  if (!apiKey) {
    setStatus(modelStatus, `Saved. Quizzes will use ${model}.`, 'ok');
    return;
  }
  setStatus(modelStatus, `Checking ${model}…`);
  try {
    await testConnection({ apiKey, model });
    if (check === modelCheck) setStatus(modelStatus, `Saved. Quizzes will use ${model}.`, 'ok');
  } catch (err) {
    if (check === modelCheck) setStatus(modelStatus, err.message, 'err');
  }
}

async function showHistoryCount() {
  const count = (await getHistory()).length;
  document.getElementById('history-count').textContent = count
    ? `${count} saved ${count === 1 ? 'quiz' : 'quizzes'}. Retake them from History in the quiz panel.`
    : 'No saved quizzes yet.';
}

document.getElementById('clear-history').addEventListener('click', async () => {
  if (!confirm("Delete all saved quizzes and review reminders? This can't be undone.")) return;
  await clearHistory();
  showHistoryCount();
});

async function showShortcut() {
  const commands = await chrome.commands.getAll();
  const shortcut = commands.find((c) => c.name === '_execute_action')?.shortcut;
  document.getElementById('shortcut').textContent = shortcut || 'a keyboard shortcut (none set)';
}

document.getElementById('shortcut-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.history) showHistoryCount();
  const apiKey = changes.settings?.newValue?.apiKey ?? '';
  if (changes.settings && apiKey !== (changes.settings.oldValue?.apiKey ?? '')) {
    // A key saved elsewhere (the quiz panel) shows here, unless the reader has typed over the field.
    if (keyInput.value.trim() === savedKey) keyInput.value = apiKey;
    savedKey = apiKey;
  }
});

function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = `status ${kind}`;
}
