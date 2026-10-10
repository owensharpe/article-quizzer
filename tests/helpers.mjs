// Shared setup for the browser test (tests/e2e.mjs) and scripts/screenshots.mjs:
// loads the extension into Chrome for Testing and fakes the Gemini API.

import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GEMINI = 'https://generativelanguage.googleapis.com/';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, x-goog-api-key',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

// A quiz about tests/fixtures/article.html, with quotes that exercise the passage matcher.
export const QUIZ = {
  summary:
    'Octopus arms taste what they touch and make routine decisions locally, which frees the brain and inspires soft robotics.',
  keyTakeaways: [
    'Suckers carry chemical receptors, so touching doubles as tasting.',
    'About two thirds of an octopus’s neurons are in its arms.',
    'Arms filter what they touch before the brain gets involved.',
  ],
  questions: [
    {
      type: 'multiple_choice',
      concept: 'Taste by touch',
      question: 'How does an octopus identify food in a crevice it cannot see?',
      options: [
        'Its suckers taste what they touch',
        'It listens for movement',
        'It sees well in the dark',
        'It smells the water from far away',
      ],
      correctIndex: 0,
      answer: 'Its suckers taste what they touch',
      keyPoints: [],
      explanation: 'Each sucker has thousands of chemical receptors.',
      // Exact sentence. A hidden duplicate appears earlier on the page and must be skipped.
      quote:
        'Each sucker carries thousands of chemical receptors, which let an octopus taste whatever it touches.',
    },
    {
      type: 'multiple_choice',
      concept: 'Where the neurons are',
      question: 'Where are most of an octopus’s neurons?',
      options: ['In its head', 'In its arms', 'In its skin', 'Split evenly between head and arms'],
      correctIndex: 1,
      answer: 'In its arms',
      keyPoints: [],
      explanation:
        'Roughly two thirds of them sit in the arms, which is why the arms can make some decisions on their own.',
      // Straight apostrophe here, curly on the page.
      quote: "Roughly two thirds of an octopus's neurons sit in its arms rather than its head",
    },
    {
      type: 'multiple_choice',
      concept: 'Decoy experiment',
      question: 'What did the crab-decoy experiments show?',
      options: [
        'The arms released decoys before the eyes turned toward them',
        'Octopuses preferred the decoys',
        'The brain made every choice',
        'The arms could not tell real crabs from decoys',
      ],
      correctIndex: 0,
      answer: 'The arms released decoys before the eyes turned toward them',
      keyPoints: [],
      explanation: 'The arms filtered objects locally.',
      // The model changed the ending, so only a prefix matches.
      quote:
        'The arms consistently grabbed the real crabs and released the decoys within a fraction of a second, long before anything else happened.',
    },
    {
      type: 'multiple_choice',
      concept: 'Soft robots',
      question: 'Why are soft-robot engineers interested in octopuses?',
      options: [
        'Their robots also have no fixed joints',
        'Octopuses are cheap to study',
        'They want waterproof motors',
        'Octopus ink works as a lubricant',
      ],
      correctIndex: 0,
      answer: 'Their robots also have no fixed joints',
      keyPoints: [],
      explanation: 'Both have to control bodies without fixed joints.',
      quote: 'This sentence does not appear anywhere in the article.',
    },
    {
      type: 'short_answer',
      concept: 'Distributed control',
      question: 'Why might it help an octopus to let its arms make routine choices?',
      options: [],
      correctIndex: -1,
      answer:
        'Each arm can bend almost anywhere, so there are too many movements for the brain to plan. Local control handles routine choices and frees the brain to watch for predators.',
      keyPoints: ['Too many possible movements to plan centrally', 'Frees the brain to watch for predators'],
      explanation: '',
      quote: 'Letting each arm handle routine choices is a way of coping with that complexity.',
    },
  ],
};
export const GRADE = {
  verdict: 'partial',
  feedback:
    'You explained that the brain has less to do, but missed why: each arm can bend at almost any point.',
};

export const EXPLANATION =
  'Most of an octopus’s neurons are in its arms, not its head.\n\nThat is why the arms can filter what they touch before the brain is involved.';

