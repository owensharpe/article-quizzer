import { h, icon } from './lib/dom.js';
import {
  getSettings,
  updateSettings,
  withDefaults,
  getHistory,
  saveQuiz,
  recordAttempts,
  deleteHistoryEntry,
  reviewStatus,
  quizStats,
  normalizeUrl,
  modelLabel,
} from './lib/storage.js';
import {
  COUNTS,
  STYLES,
  DIFFICULTIES,
  DIFFICULTY_HINTS,
  POINTS,
  generateQuiz,
  gradeShortAnswer,
  explainMore,
  buildReviewSession,
  reshuffleQuestion,
  scoreAnswers,
} from './lib/quiz.js';
import {
  MAX_ARTICLE_CHARS,
  readArticle,
  readPdf,
  highlightInArticle,
  clearArticleHighlight,
} from './lib/page.js';
import { checkKey } from './lib/gemini.js';

const app = document.getElementById('app');
const tabId = Number(new URLSearchParams(location.search).get('tabId')) || null;
const RUN_KEY = `run:${tabId}`;
const INTENT_KEY = `intent:${tabId}`;
const MIN_WORDS = 30;
const WORDS_PER_QUESTION = 40;
const NOTES = [
  'Answering from memory, before reading the options, strengthens recall.',
  'A mistake followed by an explanation is one of the most effective ways to learn.',
  'Revisiting material after a few days is what makes it last.',
  'Explaining an idea in your own words is the surest test of understanding.',
];
const VERDICTS = {
  correct: { icon: 'check', label: 'Correct' },
  partial: { icon: 'dash', label: 'Partially correct' },
  incorrect: { icon: 'close', label: 'Incorrect' },
};
const CHOICE_KEYS = { 1: 0, 2: 1, 3: 2, 4: 3, a: 0, b: 1, c: 2, d: 3 };
const isMac = /Mac/i.test(navigator.userAgentData?.platform ?? navigator.platform);
// Chinese, Japanese, and Thai don't put spaces between words.
const segmenter = Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;

const state = {
  settings: withDefaults(),
  history: [],
  // Also early (read before the page finished loading) or moved (the tab now
  // shows a page the reader hasn't asked the panel to read).
  page: { article: null, error: null },
  useSelection: false,
  shortSelection: false, // asked to quiz a selection shorter than MIN_WORDS
  view: 'home', // home | generating | question | results | history
  gen: null, // { controller, startedAt, words, title, note, avoid, error }
  run: null, // { quiz, order, pos, answers, kind: 'full' | 'missed' | 'review', finished, saved }
  pdf: null, // { url, data }: the last PDF read, so "New questions" doesn't download it again
  draft: '',
  keyDraft: '',
  keyBusy: false,
  keyError: '',
};

const historyBtn = document.getElementById('history-btn');
historyBtn.addEventListener('click', () => go(state.view === 'history' ? 'home' : 'history'));
document.getElementById('settings-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener(onStorageChanged);
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (id === tabId && (info.url || info.status === 'complete')) {
    onTabChanged(info.url ?? tab.url, info.status === 'complete');
  }
});
document.addEventListener('keydown', onKeyDown);
setInterval(tickElapsed, 1000);
init();

async function init() {
  const [settings, history, session] = await Promise.all([
    getSettings(),
    getHistory(),
    chrome.storage.session.get([RUN_KEY, INTENT_KEY]),
  ]);
  state.settings = settings;
  state.history = history;
  const run = session[RUN_KEY];
  if (run?.quiz) {
    // Requests in flight didn't survive the panel closing; let the user ask again.
    for (const answer of Object.values(run.answers)) {
      delete answer.grading;
      if (answer.more?.loading) delete answer.more;
    }
    state.run = run;
    // A finished quiz isn't reopened, since the tab may show another article by now; home links to it.
    if (!run.finished) {
      state.view = 'question';
      const answer = run.answers[currentQuestion().id];
      if (answer && !answer.verdict) state.draft = answer.text ?? '';
    }
  }
  render();
  if (session[INTENT_KEY]) takeIntent(session[INTENT_KEY]);
  else loadPage(null);
}

// Each click's intent is used once, so reopening the panel later can't replay an old selection.
function takeIntent(intent) {
  chrome.storage.session.remove(INTENT_KEY);
  loadPage(intent);
}

let pageToken = 0;
// Held until a read applies it, so a re-read that overtakes the click's own read can't drop it.
let pendingIntent = null;

async function loadPage(intent, { reread = false } = {}) {
  const token = ++pageToken;
  if (intent) pendingIntent = intent;
  if (!tabId) {
    setPage({
      article: null,
      error: {
        title: 'Open Article Quizzer from the toolbar',
        detail: 'Click the Article Quizzer icon while viewing an article.',
      },
    });
    render();
    return;
  }
  let article;
  try {
    article = await readArticle(tabId);
  } catch (err) {
    if (token !== pageToken) return;
    setPage({
      article: null,
      error: { title: err.title ?? 'This page could not be read', detail: err.detail ?? err.message },
    });
    render();
    return;
  }
  if (token !== pageToken) return;
  applyIntent(article);
  setPage({ article, error: null, early: !reread && article.readyState !== 'complete' });
  render();
  // The page may have finished loading, or the tab moved on, while it was being read.
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && token === pageToken) onTabChanged(tab.url, tab.status === 'complete');
}

// A new click decides whether to quiz the selection; a re-read keeps things as they were.
function applyIntent(article) {
  const intent = pendingIntent;
  pendingIntent = null;
  if (!intent) {
    const previous = state.page.article;
    if (!article.selection && previous && normalizeUrl(previous.url) === normalizeUrl(article.url)) {
      article.selection = previous.selection;
      article.selectionWords = previous.selectionWords;
    }
    state.useSelection = state.useSelection && Boolean(article.selection);
    return;
  }
  // Inside Chrome's PDF viewer, the context menu is the only way to get the selection.
  const menuText = intent.selection ? (intent.selectionText ?? '').trim().slice(0, MAX_ARTICLE_CHARS) : '';
  const menuWords = countWords(menuText);
  if (!article.selection && menuWords >= MIN_WORDS) {
    article.selection = menuText;
    article.selectionWords = menuWords;
  }
  state.useSelection = Boolean(intent.selection && article.selection);
  state.shortSelection = Boolean(intent.selection && !article.selection);
}

