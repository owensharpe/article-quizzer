import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  reviewStatus,
  normalizeUrl,
  saveQuiz,
  recordAttempts,
  getHistory,
  getSettings,
  updateSettings,
  deleteHistoryEntry,
  quizStats,
  fallbackModel,
} from '../extension/lib/storage.js';

const DAY = 24 * 60 * 60 * 1000;

// In-memory stand-in for chrome.storage.local.
beforeEach(() => {
  const data = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
        set: async (items) => Object.assign(data, structuredClone(items)),
      },
    },
  };
});

function quiz(url, id = 'quiz-1') {
  return {
    id,
    url,
    title: 'T',
    siteName: 'S',
    summary: '',
    keyTakeaways: [],
    questions: [{ id: 'q1', type: 'mc', question: 'Q?', options: ['a', 'b'], correctIndex: 0 }],
  };
}

test('reviewStatus: nothing is due before the first attempt', () => {
  assert.deepEqual(reviewStatus({ attempts: [] }), { due: false, nextAt: null });
});

test('reviewStatus: a weak attempt comes back the next day', () => {
  const at = Date.UTC(2026, 0, 1);
  const entry = { attempts: [{ at, score: 3, total: 8 }] };
  assert.equal(reviewStatus(entry, at + DAY - 1).due, false);
  assert.equal(reviewStatus(entry, at + DAY).due, true);
});

test('reviewStatus: strong attempts made when due space reviews further apart', () => {
  const attempts = [];
  const intervals = [];
  let at = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 6; i++) {
    attempts.push({ at, score: 8, total: 8 });
    const { nextAt } = reviewStatus({ attempts });
    intervals.push((nextAt - at) / DAY);
    at = nextAt;
  }
  assert.deepEqual(intervals, [3, 7, 16, 35, 90, 90]);
});

test('reviewStatus: retaking a quiz before it is due does not push the review out', () => {
  const at = Date.UTC(2026, 0, 1);
  const hour = 60 * 60 * 1000;
  const first = { at, score: 8, total: 8 };
  const sameDay = { at: at + hour, score: 8, total: 8 };
  assert.equal(reviewStatus({ attempts: [first, sameDay] }).nextAt, at + 3 * DAY);
  assert.equal(reviewStatus({ attempts: [first, sameDay] }, at + 3 * DAY).due, true);

  const onTime = { at: at + 3 * DAY, score: 8, total: 8 };
  assert.equal(reviewStatus({ attempts: [first, sameDay, onTime] }).nextAt, onTime.at + 7 * DAY);

  const weakRetake = { at: at + 2 * hour, score: 2, total: 8 };
  assert.equal(reviewStatus({ attempts: [first, weakRetake] }).nextAt, weakRetake.at + DAY);
});

test('reviewStatus: a weak attempt starts the schedule over', () => {
  const at = Date.UTC(2026, 0, 1);
  const attempts = [
    { at: at - 9 * DAY, score: 8, total: 8 },
    { at: at - 2 * DAY, score: 8, total: 8 },
    { at, score: 4, total: 8 },
  ];
  assert.equal((reviewStatus({ attempts }).nextAt - at) / DAY, 1);
  attempts.push({ at: at + DAY, score: 8, total: 8 });
  assert.equal((reviewStatus({ attempts }).nextAt - at) / DAY, 4, 'back to the first interval');
});

test('normalizeUrl drops anchors and tracking params', () => {
  assert.equal(
    normalizeUrl('https://site.com/post?id=7&utm_source=x&utm_medium=y&fbclid=abc#section-2'),
    'https://site.com/post?id=7',
  );
  assert.equal(normalizeUrl('not a url'), 'not a url');
});

test('normalizeUrl keeps hash routes and the query as written', () => {
  assert.equal(normalizeUrl('https://app.com/?utm_source=x#/posts/7'), 'https://app.com/#/posts/7');
  assert.equal(normalizeUrl('https://app.com/#!posts/7'), 'https://app.com/#!posts/7');
  const key = 'https://site.com/find?q=a%20b&tags=x,y';
  assert.equal(normalizeUrl(key), key);
  assert.equal(normalizeUrl('https://site.com/find?q=a%20b&utm%5Fsource=feed&tags=x,y&ref=home'), key);
});

