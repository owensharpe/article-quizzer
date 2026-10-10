# Publishing to the Chrome Web Store

Everything the listing needs is already in this repo. This guide walks through the parts only you can do.

## Before you start

- **A developer account.** Register at the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) with a Google account. There's a one-time $5 registration fee.
- **A public privacy policy URL.** The review requires one because the extension sends page content to a third party (Google). If this GitHub repo is public, use `https://github.com/owensharpe/article-quizzer/blob/main/PRIVACY.md`. If it's private, publish `PRIVACY.md` somewhere public, such as a GitHub Gist or GitHub Pages.
- **Test it with a real key.** Run `GEMINI_API_KEY=… npm run check:live`, then load the extension and take a quiz or two by hand.

## 1. Build the zip

```bash
npm run package
```

That writes `dist/article-quizzer-<version>.zip` from the `extension/` folder. Every upload needs a higher `version` in `extension/manifest.json`, so bump it (for example `0.1.0` → `0.1.1`) before packaging an update.

## 2. Create the item

In the dashboard, click **New item** and upload the zip.

## 3. Store listing tab

| Field | What to enter |
| --- | --- |
| Description | The text below |
| Category | Education |
| Language | English |
| Store icon | `extension/icons/icon128.png` |
| Screenshots | `store/screenshot-quiz.png`, `store/screenshot-results.png`, `store/screenshot-start.png` (all 1280×800) |
| Small promo tile | `store/promo-small.png` (440×280) |
| Homepage / support URL | The GitHub repo, if it's public |

The name and short summary come from `manifest.json`.

**Description:**

```text
Article Quizzer turns whatever you're reading into a short quiz, so you understand it better and actually remember it.

Open an article or PDF, click the Article Quizzer icon, and a side panel writes a quiz about it with Google's Gemini:

• Multiple-choice and written questions that test the main ideas and the reasoning behind them, not trivia
• Instant feedback with an explanation and the exact passage each answer comes from
• "Show in article" highlights that passage on the page
• Written answers are graded for understanding, not wording
• Three levels: Recall, Comprehension, and Analysis
• Works on PDFs, or on just the text you select
• Retry the questions you missed, or ask for new ones
• "Explain more" gives a fuller explanation of any answer
• Saved quizzes: reopening an article offers your earlier quiz, instantly
• A day streak, your average score, and articles quizzed this month
• Spaced review: quizzes come back when it's time to review them, which is what makes things stick
• Review sessions mix saved questions from every quiz that's due

Setup takes a minute. Article Quizzer uses your own free Gemini API key from Google AI Studio (aistudio.google.com/apikey).

Privacy: there's no server and no tracking. Article Quizzer reads a page only when you invoke it there. The article's text goes straight from your browser to Google's Gemini API when you start a quiz; passages from it go with your written answers for grading, and when you ask for a fuller explanation. Your key and quiz history stay on your computer. On Gemini's free tier, Google may use submitted content to improve its products.
```

## 4. Privacy practices tab

**Single purpose:**

```text
Article Quizzer creates quizzes about the article or PDF the user is viewing, to help them understand and remember it.
```

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `activeTab` | Reads the current tab only after the user clicks the extension icon, presses its shortcut, or chooses one of its "Create a quiz" items from the right-click menu, so it can write a quiz about that page. If the tab then moves to a different page, the extension doesn't read it until the user invokes the extension there. |
| `scripting` | Runs a script in the page the user invoked the extension on, to extract the article text and to highlight the passage behind an answer when the user clicks "Show in article". |
| `sidePanel` | Shows the quiz in Chrome's side panel, next to the article. |
| `storage` | Saves the user's Gemini API key, quiz settings, and quiz history locally on their device. |
| `contextMenus` | Adds "Create a quiz from this page" and "Create a quiz from the selected text" to the right-click menu. |
| Host permission (`generativelanguage.googleapis.com`) | Sends requests to Google's Gemini API with the user's own API key: the article text to write quiz questions, the user's written answers (with the passage each question is based on) to grade them, and the text around an answer when the user asks for a fuller explanation. It also checks the key when the user saves it. |

**Remote code:** No. All code ships in the package, including the bundled Readability library.

**Data usage.** Check these boxes:

- **Website content**: the text of pages the user quizzes (or of the selection or PDF they quiz) is sent to the Gemini API to write questions, and passages from it are sent again with the user's written answers for grading and with requests for a fuller explanation.
- **Authentication information**: the user's Gemini API key is sent to Google with each request. It isn't sent anywhere else.

Then certify all three statements: you don't sell or transfer data to third parties outside the approved use cases, don't use it for purposes unrelated to the single purpose, and don't use it to determine creditworthiness.

**Privacy policy URL:** the public link from "Before you start".

## 5. Distribution tab

Pick **Public**, or **Unlisted** if you'd rather share a link with friends first. Unlisted is a low-pressure way to start, and you can switch to public later.

## 6. Submit

Click **Submit for review**. Reviews usually take a few days. Narrow permissions help: this extension uses `activeTab` instead of asking to read every site, which avoids the longer in-depth review.

## Updating later

1. Bump `version` in `extension/manifest.json`.
2. Run `npm run package`.
3. In the dashboard, open the item, go to **Package**, upload the new zip, and submit again.

## Things reviewers or users may ask about

- **Each user needs their own Gemini key.** The first-run screen links to Google AI Studio and checks the key when it's pasted. Keys are free, but the free tier has rate limits. If users hit them, they can switch to Flash-Lite in settings.
- **Model names change.** If Google retires `gemini-3.8-flash`, users get a clear "model isn't available" message and can pick another model in settings. Update the defaults in `extension/lib/storage.js` and ship a new version.