function setPage(page) {
  // The downloaded PDF belongs to the page it came from.
  if (state.pdf?.url !== page.article?.url) state.pdf = null;
  state.page = page;
}

// The panel reads only the page it was opened on, and once more if that first
// read came before the page finished loading. A different page waits for the
// reader to click the icon there.
function onTabChanged(url, complete) {
  const { article, error, early } = state.page;
  if (!article && !error) return;
  if (article && normalizeUrl(url) === normalizeUrl(article.url)) {
    if (complete && early) loadPage(null, { reread: true });
    return;
  }
  setPage({ article: null, error: null, moved: true });
  render();
}

function quizText() {
  const { article } = state.page;
  return state.useSelection ? article.selection : article.text;
}

// null for PDFs, which go to Gemini as files.
function quizWords() {
  const { article } = state.page;
  if (!article) return 0;
  if (state.useSelection) return article.selectionWords;
  return article.isPdf ? null : article.wordCount;
}

function quizPdf() {
  return Boolean(state.page.article?.isPdf && !state.useSelection);
}

function tooShort() {
  const words = quizWords();
  return words !== null && words < MIN_WORDS;
}

// Short passages can't support many good questions.
function effectiveCount() {
  const words = quizWords();
  if (words === null) return state.settings.count;
  return Math.min(state.settings.count, Math.max(3, Math.floor(words / WORDS_PER_QUESTION)));
}

function onQuizPage() {
  const { article } = state.page;
  return Boolean(
    tabId && article && state.run && normalizeUrl(article.url) === normalizeUrl(state.run.quiz.url),
  );
}

// Is the article this question came from open in the panel's tab?
function questionOnPage(q) {
  const { article } = state.page;
  const url = q.source?.url ?? state.run?.quiz.url;
  return Boolean(tabId && article && url && normalizeUrl(article.url) === normalizeUrl(url));
}

function countWords(text) {
  if (!segmenter) return (text.match(/\S+/g) ?? []).length;
  let count = 0;
  for (const segment of segmenter.segment(text)) if (segment.isWordLike) count++;
  return count;
}

const VIEWS = {
  home: viewHome,
  generating: viewGenerating,
  question: viewQuestion,
  results: viewResults,
  history: viewHistory,
};
let lastScreen = '';
// Set when a re-render took focus from a control and had nowhere to put it.
let focusLost = false;

function render() {
  // Re-rendering replaces the DOM, so carry focus and caret position across.
  const active = document.activeElement;
  const hadFocus = app.contains(active) || (focusLost && active === document.body);
  const selector = app.contains(active) ? focusSelector(active) : null;
  const caret = [active?.selectionStart, active?.selectionEnd];

  app.replaceChildren(...[VIEWS[state.view]()].flat(Infinity).filter(Boolean));
  historyBtn.classList.toggle('active', state.view === 'history');

  const target = selector && app.querySelector(selector);
  if (target) {
    target.focus({ preventScroll: true });
    if (caret[0] != null) target.setSelectionRange?.(...caret);
  }
  const screen = screenKey();
  const changed = screen !== lastScreen;
  if (changed) {
    const answeredNow = screen.endsWith(':answered') && lastScreen === screen.replace(':answered', ':open');
    lastScreen = screen;
    if (answeredNow) app.querySelector('.next-row')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    else window.scrollTo(0, 0);
  }
  // A new screen, or a focused control that went away or was disabled, hands focus to the main control.
  if ((changed || hadFocus) && !app.contains(document.activeElement)) {
    app.querySelector('[data-autofocus]')?.focus({ preventScroll: true });
  }
  focusLost = hadFocus && !app.contains(document.activeElement);
}

// How to find the focused control again after a re-render.
function focusSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.dataset.key) return `[data-key="${CSS.escape(el.dataset.key)}"]`;
  return null;
}

function screenKey() {
  if (state.view !== 'question') return state.view;
  const answered = Boolean(state.run.answers[currentQuestion().id]?.verdict);
  return `question:${state.run.pos}:${answered ? 'answered' : 'open'}`;
}

function go(view) {
  // Leaving the loading screen abandons the quiz being written.
  if (state.view === 'generating' && view !== 'generating') cancelQuiz();
  state.view = view;
  render();
}

function viewHome() {
  const { error, moved } = state.page;
  const saved = savedQuiz();
  return [
    pageCard(),
    runCard(),
    saved ? savedCard(saved) : null,
    !state.settings.apiKey ? keyCard() : error || moved ? null : startCard(saved),
    reviewCard(saved),
  ];
}

// The quiz already saved for the article in this tab, if any.
function savedQuiz() {
  const { article } = state.page;
  if (!article) return null;
  const key = normalizeUrl(article.url);
  return state.history.find((entry) => entry.key === key && entry.quiz?.questions?.length) ?? null;
}

function savedCard(entry) {
  const last = entry.attempts?.at(-1);
  const facts = [
    `${entry.quiz.questions.length} questions`,
    last ? `Last score ${percent(last)}%` : 'Not finished',
    capitalize(relativeTime(last ? last.at : entry.updatedAt)),
  ];
  return h(
    'section',
    { class: 'section' },
    h('div', { class: 'kicker' }, reviewStatus(entry).due ? 'Saved quiz · Due for review' : 'Saved quiz'),
    h(
      'p',
      { class: 'prose' },
      'You already have a quiz for this article. Retaking it is instant, since Gemini does not need to write new questions.',
    ),
    h('div', { class: 'meta' }, facts.join(' · ')),
    h(
      'button',
      { class: 'btn primary block', type: 'button', onclick: () => retake(entry), 'data-autofocus': true },
      'Retake saved quiz',
    ),
  );
}