test('fallbackModel recognizes ids with the models/ prefix', () => {
  assert.equal(fallbackModel('gemini-3.8-flash'), 'gemini-3.5-flash-lite');
  assert.equal(fallbackModel(' models/gemini-3.5-flash-lite'), 'gemini-3.8-flash');
});

test('settings fall back to defaults and merge updates', async () => {
  const defaults = await getSettings();
  assert.equal(defaults.apiKey, '');
  assert.equal(defaults.count, 8);
  await updateSettings({ count: 12 });
  const next = await getSettings();
  assert.equal(next.count, 12);
  assert.equal(next.model, defaults.model);
  const { settings: stored } = await chrome.storage.local.get('settings');
  assert.deepEqual(stored, { count: 12 }, 'defaults are not stored, so a new default model still applies');
});

test('saveQuiz keeps one entry per article and recordAttempts adds to it', async () => {
  await saveQuiz(quiz('https://site.com/a?utm_source=x'));
  await saveQuiz(quiz('https://site.com/b'));
  await recordAttempts([{ url: 'https://site.com/a#top', score: 5, total: 8 }]);
  await saveQuiz(quiz('https://site.com/a', 'quiz-2'));

  const history = await getHistory();
  assert.deepEqual(
    history.map((e) => e.key),
    ['https://site.com/a', 'https://site.com/b'],
  );
  assert.equal(history[0].quiz.id, 'quiz-2', 'a new quiz replaces the old questions');
  assert.deepEqual(
    history[0].attempts.map((a) => a.score),
    [5],
    'but keeps the attempt record',
  );

  await deleteHistoryEntry('https://site.com/b');
  assert.equal((await getHistory()).length, 1);
});

// Local noon on a given October 2026 day, so tests don't depend on the time zone.
const oct = (day, hour = 12) => new Date(2026, 9, day, hour).getTime();

test('quizStats is empty until a quiz is finished', () => {
  assert.equal(quizStats([]), null);
  assert.equal(quizStats([{ key: 'a', attempts: [] }]), null);
});

test('quizStats counts a streak through today or yesterday', () => {
  const history = [
    { key: 'a', attempts: [{ at: oct(7), score: 4, total: 5 }] },
    {
      key: 'b',
      attempts: [
        { at: oct(8, 9), score: 3, total: 5 },
        { at: oct(8, 21), score: 5, total: 5 },
      ],
    },
  ];
  assert.equal(quizStats(history, oct(8, 23)).streak, 2, 'Oct 7 and 8, checked late on the 8th');
  assert.equal(quizStats(history, oct(9)).streak, 2, 'still alive the next day');
  assert.equal(quizStats(history, oct(10)).streak, 0, 'broken after a day off');
});

test('quizStats averages over all questions answered and counts this month by article', () => {
  const history = [
    {
      key: 'a',
      attempts: [
        { at: new Date(2026, 8, 30).getTime(), score: 2, total: 4 },
        { at: oct(2), score: 4, total: 4 },
      ],
    },
    {
      key: 'b',
      attempts: [
        { at: oct(3), score: 1, total: 1 },
        { at: oct(4), score: 5, total: 11 },
      ],
    },
  ];
  const stats = quizStats(history, oct(9));
  assert.equal(stats.average, 60, '12 of 20 questions, not the mean of the four percentages');
  assert.equal(stats.thisMonth, 2);
});

test('recordAttempts records each article of a review session at once', async () => {
  await saveQuiz(quiz('https://site.com/a'));
  await saveQuiz(quiz('https://site.com/b'));
  await recordAttempts([
    { url: 'https://site.com/a', score: 2, total: 3 },
    { url: 'https://site.com/b', score: 3, total: 3 },
    { url: 'https://site.com/gone', score: 1, total: 1 },
  ]);
  const history = await getHistory();
  assert.deepEqual(
    history.map((e) => [e.key, e.attempts.map((a) => a.score)]),
    [
      ['https://site.com/a', [2]],
      ['https://site.com/b', [3]],
    ],
  );
});
