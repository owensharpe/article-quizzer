// Sends the sample article to the real Gemini API and prints the quiz it gets back.
// Usage: GEMINI_API_KEY=your-key npm run check:live [-- model-id]

import { readFile } from 'node:fs/promises';
import { generateQuiz, gradeShortAnswer } from '../extension/lib/quiz.js';
import { DEFAULT_SETTINGS } from '../extension/lib/storage.js';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('Set GEMINI_API_KEY first, e.g. GEMINI_API_KEY=... npm run check:live');
  process.exit(1);
}
const model = process.argv[2] ?? DEFAULT_SETTINGS.model;

// Crude text extraction is fine for the known fixture.
const html = await readFile(new URL('../tests/fixtures/article.html', import.meta.url), 'utf8');
const text = html
  .match(/<article>([\s\S]*)<\/article>/)[1]
  .replace(/<p class="hidden-dup">[\s\S]*?<\/p>/, '')
  .replace(/<h2>/g, '\n\n## ')
  .replace(/<\/(p|h1|h2)>/g, '\n\n')
  .replace(/<[^>]+>/g, '')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const article = {
  url: 'https://example.com/octopus',
  title: 'How Octopuses Taste the World',
  siteName: 'The Tide Pool',
};
const settings = { apiKey, model };

console.log(`Asking ${model} for a 5-question mixed quiz…`);
const started = Date.now();
const quiz = await generateQuiz({
  article,
  text,
  options: { count: 5, style: 'mixed', difficulty: 'understanding' },
  settings,
});
console.log(`Got ${quiz.questions.length} questions in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
console.log(`Summary: ${quiz.summary}\n`);

for (const [i, q] of quiz.questions.entries()) {
  console.log(`${i + 1}. [${q.concept}] ${q.question}`);
  if (q.type === 'mc')
    q.options.forEach((o, j) => console.log(`   ${j === q.correctIndex ? '✓' : ' '} ${o}`));
  else console.log(`   Model answer: ${q.answer}`);
  const found = text.replace(/\s+/g, ' ').includes(q.quote.replace(/\s+/g, ' '));
  console.log(`   Quote ${found ? '(verbatim)' : '(not verbatim)'}: ${q.quote}\n`);
}

const written = quiz.questions.find((q) => q.type === 'short');
if (written) {
  const grade = await gradeShortAnswer({
    question: written,
    answer: 'It lets the brain focus on other things.',
    settings,
  });
  console.log(`Grading a weak answer to "${written.question}": ${grade.verdict}. ${grade.feedback}`);
}