function pageCard() {
  const { article, error, moved } = state.page;
  if (moved) {
    return h(
      'section',
      { class: 'section' },
      h('div', { class: 'kicker' }, 'New page'),
      h('h2', { class: 'headline small' }, 'Click the Article Quizzer icon to quiz this page'),
      h(
        'p',
        { class: 'prose' },
        'This tab now shows a different page. Article Quizzer reads a page only after you click its icon on that page.',
      ),
    );
  }
  if (error) {
    return h(
      'section',
      { class: 'section' },
      h('div', { class: 'kicker' }, 'Unavailable'),
      h('h2', { class: 'headline small' }, error.title),
      h('p', { class: 'prose' }, error.detail),
      h(
        'div',
        {},
        h('button', { class: 'link-btn', type: 'button', onclick: () => loadPage(null) }, 'Try again'),
      ),
    );
  }
  if (!article) {
    return h(
      'section',
      { class: 'section page-card', 'aria-busy': 'true', 'aria-label': 'Reading the page' },
      h('div', { class: 'skeleton w40' }),
      h('div', { class: 'skeleton w90 tall' }),
      h('div', { class: 'skeleton w60' }),
    );
  }
  const site = article.siteName || hostname(article.url);
  return h(
    'section',
    { class: 'section page-card' },
    h('div', { class: 'kicker' }, [article.isPdf ? 'PDF' : '', site].filter(Boolean).join(' · ')),
    h(
      'h1',
      { class: 'headline', dir: 'auto' },
      article.title || (article.isPdf ? 'Untitled PDF' : 'Untitled page'),
    ),
    h(
      'div',
      { class: 'meta' },
      article.isPdf
        ? 'Gemini reads the entire PDF, including figures. Passage highlighting is available on web pages only.'
        : `${readMinutes(article.wordCount)} min read · ${formatNumber(article.wordCount)} words${article.truncated ? ' · Long article; the quiz covers the opening sections' : ''}`,
    ),
    article.selection
      ? h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: state.useSelection,
            'data-key': 'use-selection',
            onchange: (e) => {
              state.useSelection = e.target.checked;
              render();
            },
          }),
          h('span', {}, `Quiz only the selected text (${formatNumber(article.selectionWords)} words)`),
        )
      : null,
    tooShort()
      ? h(
          'p',
          { class: 'warn' },
          "This page doesn't have enough text for a quiz. Select a longer passage or open a full article.",
        )
      : state.shortSelection
        ? h(
            'p',
            { class: 'warn' },
            `The selected text is too short for a quiz. Select at least ${MIN_WORDS} words, or quiz the whole ${article.isPdf ? 'PDF' : 'article'}.`,
          )
        : null,
  );
}

// With a saved quiz on screen, this becomes the secondary "new questions" option.
function startCard(saved) {
  const { count, style, difficulty } = state.settings;
  const shortened = !tooShort() && effectiveCount() < count;
  return h(
    'section',
    { class: 'section start' },
    saved ? h('div', { class: 'kicker' }, 'New quiz') : null,
    field(
      'Questions',
      segmented(
        'Number of questions',
        COUNTS.map((n) => [n, String(n)]),
        count,
        (v) => setOption('count', v),
      ),
    ),
    field(
      'Format',
      segmented('Question type', STYLES, style, (v) => setOption('style', v)),
    ),
    field(
      'Level',
      segmented('Difficulty', DIFFICULTIES, difficulty, (v) => setOption('difficulty', v)),
      DIFFICULTY_HINTS[difficulty],
    ),
    h(
      'button',
      {
        class: saved ? 'btn block' : 'btn primary block',
        type: 'button',
        disabled: tooShort(),
        onclick: () => startQuiz(saved ? saved.quiz.questions.map((q) => q.question) : []),
        'data-autofocus': !saved,
      },
      saved ? 'Write new questions' : 'Begin quiz',
      icon('arrowRight', 14),
    ),
    shortened
      ? h('p', { class: 'hint' }, `This text is short, so the quiz will have ${effectiveCount()} questions.`)
      : null,
  );
}

function field(label, control, hint) {
  return h(
    'div',
    { class: 'field' },
    h('div', { class: 'label' }, label),
    control,
    hint ? h('div', { class: 'hint' }, hint) : null,
  );
}

function segmented(label, options, value, onChange) {
  return h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': label },
    options.map(([optionValue, text]) =>
      h(
        'button',
        {
          type: 'button',
          class: optionValue === value ? 'active' : '',
          'aria-pressed': String(optionValue === value),
          'data-key': `${label}:${optionValue}`,
          onclick: () => onChange(optionValue),
        },
        text,
      ),
    ),
  );
}

function setOption(key, value) {
  state.settings = { ...state.settings, [key]: value };
  render();
  updateSettings({ [key]: value });
}