export const geminiOk = (obj) => ({
  status: 200,
  json: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(obj) }] } }] },
});

// Returns swappable responders, a log of API calls, and a function that wires them into a page.
export function geminiMock() {
  const mock = {
    quiz: () => geminiOk(QUIZ),
    grade: () => geminiOk(GRADE),
    explain: () => geminiOk({ explanation: EXPLANATION }),
    model: () => ({ status: 200, json: { name: 'models/test' } }),
  };
  const apiCalls = [];
  async function intercept(page) {
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      if (!req.url().startsWith(GEMINI)) return req.continue();
      if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: CORS });
      const body = req.postData() ? JSON.parse(req.postData()) : null;
      apiCalls.push({ url: req.url(), method: req.method(), headers: req.headers(), body });
      // Tell requests apart by the shape of the answer they ask for.
      const fields = body?.generationConfig?.responseJsonSchema?.properties ?? {};
      let reply;
      if (req.method() === 'GET') reply = mock.model();
      else if ('verdict' in fields) reply = mock.grade(req.url());
      else if ('explanation' in fields) reply = mock.explain(req.url());
      else {
        await new Promise((r) => setTimeout(r, 400)); // long enough to see the loading screen
        reply = mock.quiz(req.url());
      }
      req.respond({
        status: reply.status,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify(reply.json),
      });
    });
  }
  return { mock, apiCalls, intercept };
}

// Starts a fixture server and Chrome with a test copy of the extension.
// `extra` maps file names to generated files ({ type, body }) the server should also serve.
export async function launch({ extra = {} } = {}) {
  // The real extension relies on activeTab, which needs a toolbar click that
  // automation can't perform, so the test copy also gets access to all pages.
  const extDir = await mkdtemp(path.join(tmpdir(), 'aq-ext-'));
  await cp(path.join(root, 'extension'), extDir, { recursive: true });
  const manifestPath = path.join(extDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions.push('<all_urls>');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const server = createServer(async (req, res) => {
    try {
      const name = path.basename(new URL(req.url, 'http://localhost').pathname);
      if (extra[name]) {
        res.writeHead(200, { 'content-type': extra[name].type });
        res.end(extra[name].body);
        return;
      }
      const body = await readFile(path.join(root, 'tests/fixtures', name));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const browser = await puppeteer.launch({ headless: true, enableExtensions: [extDir] });
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'),
  );
  const extId = new URL(swTarget.url()).host;
  const worker = await swTarget.worker();
  return {
    browser,
    worker,
    extId,
    extUrl: (file) => `chrome-extension://${extId}/${file}`,
    base: `http://127.0.0.1:${server.address().port}`,
    tabIdFor: (url) =>
      worker.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url),
    async close() {
      await browser.close();
      server.close();
      await rm(extDir, { recursive: true, force: true });
    },
  };
}

export async function waitForText(page, text, timeout = 10_000) {
  // Case-insensitive because some labels are uppercased with CSS, which innerText reflects.
  await page.waitForFunction(
    (t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()),
    { timeout },
    text,
  );
}

export async function clickText(page, text) {
  // A re-render can replace the element between finding it and clicking it; then look again.
  for (let attempt = 1; ; attempt++) {
    const handle = await page.waitForFunction(
      (t) =>
        [...document.querySelectorAll('button, a, summary')].find(
          (el) => el.textContent.trim().includes(t) && !el.disabled && el.offsetParent !== null,
        ),
      { timeout: 10_000 },
      text,
    );
    try {
      await handle.asElement().click();
      return;
    } catch (err) {
      if (attempt === 3 || !/detached/i.test(err.message)) throw err;
    }
  }
}

// Replaces a field's text the way a person would: select all of it, then type.
export async function fill(page, selector, text) {
  await page.$eval(selector, (el) => {
    el.focus();
    el.select();
  });
  await page.keyboard.type(text);
}

export async function newPage(browser, width, height, colorScheme) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  if (colorScheme) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: colorScheme }]);
  return page;
}
