# Privacy Policy for Article Quizzer

_Last updated: October 9, 2026_

Article Quizzer is a Chrome extension that writes quizzes about articles and PDFs you choose. This policy explains what data it handles and where that data goes.

## The short version

- Article Quizzer has no server, no accounts, no analytics, and no ads. The developer never receives your data.
- Page content is sent to Google's Gemini API, using your own API key, only when you create a quiz, have a written answer graded, or click *Explain more*.
- Everything else stays in your browser.

## What the extension reads

- **The page you invoke it on.** The extension reads a page's title, address, and text (or downloads the PDF) only after you click its toolbar icon, press its keyboard shortcut, or choose one of its *Create a quiz* items from the right-click menu on that page. If the page was still loading, it reads it once more when loading finishes. It doesn't read other tabs, and if you move to a different page in the same tab, it doesn't read that page until you invoke it there. *Show in article* highlights a passage on the page you invoked it on.
- **Text you select**, if you choose to quiz only your selection.
- **Your written answers** to short-answer questions.

## Where your data goes

- **When you create a quiz**, the page's title, address, author and site name (when the page lists them), and text go directly from your browser to Google's Gemini API at `generativelanguage.googleapis.com`, authenticated with your API key. If you quiz a selection, the selected text is sent in place of the page's text; for a PDF, the file itself is. When you ask for new questions, the questions you already have are included so Gemini can avoid repeating them.
- **When a written answer is graded**, the question, the model answer and its key points, the quoted passage, and your answer go to the Gemini API.
- **When you click Explain more**, the question, its answer choices or model answer (with any explanation already shown), your answer, the quoted passage, and, if the article is still open in the tab, up to about 8,000 characters of its text around that passage (taken from your selection if you quizzed one) go to the Gemini API.
- **When you save your API key**, the extension checks it with a request to the Gemini API that contains no page content.
- Google handles these requests under the [Gemini API Additional Terms of Service](https://ai.google.dev/gemini-api/terms) and the [Google Privacy Policy](https://policies.google.com/privacy). **On Gemini's free tier, Google may use submitted content to improve its products.** Don't use a free key for confidential material.
- Nothing is sent anywhere else.

## What's stored on your device

Chrome's extension storage on your computer holds:

- your Gemini API key and quiz settings
- your quiz history: each article's title and address, its generated questions, and your scores (up to 100 articles); article text isn't stored
- statistics (streak, average score, articles this month), which are calculated from that history
- the quiz you're taking in each tab, or the one you last finished there, which is cleared when you close the tab or the browser

You can delete your quiz history on the settings page. Uninstalling the extension removes all of it.

## Permissions

| Permission | Why it's needed |
| --- | --- |
| `activeTab`, `scripting` | Read the page you invoked the extension on, and highlight a quoted passage when you click *Show in article*. |
| `sidePanel` | Show the quiz next to the article. |
| `storage` | Keep your key, settings, and quiz history on your device. |
| `contextMenus` | Add *Create a quiz* items to the right-click menu. |
| Access to `generativelanguage.googleapis.com` | Send requests to Google's Gemini API. |

## Sharing and sale of data

The developer doesn't collect, sell, or share your data, and doesn't use it for advertising, creditworthiness, or anything unrelated to making quizzes.

## Children

Article Quizzer isn't directed at children under 13.

## Changes

Any changes to this policy will be posted in this file, with a new date at the top.

## Contact

Questions? Open an issue at <https://github.com/owensharpe/article-quizzer/issues>.