function keyCard() {
  return h(
    'section',
    { class: 'section' },
    h('div', { class: 'kicker' }, 'Setup'),
    h('h2', { class: 'headline small' }, 'Add a Gemini API key'),
    h(
      'p',
      { class: 'prose' },
      "Quizzes are written by Google's Gemini. A personal key is free from Google AI Studio and takes about a minute to create.",
    ),
    h(
      'ol',
      { class: 'steps prose' },
      h(
        'li',
        {},
        h(
          'a',
          { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener' },
          'Create a key in Google AI Studio',
        ),
        '.',
      ),
      h('li', {}, 'Paste it below.'),
    ),
    h(
      'form',
      { class: 'key-form', onsubmit: saveKey },
      h('input', {
        id: 'key-input',
        class: 'input',
        type: 'password',
        placeholder: 'Gemini API key',
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-label': 'Gemini API key',
        value: state.keyDraft,
        oninput: (e) => {
          state.keyDraft = e.target.value;
        },
      }),
      h(
        'button',
        { class: 'btn primary', type: 'submit', disabled: state.keyBusy },
        state.keyBusy ? 'Checking' : 'Save',
      ),
    ),
    state.keyError ? h('p', { class: 'error-text' }, state.keyError) : null,
    h(
      'p',
      { class: 'fine' },
      'Your key is stored only in this browser. Article text goes to Google only when you begin a quiz, submit a written answer, or select Explain more.',
    ),
  );
}

async function saveKey(event) {
  event.preventDefault();
  const apiKey = state.keyDraft.trim();
  if (!apiKey || state.keyBusy) return;
  state.keyBusy = true;
  state.keyError = '';
  render();
  try {
    const problem = await checkKey({ apiKey, model: state.settings.model });
    state.settings = await updateSettings({ apiKey });
    state.keyDraft = '';
    toast(problem ? `Key saved, but it could not be verified yet. ${problem.message}` : 'Key saved.');
  } catch (err) {
    state.keyError = err.message;
  } finally {
    state.keyBusy = false;
    render();
  }
}

// The quiz in progress, or the last one finished, so leaving either doesn't lose it.
function runCard() {
  const { run } = state;
  if (!run) return null;
  const questions = runQuestions(run);
  const { score, total } = scoreAnswers(questions, run.answers);
  const answered = questions.filter((q) => run.answers[q.id]?.verdict).length;
  const open = run.finished
    ? h('button', { class: 'btn small', type: 'button', onclick: () => go('results') }, 'View results')
    : h('button', { class: 'btn small primary', type: 'button', onclick: () => go('question') }, 'Resume');
  return h(
    'section',
    { class: 'section resume' },
    h(
      'div',
      { class: 'resume-text' },
      h('div', { class: 'kicker' }, run.finished ? 'Last results' : 'Quiz in progress'),
      h('div', { class: 'resume-title', dir: 'auto' }, run.quiz.title),
      h(
        'div',
        { class: 'meta' },
        run.finished ? `Score ${formatScore(score)} / ${total}` : `${answered} of ${total} answered`,
      ),
    ),
    h(
      'div',
      { class: 'row' },
      open,
      h(
        'button',
        { class: 'link-btn muted', type: 'button', onclick: closeRun },
        run.finished ? 'Dismiss' : 'Discard',
      ),
    ),
  );
}

function dueQuizzes() {
  return state.history.filter((entry) => entry.quiz?.questions?.length && reviewStatus(entry).due);
}

function reviewCard(saved) {
  const due = dueQuizzes();
  const listed = due.filter((entry) => entry !== saved);
  if (!listed.length) {
    return state.history.length
      ? h(
          'section',
          { class: 'section' },
          h(
            'div',
            {},
            h('button', { class: 'link-btn', type: 'button', onclick: () => go('history') }, 'Quiz history'),
          ),
        )
      : null;
  }
  return h(
    'section',
    { class: 'section' },
    h('div', { class: 'kicker' }, 'Due for review'),
    reviewButton(due),
    h(
      'div',
      {},
      listed
        .slice(0, 3)
        .map((entry) =>
          h(
            'div',
            { class: 'mini-item' },
            h('div', { class: 'mini-title', dir: 'auto' }, entry.title),
            h('button', { class: 'link-btn', type: 'button', onclick: () => retake(entry) }, 'Retake'),
          ),
        ),
    ),
    h(
      'div',
      {},
      h(
        'button',
        { class: 'link-btn muted', type: 'button', onclick: () => go('history') },
        listed.length > 3 ? `All ${listed.length} due quizzes` : 'Quiz history',
      ),
    ),
  );
}

function reviewButton(due) {
  const session = buildReviewSession(due);
  const size = session.questions.length;
  const articles = new Set(session.questions.map((q) => q.source.url)).size;
  return h(
    'div',
    { class: 'review-start' },
    h(
      'button',
      { class: 'btn block', type: 'button', onclick: () => startReview(session) },
      'Start review session',
      icon('arrowRight', 14),
    ),
    h(
      'div',
      { class: 'meta' },
      `${size} saved questions from ${articles} ${articles === 1 ? 'article' : 'articles'}, mixed together.`,
    ),
  );
}

function startReview(quiz) {
  beginRun(
    quiz,
    quiz.questions.map((_, i) => i),
    'review',
  );
}

async function startQuiz(avoid = []) {
  const { article } = state.page;
  const { settings } = state;
  if (!article || tooShort() || !settings.apiKey) {
    go('home');
    return;
  }
  cancelQuiz();
  const controller = new AbortController();
  const isSelection = state.useSelection;
  const pdf = quizPdf();
  const text = pdf ? '' : quizText();
  const options = {
    count: effectiveCount(),
    style: settings.style,
    difficulty: settings.difficulty,
  };
  state.shortSelection = false;
  state.gen = {
    controller,
    startedAt: Date.now(),
    words: quizWords(),
    title: article.title,
    note: NOTES[Math.floor(Math.random() * NOTES.length)],
    avoid,
    error: null,
  };
  go('generating');
  try {
    if (pdf && state.pdf?.url !== article.url) state.pdf = { url: article.url, data: await readPdf(tabId) };
    if (state.gen?.controller !== controller) return;
    const quiz = await generateQuiz({
      article,
      text,
      pdfData: pdf ? state.pdf.data : undefined,
      isSelection,
      options,
      settings,
      avoid,
      signal: controller.signal,
    });
    if (state.gen?.controller !== controller) return;
    state.gen = null;
    clearArticleHighlight(tabId);
    saveQuiz(quiz).catch((err) => console.error('Could not save quiz', err));
    beginRun(
      quiz,
      quiz.questions.map((_, i) => i),
      'full',
    );
    if (quiz.fallbackReason) {
      const why = quiz.fallbackReason === 'bad_model' ? "isn't available" : 'was busy';
      toast(`${modelLabel(settings.model)} ${why}, so ${modelLabel(quiz.model)} wrote this quiz.`);
    }
  } catch (err) {
    if (state.gen?.controller !== controller) return;
    state.pdf = null;
    state.gen.error = err;
    render();
  }
}

function viewGenerating() {
  const { gen } = state;
  if (gen.error) {
    const fixInSettings = ['no_key', 'bad_key', 'bad_model'].includes(gen.error.code);
    return h(
      'section',
      { class: 'section' },
      h('div', { class: 'kicker' }, 'Error'),
      h('h2', { class: 'headline small' }, 'The quiz could not be created'),
      h('p', { class: 'prose' }, gen.error.message),
      gen.error.detail ? h('p', { class: 'meta' }, gen.error.detail) : null,
      h(
        'div',
        { class: 'row' },
        fixInSettings
          ? h(
              'button',
              {
                class: 'btn primary',
                type: 'button',
                onclick: () => chrome.runtime.openOptionsPage(),
                'data-autofocus': true,
              },
              'Open settings',
            )
          : h(
              'button',
              {
                class: 'btn primary',
                type: 'button',
                onclick: () => startQuiz(gen.avoid),
                'data-autofocus': true,
              },
              'Try again',
            ),
        h('button', { class: 'btn', type: 'button', onclick: () => go('home') }, 'Back'),
      ),
    );
  }
  return h(
    'section',
    { class: 'section', 'aria-busy': 'true' },
    h('div', { class: 'kicker' }, 'Preparing your quiz'),
    h(
      'h2',
      { class: 'headline small', dir: 'auto' },
      gen.title || (gen.words === null ? 'Untitled PDF' : 'Untitled page'),
    ),
    h('div', { class: 'loader', 'aria-hidden': 'true' }),
    h(
      'p',
      { class: 'meta' },
      gen.words === null ? 'Reading the PDF' : `Reading ${formatNumber(gen.words)} words`,
      ' · ',
      h('span', { id: 'elapsed' }, elapsedText()),
    ),
    h('p', { class: 'note' }, gen.note),
    h('div', {}, h('button', { class: 'btn', type: 'button', onclick: () => go('home') }, 'Cancel')),
  );
}

function cancelQuiz() {
  state.gen?.controller.abort();
  state.gen = null;
}

function elapsedText() {
  return state.gen ? `${Math.floor((Date.now() - state.gen.startedAt) / 1000)}s` : '';
}

function tickElapsed() {
  const el = document.getElementById('elapsed');
  if (el) el.textContent = elapsedText();
}

function beginRun(quiz, order, kind) {
  state.run = { quiz, order, pos: 0, answers: {}, kind, finished: false, saved: false };
  state.draft = '';
  persistRun();
  go('question');
}

function currentQuestion() {
  const { run } = state;
  return run ? run.quiz.questions[run.order[run.pos]] : null;
}

function runQuestions(run) {
  return run.order.map((i) => run.quiz.questions[i]);
}

function viewQuestion() {
  const { run } = state;
  const q = currentQuestion();
  const answer = run.answers[q.id];
  const done = Boolean(answer?.verdict);
  const total = run.order.length;
  const completed = run.pos + (done ? 1 : 0);
  return h(
    'section',
    { class: 'section quiz' },
    h(
      'div',
      { class: 'quiz-head' },
      h(
        'div',
        { class: 'quiz-meta' },
        h(
          'span',
          { class: 'kicker' },
          `Question ${run.pos + 1} of ${total}`,
          { missed: ' · Retake', review: ' · Review' }[run.kind] ?? '',
        ),
        h(
          'button',
          {
            class: 'link-btn muted',
            type: 'button',
            title: 'Exit quiz',
            'aria-label': 'Exit quiz',
            onclick: () => go('home'),
          },
          'Exit',
        ),
      ),
      h(
        'div',
        {
          class: 'progress',
          role: 'progressbar',
          'aria-label': 'Quiz progress',
          'aria-valuemin': '0',
          'aria-valuemax': String(total),
          'aria-valuenow': String(completed),
        },
        h('div', { class: 'progress-bar', style: { width: `${(completed / total) * 100}%` } }),
      ),
    ),
    h(
      'div',
      { class: 'question-card' },
      q.source ? h('p', { class: 'source-line' }, `From ${q.source.title}`) : null,
      q.concept ? h('div', { class: 'kicker', dir: 'auto' }, q.concept) : null,
      h('h2', { class: 'question', dir: 'auto' }, q.question),
      q.type === 'mc' ? choiceList(q, answer) : shortAnswer(q, answer),
    ),
    done ? feedback(q, answer) : null,
    done
      ? h(
          'div',
          { class: 'next-row' },
          h(
            'button',
            { class: 'btn primary block', type: 'button', onclick: next, 'data-autofocus': true },
            run.pos + 1 < total ? 'Next question' : 'View results',
            icon('arrowRight', 14),
          ),
        )
      : null,
  );
}

function choiceList(q, answer) {
  const answered = answer?.choice != null;
  return h(
    'div',
    { class: 'choices', role: 'group', 'aria-label': 'Answer choices' },
    q.options.map((option, i) => {
      const isCorrect = i === q.correctIndex;
      const status = !answered ? '' : isCorrect ? 'correct' : i === answer.choice ? 'wrong' : 'dim';
      return h(
        'button',
        { class: `choice ${status}`, type: 'button', disabled: answered, onclick: () => choose(q, i) },
        h('span', { class: 'choice-key', 'aria-hidden': 'true' }, String.fromCharCode(65 + i)),
        h('span', { class: 'choice-text', dir: 'auto' }, option),
        answered && (isCorrect || i === answer.choice) ? icon(isCorrect ? 'check' : 'close', 18) : null,
      );
    }),
  );
}

function choose(q, index) {
  const { run } = state;
  if (run.answers[q.id]?.verdict) return;
  run.answers[q.id] = { choice: index, verdict: index === q.correctIndex ? 'correct' : 'incorrect' };
  persistRun();
  render();
}

function shortAnswer(q, answer) {
  if (answer?.verdict) {
    return h(
      'div',
      { class: 'your-answer' },
      h('div', { class: 'label' }, 'Your answer'),
      h('p', { class: 'prose', dir: 'auto' }, answer.text || 'No answer given.'),
    );
  }
  const grading = Boolean(answer?.grading);
  return h(
    'form',
    {
      class: 'short-form',
      onsubmit: (e) => {
        e.preventDefault();
        submitShort(q);
      },
    },
    h('textarea', {
      id: 'answer',
      rows: '4',
      dir: 'auto',
      placeholder: 'Write your answer in a few sentences.',
      'aria-label': 'Your answer',
      value: state.draft,
      disabled: grading,
      'data-autofocus': true,
      oninput: (e) => {
        state.draft = e.target.value;
      },
      onkeydown: (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submitShort(q);
        }
      },
    }),
    answer?.error ? selfGrade(q, answer) : null,
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        { class: 'btn primary', type: 'submit', disabled: grading },
        grading ? 'Checking' : answer?.error ? 'Check again' : 'Check answer',
      ),
      answer?.error
        ? null
        : h(
            'button',
            { class: 'btn', type: 'button', disabled: grading, onclick: () => giveUp(q) },
            'Show answer',
          ),
    ),
    grading || answer?.error ? null : h('p', { class: 'hint' }, `${isMac ? '⌘' : 'Ctrl'} + Enter to submit`),
  );
}

