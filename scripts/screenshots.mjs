// Renders store/README screenshots (1280x800: article on the left, quiz panel on
// the right) and a 440x280 promo tile, using the sample article and a mocked quiz.
// Usage: npm run screenshots

import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { geminiMock, launch, waitForText, clickText, newPage, root } from '../tests/helpers.mjs';

const outDir = path.join(root, 'store');
const { intercept } = geminiMock();

const env = await launch();
const { browser, worker, extUrl, base, tabIdFor } = env;
try {
  await mkdir(outDir, { recursive: true });
  await worker.evaluate(() =>
    chrome.storage.local.set({
      settings: {
        apiKey: 'demo',
        model: 'gemini-3.8-flash',
        count: 5,
        style: 'mixed',
        difficulty: 'understanding',
      },
    }),
  );

  const article = await newPage(browser, 880, 800, 'light');
  await article.goto(`${base}/article.html`);
  const panel = await newPage(browser, 400, 800, 'light');
  await intercept(panel);
  await panel.goto(extUrl(`sidepanel.html?tabId=${await tabIdFor(`${base}/article.html`)}`));

  await waitForText(panel, 'Begin quiz');
  await save('screenshot-start.png', article, panel);

  await clickText(panel, 'Begin quiz');
  await waitForText(panel, 'Question 1 of 5');
  await clickText(panel, 'Its suckers taste what they touch');
  await clickText(panel, 'Next question');
  await clickText(panel, 'In its head');
  await clickText(panel, 'Show in article');
  await new Promise((r) => setTimeout(r, 1200)); // let the smooth scroll finish
  await save('screenshot-quiz.png', article, panel);

  await clickText(panel, 'Next question');
  await clickText(panel, 'The arms released decoys');
  await clickText(panel, 'Next question');
  await clickText(panel, 'Their robots also have no fixed joints');
  await clickText(panel, 'Next question');
  await panel.type('#answer', 'So the brain has less to do and can focus on other things.');
  await clickText(panel, 'Check answer');
  await waitForText(panel, 'Partially correct');
  await clickText(panel, 'View results');
  await waitForText(panel, 'Key takeaways');
  await article.evaluate(() => {
    CSS.highlights.clear();
    window.scrollTo(0, 0);
  });
  await save('screenshot-results.png', article, panel);

  await promoTile();
  console.log(`Saved screenshots to ${path.relative(process.cwd(), outDir)}/`);
} finally {
  await env.close();
}

async function save(name, left, right) {
  const [a, b] = [await left.screenshot(), await right.screenshot()];
  const page = await newPage(browser, 1280, 800);
  const src = (buf) => `data:image/png;base64,${Buffer.from(buf).toString('base64')}`;
  await page.setContent(`
    <body style="margin:0; display:flex; height:800px; overflow:hidden; background:#fff">
      <img src="${src(a)}" style="display:block; width:880px; height:800px">
      <img src="${src(b)}" style="display:block; width:400px; height:800px; box-shadow:-1px 0 0 #d4d4da">
    </body>`);
  await page.screenshot({ path: path.join(outDir, name) });
  await page.close();
}

async function promoTile() {
  const icon = (await readFile(path.join(root, 'extension/icons/icon.svg'))).toString('base64');
  const font = (await readFile(path.join(root, 'extension/fonts/newsreader.woff2'))).toString('base64');
  const italic = (await readFile(path.join(root, 'extension/fonts/newsreader-italic.woff2'))).toString(
    'base64',
  );
  const page = await newPage(browser, 440, 280);
  await page.setContent(`
    <style>
      @font-face { font-family: N; src: url(data:font/woff2;base64,${font}); font-weight: 200 800; }
      @font-face { font-family: N; src: url(data:font/woff2;base64,${italic}); font-weight: 200 800; font-style: italic; }
    </style>
    <body style="margin:0; width:440px; height:280px; padding:0 36px; box-sizing:border-box; display:flex; flex-direction:column; justify-content:center;
                 background:#faf9f6; color:#121212; font-family:N, Georgia, serif">
      <div style="display:flex; align-items:center; gap:16px; padding-bottom:14px; border-bottom:4px double #121212">
        <img src="data:image/svg+xml;base64,${icon}" width="58" height="58">
        <div style="font-size:36px; font-weight:700; letter-spacing:-0.015em; line-height:1">Article Quizzer</div>
      </div>
      <div style="margin-top:14px; font-size:19px; font-style:italic; line-height:1.35; color:#4a4843">Comprehension quizzes for the articles and PDFs you read.</div>
    </body>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(outDir, 'promo-small.png') });
  await page.close();
}
