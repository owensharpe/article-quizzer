const DAY = 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 100;
// Days until the next review after 1, 2, 3... strong attempts (80%+) in a row, each made when due.
const REVIEW_INTERVALS = [3, 7, 16, 35, 90];
const TRACKING_PARAM = /^(utm_|mc_|fbclid$|gclid$|ref$|ref_src$|cmpid$)/i;

export const MODELS = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', note: 'Recommended. Highest-quality questions.' },
  {
    id: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash-Lite',
    note: 'Fastest, with higher free-tier limits.',
  },
  { id: 'gemini-flash-latest', label: 'Gemini Flash (latest)', note: 'Always uses the newest Flash model.' },
];

// "models/gemini-x" and "gemini-x" name the same model.
export function cleanModelId(model) {
  return String(model ?? '')
    .trim()
    .replace(/^models\//, '');
}

// When the chosen model is overloaded or no longer available, requests retry on this one.
export function fallbackModel(model) {
  return cleanModelId(model) === MODELS[1].id ? MODELS[0].id : MODELS[1].id;
}

export function modelLabel(id) {
  return MODELS.find((m) => m.id === id)?.label ?? id;
}

export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: MODELS[0].id,
  count: 8,
  style: 'mixed',
  difficulty: 'understanding',
};

export function withDefaults(settings) {
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return withDefaults(settings);
}

// Stores only what the reader chose, so a changed default (say, a newer model)
// still reaches them.
export async function updateSettings(patch) {
  const { settings } = await chrome.storage.local.get('settings');
  const next = { ...settings, ...patch };
  await chrome.storage.local.set({ settings: next });
  return withDefaults(next);
}

export async function getHistory() {
  const { history } = await chrome.storage.local.get('history');
  return Array.isArray(history) ? history : [];
}

// One entry per article. A new quiz replaces the questions but keeps past
// attempts, so the review schedule carries over.
export async function saveQuiz(quiz) {
  const history = await getHistory();
  const key = normalizeUrl(quiz.url);
  const existing = history.find((e) => e.key === key);
  const entry = {
    key,
    url: quiz.url,
    title: quiz.title,
    siteName: quiz.siteName,
    quiz: { id: quiz.id, summary: quiz.summary, keyTakeaways: quiz.keyTakeaways, questions: quiz.questions },
    attempts: existing?.attempts ?? [],
    updatedAt: Date.now(),
  };
  const next = [entry, ...history.filter((e) => e.key !== key)].slice(0, HISTORY_LIMIT);
  await chrome.storage.local.set({ history: next });
}

// results: [{ url, score, total }], one per article, saved in a single write.
export async function recordAttempts(results) {
  const history = await getHistory();
  const now = Date.now();
  const touched = [];
  for (const { url, score, total } of results) {
    const entry = history.find((e) => e.key === normalizeUrl(url));
    if (!entry) continue;
    entry.attempts = [...entry.attempts, { at: now, score, total }].slice(-20);
    entry.updatedAt = now;
    touched.push(entry);
  }
  if (!touched.length) return;
  await chrome.storage.local.set({ history: [...touched, ...history.filter((e) => !touched.includes(e))] });
}

export async function deleteHistoryEntry(key) {
  const history = await getHistory();
  await chrome.storage.local.set({ history: history.filter((e) => e.key !== key) });
}

export async function clearHistory() {
  await chrome.storage.local.set({ history: [] });
}

// Replays the attempts in order. A weak one starts the schedule over from
// tomorrow. A strong one pushes the next review further out, but only if the
// review was due, so retaking a quiz early doesn't skip reviews.
export function reviewStatus(entry, now = Date.now()) {
  let level = 0;
  let nextAt = null;
  for (const { at, score, total } of entry?.attempts ?? []) {
    if (!(total > 0 && score / total >= 0.8)) {
      level = 0;
      nextAt = at + DAY;
    } else if (nextAt === null || at >= nextAt) {
      level++;
      nextAt = at + REVIEW_INTERVALS[Math.min(level, REVIEW_INTERVALS.length) - 1] * DAY;
    }
  }
  return { due: nextAt !== null && now >= nextAt, nextAt };
}

// Streak, average score, and articles quizzed this month, from finished quizzes.
// Returns null until there is at least one.
export function quizStats(history, now = Date.now()) {
  const attempts = history.flatMap((entry) =>
    (entry.attempts ?? []).filter((a) => a.total > 0).map((a) => ({ ...a, key: entry.key })),
  );
  if (!attempts.length) return null;

  // Weighted by questions, so a 3-question review counts less than a 12-question quiz.
  const score = attempts.reduce((sum, a) => sum + a.score, 0);
  const total = attempts.reduce((sum, a) => sum + a.total, 0);
  const month = monthOf(now);
  const thisMonth = new Set(attempts.filter((a) => monthOf(a.at) === month).map((a) => a.key)).size;

  // A streak stays alive until the end of the day after the last quiz.
  const days = new Set(attempts.map((a) => dayOf(a.at)));
  let day = dayOf(now);
  if (!days.has(day)) day--;
  let streak = 0;
  while (days.has(day)) {
    streak++;
    day--;
  }
  return { streak, average: Math.round((score / total) * 100), thisMonth };
}

// Local calendar day and month, so streaks follow the reader's own midnight.
function dayOf(timestamp) {
  const d = new Date(timestamp);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY;
}

function monthOf(timestamp) {
  const d = new Date(timestamp);
  return d.getFullYear() * 12 + d.getMonth();
}

// Ignore anchors and tracking params so one article maps to one key. Hash routes
// ("#/post/7", "#!post/7") pick the page in single-page apps, so they stay. The
// query is filtered as written, since re-encoding it would change the key.
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    if (!/^#[/!]/.test(u.hash)) u.hash = '';
    u.search = u.search
      .slice(1)
      .split('&')
      .filter((part) => part && !TRACKING_PARAM.test(new URLSearchParams(part).keys().next().value))
      .join('&');
    return u.href;
  } catch {
    return String(url ?? '');
  }
}