// If Gemini can't grade (offline, rate limited), let the reader compare and grade themselves.
function selfGrade(q, answer) {
  return h(
    'div',
    { class: 'self-grade' },
    h('p', { class: 'error-text' }, `Your answer could not be checked automatically. ${answer.error}`),
    h('div', { class: 'label' }, 'Model answer'),
    h('p', { class: 'prose', dir: 'auto' }, q.answer),
    h('div', { class: 'label' }, 'Compare it with yours and grade it'),
    h(
      'div',
      { class: 'row' },
      Object.entries(VERDICTS).map(([verdict, { label }]) =>
        h('button', { class: 'btn small', type: 'button', onclick: () => markSelf(q, verdict) }, label),
      ),
    ),
  );
}

async function submitShort(q) {
  const { run } = state;
  const text = state.draft.trim();
  if (run.answers[q.id]?.grading) return;
  if (!text) {
    toast('Write an answer first, or select Show answer.');
    return;
  }
  run.answers[q.id] = { text, grading: true };
  // Saved now, so closing the panel while Gemini grades doesn't lose the answer.
  persistRun();
  render();
  let result;
  try {
    result = { text, ...(await gradeShortAnswer({ question: q, answer: text, settings: state.settings })) };
  } catch (err) {
    result = { text, error: err.message };
  }
  run.answers[q.id] = result;
  if (state.run !== run) return;
  if (result.verdict) state.draft = '';
  persistRun();
  render();
}

