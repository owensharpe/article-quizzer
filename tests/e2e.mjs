// End-to-end smoke test: loads the real extension into Chrome for Testing,
// reads a local article, and walks through a quiz with the Gemini API mocked.
//
//   npm run test:e2e                                        # headless
//   SHOTS_DIR=/tmp/shots COLOR_SCHEME=light npm run test:e2e  # also save screenshots

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { geminiMock, geminiOk, QUIZ, launch, waitForText, clickText, fill, newPage } from './helpers.mjs';

const shotsDir = process.env.SHOTS_DIR;
const colorScheme = process.env.COLOR_SCHEME; // light | dark
const { mock, apiCalls, intercept: interceptGemini } = geminiMock();

let passed = 0;
async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    console.log(`  ✗ ${name}`);
    throw err;
  }
}

async function shot(page, name) {
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${name}.png`), fullPage: true });
}

async function highlightedText(article, shotName) {
  const handle = await article.waitForFunction(
    () => {
      const highlight = CSS.highlights.get('article-quizzer');
      const range = highlight && [...highlight][0];
      return range
        ? { text: range.toString().replace(/\s+/g, ' '), visible: range.getBoundingClientRect().height > 0 }
        : null;
    },
    { timeout: 5000 },
  );
  const value = await handle.jsonValue();
  if (shotName) await shot(article, shotName);
  await article.evaluate(() => CSS.highlights.delete('article-quizzer'));
  return value;
}

async function main() {
  if (shotsDir) await mkdir(shotsDir, { recursive: true });
  const extra = {};
  const env = await launch({ extra });
  const { browser, worker, extId, extUrl, base, tabIdFor } = env;
  const open = (width, height) => newPage(browser, width, height, colorScheme);

  try {
    console.log(`Extension ${extId} loaded`);

    await step('opens the settings page on install', async () => {
      await browser.waitForTarget((t) => t.url() === extUrl('options.html'), { timeout: 5000 });
    });

    const article = await browser.newPage();
    await article.setViewport({ width: 1000, height: 800 });
    await article.goto(`${base}/article.html`);
    const tabId = await tabIdFor(`${base}/article.html`);

    await step('accepts a per-tab side panel path with the tab id', async () => {
      const options = await worker.evaluate(async (id) => {
        await chrome.sidePanel.setOptions({ tabId: id, path: `sidepanel.html?tabId=${id}`, enabled: true });
        return chrome.sidePanel.getOptions({ tabId: id });
      }, tabId);
      assert.equal(options.enabled, true);
      assert.match(options.path, new RegExp(`sidepanel\\.html\\?tabId=${tabId}$`));
    });

    const panel = await open(380, 760);
    await interceptGemini(panel);
    await panel.goto(extUrl(`sidepanel.html?tabId=${tabId}`));

    await step('reads the article and asks for a key on first run', async () => {
      await waitForText(panel, 'How Octopuses Taste the World');
      await waitForText(panel, 'Add a Gemini API key');
      const card = await panel.$eval('.page-card', (el) => el.innerText);
      assert.match(card, /THE TIDE POOL/i);
      assert.match(card, /\d+ words/);
      await shot(panel, '01-setup');
    });

    await step('saves a key from the panel unless Gemini rejects it', async () => {
      const { model } = mock;
      mock.model = () => ({
        status: 400,
        json: { error: { message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } },
      });
      await panel.type('#key-input', 'wrong-key');
      await clickText(panel, 'Save');
      await waitForText(panel, "That API key isn't valid");
      // A key that can't be checked right now is kept, with a note.
      mock.model = () => ({
        status: 503,
        json: { error: { code: 503, message: 'The model is overloaded.' } },
      });
      await fill(panel, '#key-input', 'test-key-123');
      await clickText(panel, 'Save');
      await waitForText(panel, 'Key saved, but it could not be verified yet');
      await waitForText(panel, 'Begin quiz');
      mock.model = model;
      const { settings } = await worker.evaluate(() => chrome.storage.local.get('settings'));
      assert.equal(settings.apiKey, 'test-key-123');
      const check = apiCalls.findLast((c) => c.method === 'GET');
      assert.ok(check.url.endsWith('/models/gemini-3.8-flash'));
      assert.equal(check.headers['x-goog-api-key'], 'test-key-123');
      await panel.click('[aria-label="Number of questions"] button:first-child');
      await shot(panel, '02-home');
    });

    await step('generates a quiz from the article text', async () => {
      await clickText(panel, 'Begin quiz');
      await waitForText(panel, 'Preparing your quiz');
      await shot(panel, '03-generating');
      await waitForText(panel, 'Question 1 of 5');
      const call = apiCalls.find((c) => c.body?.contents);
      const prompt = call.body.contents[0].parts[0].text;
      assert.equal(call.headers['x-goog-api-key'], 'test-key-123');
      assert.equal(call.body.generationConfig.responseMimeType, 'application/json');
      assert.match(prompt, /exactly 5 questions: 4 multiple choice and 1 short answer/);
      assert.match(prompt, /Title: How Octopuses Taste the World/);
      assert.match(prompt, /## Arms that make choices/);
      assert.match(prompt, /Roughly two thirds of an octopus’s neurons/);
      assert.doesNotMatch(
        prompt,
        /Subscribe|Log in|Privacy · Terms|Ten facts about squid/,
        'page chrome should be stripped',
      );
      await shot(panel, '04-question');
    });

    await step('marks a right answer and highlights the visible passage', async () => {
      await clickText(panel, 'Its suckers taste what they touch');
      await waitForText(panel, 'Correct');
      await shot(panel, '05-correct');
      await clickText(panel, 'Show in article');
      const hl = await highlightedText(article);
      assert.equal(
        hl.text,
        'Each sucker carries thousands of chemical receptors, which let an octopus taste whatever it touches.',
      );
      assert.ok(hl.visible, 'should skip the hidden duplicate');
    });

    await step('takes keyboard answers and matches quotes despite curly apostrophes', async () => {
      await clickText(panel, 'Next question');
      await waitForText(panel, 'Question 2 of 5');
      const wrong = await panel.$$eval('.choice', (els) =>
        els.findIndex((el) => !el.textContent.includes('In its arms')),
      );
      await panel.keyboard.press(String(wrong + 1));
      await waitForText(panel, 'Incorrect');
      await shot(panel, '06-wrong');
      await clickText(panel, 'Show in article');
      const hl = await highlightedText(article, '06b-article-highlight');
      assert.equal(
        hl.text,
        'Roughly two thirds of an octopus’s neurons sit in its arms rather than its head',
      );
    });

    await step('explains an answer in more depth only when asked', async () => {
      const explainCalls = () =>
        apiCalls.filter((c) => c.body?.generationConfig?.responseJsonSchema?.properties?.explanation);
      assert.equal(explainCalls().length, 0);
      await clickText(panel, 'Explain more');
      await waitForText(panel, 'More on this');
      await waitForText(panel, 'That is why the arms can filter what they touch');
      const [call] = explainCalls();
      const prompt = call.body.contents[0].parts[0].text;
      assert.match(prompt, /The reader chose: /);
      assert.match(prompt, /<article>[\s\S]*Each sucker carries thousands/);
      const buttons = await panel.$$eval('button', (els) => els.map((el) => el.textContent));
      assert.ok(!buttons.includes('Explain more'), 'the button goes away once the explanation is shown');
      await shot(panel, '06c-explain');
    });

    await step('falls back to a partial match, then reports a missing quote', async () => {
      await clickText(panel, 'Next question');
      await waitForText(panel, 'Question 3 of 5');
      await clickText(panel, 'The arms released decoys before the eyes turned toward them');
      await clickText(panel, 'Show in article');
      const hl = await highlightedText(article);
      assert.ok(hl.text.startsWith('The arms consistently grabbed the real crabs'), hl.text);

      await clickText(panel, 'Next question');
      await waitForText(panel, 'Question 4 of 5');
      await clickText(panel, 'Their robots also have no fixed joints');
      await clickText(panel, 'Show in article');
      await waitForText(panel, 'That passage could not be found');
    });

    await step('grades a written answer', async () => {
      await clickText(panel, 'Next question');
      await waitForText(panel, 'Question 5 of 5');
      await panel.type('#answer', 'So the brain has less to do and can focus on other things.');
      await panel.keyboard.down('Control');
      await panel.keyboard.press('Enter');
      await panel.keyboard.up('Control');
      await waitForText(panel, 'Partially correct');
      await waitForText(panel, 'Model answer');
      const grade = apiCalls.find((c) => c.body?.contents?.[0]?.parts?.[0]?.text.includes("Reader's answer"));
      assert.match(grade.body.contents[0].parts[0].text, /So the brain has less to do/);
      await shot(panel, '07-short-answer');
    });

    await step('shows results and records the attempt', async () => {
      // The button that appears with the feedback has focus, so the keyboard can finish the quiz.
      assert.equal(await panel.evaluate(() => document.activeElement.textContent), 'View results');
      await panel.keyboard.press('Enter');
      await waitForText(panel, '3.5 / 5');
      await waitForText(panel, '70%');
      await waitForText(panel, 'Key takeaways');
      await waitForText(panel, 'Day streak');
      const stats = await panel.$$eval('.stat', (els) => els.map((el) => el.innerText.replace(/\s+/g, ' ')));
      assert.deepEqual(stats, ['1 DAY STREAK', '70% AVERAGE SCORE', '1 ARTICLES THIS MONTH']);
      await shot(panel, '08-results');
      const { history } = await worker.evaluate(() => chrome.storage.local.get('history'));
      assert.equal(history.length, 1);
      assert.equal(history[0].title, 'How Octopuses Taste the World');
      assert.deepEqual(
        history[0].attempts.map((a) => [a.score, a.total]),
        [[3.5, 5]],
      );
    });

    await step('retries only the missed questions without recording a new attempt', async () => {
      // Recording the attempt redrew the results (the stats appeared); focus stays on the main action.
      assert.equal(await panel.evaluate(() => document.activeElement.textContent), 'Retake 2 missed');
      await panel.keyboard.press('Enter');
      await waitForText(panel, 'Question 1 of 2');
      const first = await panel.$eval('.question', (el) => el.textContent);
      assert.match(first, /Where are most/);
      await clickText(panel, 'In its arms');
      await clickText(panel, 'Next question');
      await clickText(panel, 'Show answer');
      await waitForText(panel, 'Answer revealed');
      await clickText(panel, 'View results');
      await waitForText(panel, '1 / 2');
      const { history } = await worker.evaluate(() => chrome.storage.local.get('history'));
      assert.equal(history[0].attempts.length, 1);
    });

    await step('offers the saved quiz instead of writing a new one', async () => {
      const quizCalls = () =>
        apiCalls.filter((c) => c.body?.generationConfig?.responseJsonSchema?.properties?.questions);
      const before = quizCalls().length;
      await clickText(panel, 'Done');
      await waitForText(panel, 'Saved quiz');
      await waitForText(panel, 'Write new questions');
      await shot(panel, '08b-saved-quiz');
      await clickText(panel, 'Retake saved quiz');
      await waitForText(panel, 'Question 1 of 5');
      assert.equal(quizCalls().length, before, 'retaking should not call Gemini');
      await panel.click('[aria-label="Exit quiz"]');
      await clickText(panel, 'Discard');
    });

    await step('resumes a quiz in progress after the panel reloads', async () => {
      await panel.click('#history-btn');
      await waitForText(panel, 'Quiz history');
      await waitForText(panel, 'Day streak');
      await waitForText(panel, '70%');
      await shot(panel, '09-history');
      await clickText(panel, 'Retake');
      await waitForText(panel, 'Question 1 of 5');
      await clickText(panel, 'Its suckers taste what they touch');
      await clickText(panel, 'Next question');
      await waitForText(panel, 'Question 2 of 5');
      await panel.reload();
      await waitForText(panel, 'Question 2 of 5');
      await panel.click('[aria-label="Exit quiz"]');
      await waitForText(panel, 'Quiz in progress');
      await waitForText(panel, '1 of 5 answered');
      await clickText(panel, 'Discard');
    });

    await step('cancels a quiz that is still being written', async () => {
      await clickText(panel, 'Write new questions');
      await clickText(panel, 'Cancel');
      await waitForText(panel, 'Write new questions');
      // Leaving for the history view cancels it too.
      await clickText(panel, 'Write new questions');
      await waitForText(panel, 'Preparing your quiz');
      await panel.click('#history-btn');
      await new Promise((r) => setTimeout(r, 700)); // past the mocked replies
      assert.equal(await panel.$('.question'), null, 'a cancelled quiz should not appear');
      assert.ok(await panel.$('.history-list'), 'the history view should stay open');
      await clickText(panel, 'Back');
      await waitForText(panel, 'Write new questions');
    });

    await step('explains rate limits', async () => {
      mock.quiz = () => ({
        status: 429,
        json: {
          error: {
            code: 429,
            message: 'Resource exhausted',
            details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '21s' }],
          },
        },
      });
      await clickText(panel, 'Write new questions');
      await waitForText(panel, 'The quiz could not be created');
      await waitForText(panel, 'Try again in 21 seconds');
      await shot(panel, '10-rate-limit');
      mock.quiz = () => geminiOk(QUIZ);
      await clickText(panel, 'Try again');
      await waitForText(panel, 'Question 1 of 5');
      await panel.click('[aria-label="Exit quiz"]');
    });

    await step('switches to Flash-Lite when the chosen model stays overloaded', async () => {
      mock.quiz = (url) =>
        url.includes('gemini-3.8-flash')
          ? {
              status: 503,
              json: { error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded.' } },
            }
          : geminiOk(QUIZ);
      apiCalls.length = 0;
      await clickText(panel, 'Write new questions');
      await waitForText(panel, 'Question 1 of 5', 20_000);
      await waitForText(panel, 'was busy, so Gemini 3.5 Flash-Lite wrote this quiz');
      const models = apiCalls.filter((c) => c.body?.contents).map((c) => /models\/([^:]+):/.exec(c.url)[1]);
      assert.deepEqual(models, [
        'gemini-3.8-flash',
        'gemini-3.8-flash',
        'gemini-3.8-flash',
        'gemini-3.5-flash-lite',
      ]);
      await panel.click('[aria-label="Exit quiz"]');

      mock.quiz = (url) =>
        url.includes('gemini-3.8-flash')
          ? { status: 404, json: { error: { code: 404, message: 'Model not found.' } } }
          : geminiOk(QUIZ);
      await clickText(panel, 'Write new questions');
      await waitForText(panel, "Gemini 3.8 Flash isn't available, so Gemini 3.5 Flash-Lite wrote this quiz");
      mock.quiz = () => geminiOk(QUIZ);
      await panel.click('[aria-label="Exit quiz"]');
    });

    await step('explains when the selected text is too short to quiz', async () => {
      await article.evaluate(() => getSelection().selectAllChildren(document.querySelector('h1')));
      await worker.evaluate(
        (id) =>
          chrome.storage.session.set({
            [`intent:${id}`]: {
              selection: true,
              selectionText: 'How Octopuses Taste the World',
              at: Date.now(),
            },
          }),
        tabId,
      );
      await waitForText(panel, 'Select at least 30 words, or quiz the whole article');
      assert.equal(await panel.$('.check'), null);
      const session = await worker.evaluate((id) => chrome.storage.session.get(`intent:${id}`), tabId);
      assert.deepEqual(session, {}, 'each intent is used once');
    });

    await step('offers to quiz only the selected text', async () => {
      await article.evaluate(() => {
        const p = [...document.querySelectorAll('article p')].find((el) =>
          el.textContent.trim().startsWith('An octopus has eight arms'),
        );
        const range = document.createRange();
        range.selectNodeContents(p);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      });
      await worker.evaluate(
        (id) => chrome.storage.session.set({ [`intent:${id}`]: { selection: true, at: Date.now() } }),
        tabId,
      );
      await waitForText(panel, 'Quiz only the selected text');
      const checked = await panel.$eval('.check input', (el) => el.checked);
      assert.equal(checked, true);
      assert.doesNotMatch(await panel.$eval('.page-card', (el) => el.innerText), /too short/);
      await shot(panel, '11-selection');
      apiCalls.length = 0;
      await clickText(panel, 'Write new questions');
      await waitForText(panel, 'Question 1 of');
      const prompt = apiCalls.find((c) => c.body?.contents).body.contents[0].parts[0].text;
      assert.match(prompt, /passage the reader selected/);
      assert.doesNotMatch(prompt, /Each sucker carries/);

      // Explain more works from the same text the quiz was written from.
      await clickText(panel, 'Its suckers taste what they touch');
      await clickText(panel, 'Explain more');
      await waitForText(panel, 'More on this');
      const explain = apiCalls.findLast(
        (c) => c.body?.generationConfig?.responseJsonSchema?.properties?.explanation,
      );
      const [, excerpt] = /<article>([\s\S]*)<\/article>/.exec(explain.body.contents[0].parts[0].text);
      assert.match(excerpt, /An octopus has eight arms/);
      assert.doesNotMatch(excerpt, /Each sucker carries/);
      await panel.click('[aria-label="Exit quiz"]');
    });

    await step('mixes due quizzes from different articles into one review session', async () => {
      // Make the octopus quiz due and add a second, older quiz about another article.
      await worker.evaluate(async () => {
        const day = 24 * 60 * 60 * 1000;
        const { history } = await chrome.storage.local.get('history');
        history[0].attempts = [{ at: Date.now() - 2 * day, score: 3, total: 5 }];
        const questions = [1, 2, 3, 4].map((n) => ({
          id: `q${n}`,
          type: 'mc',
          concept: 'Bees',
          question: `Bee question ${n}?`,
          options: ['Yes', 'No', 'Maybe', 'Never'],
          correctIndex: 0,
          explanation: '',
          quote: '',
        }));
        history.push({
          key: 'https://example.org/bees',
          url: 'https://example.org/bees',
          title: 'How Bees Decide',
          siteName: 'Example',
          quiz: { id: 'bees', summary: '', keyTakeaways: [], questions },
          attempts: [{ at: Date.now() - 10 * day, score: 2, total: 4 }],
          updatedAt: Date.now() - 10 * day,
        });
        await chrome.storage.local.set({ history });
      });
      await waitForText(panel, 'Start review session');
      await waitForText(panel, '6 saved questions from 2 articles');
      await shot(panel, '11a-due-for-review');
      await clickText(panel, 'Start review session');

      const sources = new Set();
      for (let i = 1; i <= 6; i++) {
        await waitForText(panel, `Question ${i} of 6`);
        sources.add(await panel.$eval('.source-line', (el) => el.textContent));
        if (i === 1) await shot(panel, '11b-review-question');
        if (await panel.$('.choice')) await panel.click('.choice');
        else await clickText(panel, 'Show answer');
        await clickText(panel, i < 6 ? 'Next question' : 'View results');
      }
      assert.deepEqual([...sources].sort(), ['From How Bees Decide', 'From How Octopuses Taste the World']);

      await waitForText(panel, 'By article');
      const rows = await panel.$$eval('.mini-item .mini-title', (els) =>
        els.map((el) => el.textContent).sort(),
      );
      assert.deepEqual(rows, ['How Bees Decide', 'How Octopuses Taste the World']);
      await shot(panel, '11c-review-results');
      const { history } = await worker.evaluate(() => chrome.storage.local.get('history'));
      for (const entry of history)
        assert.equal(entry.attempts.length, 2, `${entry.title} got a review attempt`);
    });

    await step('keeps finished results reachable from home without reopening them', async () => {
      await panel.click('#history-btn');
      await clickText(panel, 'Back');
      await waitForText(panel, 'Last results');
      await panel.reload();
      await waitForText(panel, 'Last results');
      assert.equal(await panel.$('.score'), null, 'a reopened panel starts at home');
      await clickText(panel, 'View results');
      await waitForText(panel, 'By article');
      await clickText(panel, 'Done');
      await waitForText(panel, 'Retake saved quiz');
    });

    await step('waits for a click before reading a different page in the tab', async () => {
      await clickText(panel, 'Retake saved quiz');
      await waitForText(panel, 'Question 1 of 5');
      await panel.click('[aria-label="Exit quiz"]');
      const notice = 'Click the Article Quizzer icon to quiz this page';
      await article.goto(`${base}/article.html#arms`);
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(!(await panel.evaluate((t) => document.body.innerText.includes(t), notice)));
      await article.goto(`${base}/article.html?part=2`);
      await waitForText(panel, notice);
      await waitForText(panel, 'Quiz in progress');
      assert.equal(await panel.$('.start'), null, 'nothing is offered for a page the panel has not read');
      // Clicking the icon on the new page (simulated) lets the panel read it.
      await worker.evaluate(
        (id) => chrome.storage.session.set({ [`intent:${id}`]: { selection: false, at: Date.now() } }),
        tabId,
      );
      await waitForText(panel, 'Begin quiz');
      await clickText(panel, 'Discard');
    });

    await step('quizzes a PDF by sending the file to Gemini', async () => {
      const printer = await browser.newPage();
      await printer.goto(`${base}/article.html`);
      extra['paper.pdf'] = { type: 'application/pdf', body: await printer.pdf({ format: 'Letter' }) };
      await printer.close();

      const pdfTab = await browser.newPage();
      await pdfTab.goto(`${base}/paper.pdf`).catch(() => {}); // headless may treat PDFs as downloads
      const pdfTabId = await tabIdFor(`${base}/paper.pdf`);
      const pdfPanel = await open(380, 760);
      await interceptGemini(pdfPanel);
      await pdfPanel.goto(extUrl(`sidepanel.html?tabId=${pdfTabId}`));
      await waitForText(pdfPanel, 'PDF · 127.0.0.1');
      await waitForText(pdfPanel, 'Gemini reads the entire PDF');
      await shot(pdfPanel, '12-pdf');
      apiCalls.length = 0;
      await clickText(pdfPanel, 'Begin quiz');
      await waitForText(pdfPanel, 'Question 1 of 5');
      const [file, text] = apiCalls.find((c) => c.body?.contents).body.contents[0].parts;
      assert.equal(file.inlineData.mimeType, 'application/pdf');
      assert.equal(Buffer.from(file.inlineData.data, 'base64').length, extra['paper.pdf'].body.length);
      assert.match(text.text, /attached PDF/);
      await clickText(pdfPanel, 'Its suckers taste what they touch');
      await waitForText(pdfPanel, 'Correct');
      assert.equal(
        await pdfPanel.$$eval('button', (els) =>
          els.some((el) => el.textContent.includes('Show in article')),
        ),
        false,
      );
      await pdfPanel.close();
      await pdfTab.close();
    });

    await step('explains pages Chrome will not let extensions read', async () => {
      // Extensions can't see chrome:// URLs, so find the new tab by its id instead.
      const tabIds = () => worker.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.id));
      const before = new Set(await tabIds());
      const restricted = await browser.newPage();
      await restricted.goto('chrome://version');
      const restrictedTab = (await tabIds()).find((id) => !before.has(id));
      assert.ok(restrictedTab, 'should find the chrome://version tab');
      const restrictedPanel = await open(380, 600);
      await restrictedPanel.goto(extUrl(`sidepanel.html?tabId=${restrictedTab}`));
      await waitForText(restrictedPanel, 'Chrome does not allow extensions on this page');
      await shot(restrictedPanel, '13-restricted');
      await restrictedPanel.close();
      await restricted.close();
    });

    await step('settings page switches models without losing an unsaved key', async () => {
      const options = await open(900, 1100);
      await interceptGemini(options);
      await options.goto(extUrl('options.html'));
      await options.waitForSelector('input[name="model"]');
      assert.equal(await options.$eval('#api-key', (el) => el.value), 'test-key-123');
      await fill(options, '#api-key', 'pasted-key-456');
      await options.click('input[value="gemini-3.5-flash-lite"]');
      await waitForText(options, 'Quizzes will use gemini-3.5-flash-lite');
      const stored = async () => (await worker.evaluate(() => chrome.storage.local.get('settings'))).settings;
      assert.equal((await stored()).model, 'gemini-3.5-flash-lite');
      assert.equal(await options.$eval('#api-key', (el) => el.value), 'pasted-key-456');
      await shot(options, '14-options');
      await clickText(options, 'Save');
      await waitForText(options, 'The key works');
      assert.equal((await stored()).apiKey, 'pasted-key-456');

      await options.type('#custom-model', 'models/gemini-test');
      assert.equal(await options.$eval('input[value="custom"]', (el) => el.checked), true);
      await options.keyboard.press('Tab');
      await waitForText(options, 'Quizzes will use gemini-test');
      assert.equal((await stored()).model, 'gemini-test');
      assert.equal(await options.$eval('#custom-model', (el) => el.value), 'gemini-test');
      await options.close();
    });

    console.log(`\n${passed} steps passed`);
  } finally {
    await env.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