function giveUp(q) {
  state.run.answers[q.id] = { text: state.draft.trim(), verdict: 'incorrect', gaveUp: true };
  state.draft = '';
  persistRun();
  render();
}

function markSelf(q, verdict) {
  const previous = state.run.answers[q.id];
  state.run.answers[q.id] = { text: previous?.text ?? state.draft.trim(), verdict, selfGraded: true };
  state.draft = '';
  persistRun();
  render();
}

function feedback(q, answer) {
  const label = answer.gaveUp
    ? 'Answer revealed'
    : answer.selfGraded
      ? `Self-assessed: ${VERDICTS[answer.verdict].label}`
      : VERDICTS[answer.verdict].label;
  return h(
    'div',
    { class: `feedback ${answer.verdict}`, 'aria-live': 'polite' },
    h('div', { class: 'feedback-head' }, icon(VERDICTS[answer.verdict].icon, 14), label),
    q.type === 'mc' && q.explanation ? h('p', { class: 'prose', dir: 'auto' }, q.explanation) : null,
    q.type === 'short' && answer.feedback ? h('p', { class: 'prose', dir: 'auto' }, answer.feedback) : null,
    q.type === 'short'
      ? h(
          'div',
          { class: 'model-answer' },
          h('div', { class: 'label' }, 'Model answer'),
          h('p', { class: 'prose', dir: 'auto' }, q.answer),
        )
      : null,
    answerSources(q, answer),
  );
}

// The quoted passage behind an answer, with "Show in article" and "Explain more".
function answerSources(q, answer) {
  const more = answer?.more;
  const canHighlight = q.quote && questionOnPage(q) && !state.page.article.isPdf;
  return h(
    'div',
    { class: 'sources' },
    q.quote ? h('blockquote', { class: 'quote', dir: 'auto' }, q.quote) : null,
    h(
      'div',
      { class: 'tools' },
      canHighlight
        ? h(
            'button',
            {
              class: 'link-btn',
              type: 'button',
              'data-key': `show:${q.id}`,
              onclick: () => showInArticle(q.quote),
            },
            'Show in article',
          )
        : null,
      // Shares its key with the explanation that replaces it, so focus moves there.
      more?.text
        ? null
        : h(
            'button',
            {
              class: 'link-btn',
              type: 'button',
              'aria-disabled': more?.loading ? 'true' : null,
              'data-key': `more:${q.id}`,
              onclick: () => explain(q),
            },
            more?.loading ? 'Explaining…' : 'Explain more',
          ),
    ),
    more?.error ? h('p', { class: 'error-text' }, more.error) : null,
    more?.text
      ? h(
          'div',
          { class: 'more', tabindex: '-1', 'data-key': `more:${q.id}` },
          h('div', { class: 'label' }, 'More on this'),
          more.text
            .split(/\n\s*\n/)
            .map((paragraph) => h('p', { class: 'prose', dir: 'auto' }, paragraph.trim())),
        )
      : null,
  );
}

// Only calls Gemini when asked, and keeps the result with the quiz.
async function explain(q) {
  const { run } = state;
  const answer = run.answers[q.id];
  if (!answer || answer.more?.loading) return;
  answer.more = { loading: true };
  render();
  try {
    answer.more = {
      text: await explainMore({ question: q, answer, articleText: sourceText(q), settings: state.settings }),
    };
  } catch (err) {
    answer.more = { error: err.message };
  }
  if (state.run !== run) return;
  persistRun();
  render();
}

// The text the question's quiz was written from, if its article is open in the tab.
function sourceText(q) {
  if (!questionOnPage(q)) return '';
  const { article } = state.page;
  return (state.run.quiz.scope === 'selection' && article.selection) || article.text || '';
}

async function showInArticle(quote) {
  try {
    const result = await highlightInArticle(tabId, quote);
    if (!result.found) toast('That passage could not be found on the page.');
    else if (result.partial) toast('Showing the closest match on the page.');
  } catch {
    toast('The article is no longer reachable. Click the Article Quizzer icon on its tab, then try again.');
  }
}

function next() {
  const { run } = state;
  if (run.pos + 1 < run.order.length) {
    run.pos += 1;
    state.draft = '';
    persistRun();
    render();
    return;
  }
  run.finished = true;
  if (run.kind !== 'missed' && !run.saved) {
    run.saved = true;
    recordAttempts(scoresByArticle(run)).catch((err) => console.error('Could not record attempt', err));
  }
  persistRun();
  go('results');
}

function scoresByArticle(run) {
  const questions = runQuestions(run);
  if (run.kind !== 'review') {
    return [{ url: run.quiz.url, title: run.quiz.title, ...scoreAnswers(questions, run.answers) }];
  }
  const groups = new Map();
  for (const q of questions) groups.set(q.source.url, [...(groups.get(q.source.url) ?? []), q]);
  return [...groups].map(([url, group]) => ({
    url,
    title: group[0].source.title,
    ...scoreAnswers(group, run.answers),
  }));
}

function onKeyDown(event) {
  if (state.view !== 'question' || event.metaKey || event.ctrlKey || event.altKey) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName)) return;
  const q = currentQuestion();
  if (q?.type !== 'mc' || state.run.answers[q.id]?.verdict) return;
  const key = event.key.toLowerCase();
  if (Object.hasOwn(CHOICE_KEYS, key) && CHOICE_KEYS[key] < q.options.length) {
    event.preventDefault();
    choose(q, CHOICE_KEYS[key]);
  }
}

function persistRun() {
  if (!tabId) return;
  const op = state.run
    ? chrome.storage.session.set({ [RUN_KEY]: state.run })
    : chrome.storage.session.remove(RUN_KEY);
  op.catch((err) => console.warn('Could not save quiz progress', err));
}

function viewResults() {
  const { run } = state;
  const questions = runQuestions(run);
  const { score, total } = scoreAnswers(questions, run.answers);
  const pct = total ? Math.round((score / total) * 100) : 0;
  const missed = questions.filter((q) => (POINTS[run.answers[q.id]?.verdict] ?? 0) < 1);
  const actions = [
    missed.length ? [`Retake ${missed.length} missed`, () => retryMissed(missed)] : null,
    onQuizPage() && state.settings.apiKey
      ? ['New questions', () => startQuiz(run.quiz.questions.map((q) => q.question))]
      : null,
    ['Done', closeRun],
  ].filter(Boolean);
  const [primary, ...secondary] = actions.map(([label, onclick], i) =>
    h(
      'button',
      {
        class: i === 0 ? 'btn primary block' : 'btn',
        type: 'button',
        onclick,
        'data-key': label,
        'data-autofocus': i === 0,
      },
      label,
    ),
  );
  return [
    h(
      'section',
      { class: 'section' },
      h(
        'div',
        { class: 'kicker' },
        { missed: 'Retake results', review: 'Review session' }[run.kind] ?? 'Results',
      ),
      h(
        'div',
        { class: 'score' },
        h('span', { class: 'score-num' }, formatScore(score)),
        h('span', { class: 'score-of' }, ` / ${total}`),
      ),
      h('div', { class: 'label' }, `${pct}% correct`),
      h('p', { class: 'result-message' }, resultMessage(pct, run.kind)),
      run.kind === 'missed' ? null : statsStrip(),
      h(
        'div',
        { class: 'result-actions' },
        primary,
        secondary.length ? h('div', { class: 'row' }, secondary) : null,
      ),
    ),
    run.kind === 'review' ? articleScores(run) : null,
    summary(run.quiz),
    h(
      'section',
      { class: 'section review' },
      h('div', { class: 'kicker' }, 'Answer review'),
      questions.map((q) => reviewItem(q, run.answers[q.id])),
    ),
  ];
}

function articleScores(run) {
  return h(
    'section',
    { class: 'section' },
    h('div', { class: 'kicker' }, 'By article'),
    h(
      'div',
      {},
      scoresByArticle(run).map(({ title, score, total }) =>
        h(
          'div',
          { class: 'mini-item' },
          h('div', { class: 'mini-title', dir: 'auto' }, title),
          h('div', { class: 'meta' }, `${formatScore(score)} / ${total}`),
        ),
      ),
    ),
  );
}

function resultMessage(pct, kind) {
  if (kind === 'missed') {
    return pct === 100
      ? 'You answered every previously missed question correctly.'
      : 'Some questions still need work. The quoted passages below cover them.';
  }
  const articles = kind === 'review' ? 'these articles' : 'this article';
  if (pct >= 90) return `Excellent. You have a firm grasp of ${articles}.`;
  if (pct >= 70) return 'A strong result. Review the questions you missed below.';
  if (pct >= 50) return 'A fair result. The quoted passages below cover what you missed.';
  return `Consider rereading ${articles}, then retake the questions you missed.`;
}

function summary(quiz) {
  if (!quiz.summary && !quiz.keyTakeaways?.length) return null;
  return h(
    'section',
    { class: 'section' },
    quiz.summary
      ? [h('div', { class: 'kicker' }, 'Summary'), h('p', { class: 'prose', dir: 'auto' }, quiz.summary)]
      : null,
    quiz.keyTakeaways?.length
      ? [
          h('div', { class: 'kicker' }, 'Key takeaways'),
          h(
            'ol',
            { class: 'takeaways prose', dir: 'auto' },
            quiz.keyTakeaways.map((t) => h('li', {}, t)),
          ),
        ]
      : null,
  );
}

function reviewItem(q, answer) {
  const verdict = answer?.verdict ?? 'incorrect';
  const line = (label, text, cls = 'prose') =>
    h('div', {}, h('span', { class: 'label' }, label), h('p', { class: cls, dir: 'auto' }, text));
  const details =
    q.type === 'mc'
      ? [
          answer?.choice != null && answer.choice !== q.correctIndex
            ? line('Your answer', q.options[answer.choice])
            : null,
          line('Correct answer', q.options[q.correctIndex]),
          q.explanation ? h('p', { class: 'prose', dir: 'auto' }, q.explanation) : null,
        ]
      : [
          answer?.text ? line('Your answer', answer.text) : null,
          line('Model answer', q.answer),
          answer?.feedback ? h('p', { class: 'prose', dir: 'auto' }, answer.feedback) : null,
        ];
  return h(
    'details',
    { class: 'review-item', open: verdict !== 'correct' || Boolean(answer?.more) },
    h(
      'summary',
      {},
      h(
        'span',
        { class: `mark ${verdict}`, title: VERDICTS[verdict].label },
        icon(VERDICTS[verdict].icon, 11),
      ),
      h('span', { dir: 'auto' }, q.question),
    ),
    h('div', { class: 'review-body' }, details, answerSources(q, answer)),
  );
}

function retryMissed(missed) {
  const { quiz } = state.run;
  const ids = new Set(missed.map((q) => q.id));
  const reshuffled = {
    ...quiz,
    questions: quiz.questions.map((q) => (ids.has(q.id) ? reshuffleQuestion(q) : q)),
  };
  beginRun(
    reshuffled,
    reshuffled.questions.flatMap((q, i) => (ids.has(q.id) ? [i] : [])),
    'missed',
  );
}

function closeRun() {
  state.run = null;
  state.pdf = null;
  persistRun();
  if (state.page.article) clearArticleHighlight(tabId);
  go('home');
}

function viewHistory() {
  const entries = state.history.filter((e) => e.quiz?.questions?.length).sort(byReviewPriority);
  return h(
    'section',
    { class: 'section history-list' },
    h(
      'div',
      { class: 'view-head' },
      h('h2', { class: 'view-title' }, 'Quiz history'),
      h('button', { class: 'link-btn muted', type: 'button', onclick: () => go('home') }, 'Back'),
    ),
    statsStrip(),
    dueQuizzes().length ? reviewButton(dueQuizzes()) : null,
    entries.length
      ? entries.map(historyItem)
      : h('p', { class: 'prose' }, 'Completed quizzes appear here, along with when each is due for review.'),
  );
}

function statsStrip() {
  const stats = quizStats(state.history);
  if (!stats) return null;
  const stat = (value, label) =>
    h(
      'div',
      { class: 'stat' },
      h('div', { class: 'stat-value' }, value),
      h('div', { class: 'label' }, label),
    );
  return h(
    'div',
    { class: 'stats' },
    stat(String(stats.streak), 'Day streak'),
    stat(`${stats.average}%`, 'Average score'),
    stat(String(stats.thisMonth), 'Articles this month'),
  );
}

function byReviewPriority(a, b) {
  const dueA = reviewStatus(a).due;
  const dueB = reviewStatus(b).due;
  if (dueA !== dueB) return dueA ? -1 : 1;
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}

function historyItem(entry) {
  const status = reviewStatus(entry);
  const last = entry.attempts?.at(-1);
  const facts = last
    ? [`Last score ${percent(last)}%`, capitalize(relativeTime(last.at))]
    : ['Incomplete', capitalize(relativeTime(entry.updatedAt))];
  if (!status.due && status.nextAt) facts.push(`Next review ${relativeTime(status.nextAt)}`);
  return h(
    'article',
    { class: 'history-item' },
    h('div', { class: 'kicker' }, entry.siteName || hostname(entry.url)),
    h(
      'a',
      {
        class: 'history-title',
        dir: 'auto',
        href: /^https?:/i.test(entry.url) ? entry.url : null,
        target: '_blank',
        rel: 'noopener',
      },
      entry.title,
    ),
    h('div', { class: 'meta' }, facts.join(' · ')),
    status.due ? h('div', { class: 'kicker due' }, 'Due for review') : null,
    h(
      'div',
      { class: 'history-actions' },
      h('button', { class: 'link-btn', type: 'button', onclick: () => retake(entry) }, 'Retake'),
      h(
        'button',
        {
          class: 'link-btn muted',
          type: 'button',
          'aria-label': `Remove the quiz for ${entry.title}`,
          onclick: () => deleteHistoryEntry(entry.key),
        },
        'Remove',
      ),
    ),
  );
}

function retake(entry) {
  const quiz = {
    ...entry.quiz,
    url: entry.url,
    title: entry.title,
    siteName: entry.siteName,
    questions: entry.quiz.questions.map((q) => reshuffleQuestion(q)),
  };
  beginRun(
    quiz,
    quiz.questions.map((_, i) => i),
    'full',
  );
}

function onStorageChanged(changes, area) {
  // Removing a used intent also lands here, with no new value.
  if (area === 'session' && changes[INTENT_KEY]?.newValue) takeIntent(changes[INTENT_KEY].newValue);
  if (area !== 'local') return;
  if (changes.settings) {
    state.settings = withDefaults(changes.settings.newValue);
    if (state.view === 'home') render();
  }
  if (changes.history) {
    state.history = changes.history.newValue ?? [];
    if (['home', 'history', 'results'].includes(state.view)) render();
  }
}

let toastTimer;
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  // Long enough to read the longer notes.
  toastTimer = setTimeout(() => el.classList.remove('show'), Math.max(3500, message.length * 50));
}

const numberFormat = new Intl.NumberFormat();
const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function formatNumber(n) {
  return numberFormat.format(n ?? 0);
}

function formatScore(score) {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

function readMinutes(words) {
  return Math.max(1, Math.round((words ?? 0) / 230));
}

function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function percent(attempt) {
  return Math.round((attempt.score / attempt.total) * 100);
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function relativeTime(timestamp) {
  const minutes = Math.round((timestamp - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return relativeFormat.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeFormat.format(hours, 'hour');
  // Calendar days, so "yesterday" means the previous date, however many hours ago.
  const days = calendarDay(timestamp) - calendarDay(Date.now());
  if (Math.abs(days) < 30) return relativeFormat.format(days, 'day');
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function calendarDay(timestamp) {
  const d = new Date(timestamp);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
}
