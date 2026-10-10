export const MAX_ARTICLE_CHARS = 120_000;
// Gemini takes inline files up to about 20 MB per request, and base64 adds a third.
const MAX_PDF_BYTES = 14 * 1024 * 1024;
const HIGHLIGHT_NAME = 'article-quizzer';
const HIGHLIGHT_CSS = `::highlight(${HIGHLIGHT_NAME}) { background-color: #ffe066; color: #111; }`;

class PageError extends Error {
  constructor({ title, detail }) {
    super(title);
    this.name = 'PageError';
    this.title = title;
    this.detail = detail;
  }
}

export async function readArticle(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['vendor/Readability.js'] });
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractArticle,
      args: [MAX_ARTICLE_CHARS],
    });
    if (!frame?.result) throw new Error('The page returned nothing.');
    return frame.result;
  } catch (err) {
    throw new PageError(describeScriptingError(err));
  }
}

// Fetched from inside the tab, so the request is same-origin and carries the
// reader's cookies (a library login, say) without extra permissions.
export async function readPdf(tabId) {
  let result;
  try {
    [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: fetchPdf,
      args: [MAX_PDF_BYTES],
    });
  } catch (err) {
    throw new PageError(describeScriptingError(err));
  }
  if (result?.tooBig) {
    const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
    throw new PageError({
      title: 'This PDF is too large',
      detail: `It is ${mb(result.bytes)} MB; the limit is ${mb(MAX_PDF_BYTES)} MB.`,
    });
  }
  if (!result?.base64) {
    throw new PageError({
      title: 'This PDF could not be loaded',
      detail: result?.error ?? 'Reload the page and try again.',
    });
  }
  return result.base64;
}

export async function highlightInArticle(tabId, quote) {
  await chrome.scripting.insertCSS({ target: { tabId }, css: HIGHLIGHT_CSS });
  const [frame] = await chrome.scripting.executeScript({
    target: { tabId },
    func: highlightQuote,
    args: [quote, HIGHLIGHT_NAME],
  });
  return frame?.result ?? { found: false };
}

export async function clearArticleHighlight(tabId) {
  await chrome.scripting
    .executeScript({
      target: { tabId },
      func: (name) => CSS.highlights?.delete(name),
      args: [HIGHLIGHT_NAME],
    })
    .catch(() => {});
}

function describeScriptingError(err) {
  const msg = String(err?.message ?? err);
  if (
    /chrome:\/\/|chrome-extension:\/\/|chrome-search:|devtools:|about:|extensions gallery|webstore|chromewebstore/i.test(
      msg,
    )
  ) {
    return {
      title: 'Chrome does not allow extensions on this page',
      detail: 'Open an article on a regular website and try again.',
    };
  }
  if (/file:\/\//i.test(msg)) {
    return {
      title: 'Local files are not readable yet',
      detail:
        'To quiz a saved page, turn on "Allow access to file URLs" for Article Quizzer in chrome://extensions, then reload it.',
    };
  }
  if (/no tab with id/i.test(msg)) {
    return {
      title: 'This tab has been closed',
      detail: 'Open an article and click the Article Quizzer icon.',
    };
  }
  if (/error page/i.test(msg)) {
    return {
      title: 'This page did not load',
      detail: 'Reload it, then click the Article Quizzer icon again.',
    };
  }
  if (/permission|cannot access/i.test(msg)) {
    return {
      title: 'Click the Article Quizzer icon to read this page',
      detail:
        'Chrome lets the extension read a page only after you click its toolbar icon, or choose "Create a quiz from this page" from the right-click menu, on that page.',
    };
  }
  return { title: 'This page could not be read', detail: msg };
}

// Everything below runs inside the page via chrome.scripting.executeScript, which
// serializes each function, so they can't reference anything outside themselves.

function extractArticle(maxChars) {
  const BLOCKS = new Set([
    'ADDRESS',
    'ARTICLE',
    'ASIDE',
    'BLOCKQUOTE',
    'DD',
    'DETAILS',
    'DIV',
    'DL',
    'DT',
    'FIGCAPTION',
    'FIGURE',
    'FOOTER',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'HEADER',
    'HR',
    'LI',
    'MAIN',
    'NAV',
    'OL',
    'P',
    'SECTION',
    'TABLE',
    'TR',
    'UL',
  ]);
  const SKIP = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'SVG',
    'CANVAS',
    'IFRAME',
    'BUTTON',
    'FORM',
  ]);

  // Readability returns HTML; flatten it to text but keep paragraph breaks
  // and headings so the model can see the article's structure.
  const toText = (root) => {
    let out = '';
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.nodeValue.replace(/\s+/g, ' ');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toUpperCase(); // SVG elements keep lowercase tag names
      if (SKIP.has(tag)) return;
      if (tag === 'BR') {
        out += '\n';
        return;
      }
      if (tag === 'PRE') {
        out += `\n\n${node.textContent}\n\n`;
        return;
      }
      const block = BLOCKS.has(tag);
      if (block) out += '\n\n';
      if (/^H[1-6]$/.test(tag)) out += `${'#'.repeat(Number(tag[1]))} `;
      else if (tag === 'LI') out += '- ';
      else if (tag === 'TD' || tag === 'TH') out += ' | ';
      for (const child of node.childNodes) walk(child);
      if (block) out += '\n\n';
    };
    walk(root);
    return out
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  };

  // Chinese, Japanese, and Thai don't put spaces between words.
  const segmenter = Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
  const countWords = (text) => {
    if (!segmenter) return (text.match(/\S+/g) ?? []).length;
    let count = 0;
    for (const segment of segmenter.segment(text)) if (segment.isWordLike) count++;
    return count;
  };
  const clip = (text) => {
    if (text.length <= maxChars) return { text, truncated: false };
    const cut = text.lastIndexOf('\n\n', maxChars);
    return { text: text.slice(0, cut > maxChars * 0.8 ? cut : maxChars), truncated: true };
  };
  const meta = (name) =>
    document
      .querySelector(`meta[property="${name}"], meta[name="${name}"]`)
      ?.getAttribute('content')
      ?.trim() ?? '';

  if (document.contentType === 'application/pdf') {
    let fileName = location.pathname.split('/').pop() ?? '';
    try {
      fileName = decodeURIComponent(fileName);
    } catch {
      // Keep the raw name.
    }
    return {
      isPdf: true,
      url: location.href,
      title: document.title || fileName,
      siteName: '',
      byline: '',
      selection: '',
      selectionWords: 0,
      readyState: document.readyState,
    };
  }

  let parsed = null;
  try {
    // Readability mutates the document it's given, so hand it a copy.
    if (typeof Readability === 'function') parsed = new Readability(document.cloneNode(true)).parse();
  } catch {
    parsed = null;
  }

  let text = parsed?.content ? toText(new DOMParser().parseFromString(parsed.content, 'text/html').body) : '';
  let wordCount = countWords(text);
  if (wordCount < 80) {
    // Not article-shaped (docs, forums, etc.): fall back to the visible page text.
    text = (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim();
    wordCount = countWords(text);
  }

  const selectionText = String(window.getSelection?.() ?? '').trim();
  const selectionWords = countWords(selectionText);
  const clipped = clip(text);

  return {
    url: location.href,
    title: (parsed?.title || meta('og:title') || document.title || '').trim(),
    byline: (parsed?.byline || meta('author') || '').trim(),
    siteName: (parsed?.siteName || meta('og:site_name') || '').trim(),
    text: clipped.text,
    truncated: clipped.truncated,
    wordCount,
    selection: selectionWords >= 30 ? clip(selectionText).text : '',
    selectionWords: selectionWords >= 30 ? selectionWords : 0,
    // Read before the page finished loading? The panel reads it again once it has.
    readyState: document.readyState,
  };
}

async function fetchPdf(maxBytes) {
  try {
    const res = await fetch(location.href);
    if (!res.ok) return { error: `The server answered with HTTP ${res.status}.` };
    const declared = Number(res.headers.get('content-length'));
    if (declared > maxBytes) return { tooBig: true, bytes: declared };
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > maxBytes) return { tooBig: true, bytes: buffer.byteLength };
    const bytes = new Uint8Array(buffer);
    // A sign-in or error page can come back in place of the file. PDF readers
    // allow a little junk before the header, so look a short way in.
    if (!String.fromCharCode(...bytes.subarray(0, 1024)).includes('%PDF-')) {
      return {
        error:
          'The server did not send a PDF; it may have sent a sign-in page instead. Reload the PDF and try again.',
      };
    }
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { base64: btoa(binary) };
  } catch (err) {
    return {
      error:
        location.protocol === 'file:'
          ? 'Local PDF files cannot be read. Open the PDF from a website instead.'
          : String(err?.message ?? err),
    };
  }
}

function highlightQuote(quote, name) {
  const WORD = /[\p{L}\p{N}]/u;

  // Index only letters and digits so matching ignores spacing, punctuation,
  // and curly-vs-straight quotes, which models often change when quoting.
  const nodes = [];
  const nodeAt = [];
  const offsetAt = [];
  let hay = '';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('script, style, noscript, template, textarea, select')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const index = nodes.push(node) - 1;
    let offset = 0;
    for (const ch of node.nodeValue) {
      if (WORD.test(ch)) {
        // One entry per UTF-16 unit, to line up with indexes into hay.
        hay += ch.toLowerCase();
        while (nodeAt.length < hay.length) {
          nodeAt.push(index);
          offsetAt.push(offset);
        }
      }
      offset += ch.length;
    }
  }

  let needle = '';
  for (const ch of String(quote)) if (WORD.test(ch)) needle += ch.toLowerCase();
  if (needle.length < 6) return { found: false };

  const rangeFor = (start, length) => {
    const end = start + length - 1;
    const startNode = nodes[nodeAt[start]];
    const endNode = nodes[nodeAt[end]];
    if (!startNode || !endNode) return null;
    let startOffset = offsetAt[start];
    let endOffset = offsetAt[end] + (endNode.nodeValue.codePointAt(offsetAt[end]) > 0xffff ? 2 : 1);
    // The index skips punctuation, so take in adjacent quote marks and the final period.
    while (startOffset > 0 && /[“‘"'(\[]/.test(startNode.nodeValue[startOffset - 1])) startOffset--;
    while (endOffset < endNode.nodeValue.length && /[.!?…”’"')\]]/.test(endNode.nodeValue[endOffset]))
      endOffset++;
    const range = document.createRange();
    try {
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
    } catch {
      return null;
    }
    return range;
  };
  const isVisible = (range) => {
    const rect = range.getBoundingClientRect();
    const el = range.startContainer.parentElement;
    return rect.width > 0 && rect.height > 0 && (!el || getComputedStyle(el).visibility !== 'hidden');
  };

  // Try the whole quote, then shrinking prefixes and suffixes in case the
  // model changed a word or two. Shorter pieces match in too many places.
  const candidates = [needle];
  for (const len of [Math.floor(needle.length * 0.6), 60, 40].sort((a, b) => b - a)) {
    if (len >= 40 && len < needle.length) candidates.push(needle.slice(0, len), needle.slice(-len));
  }
  for (const [i, part] of candidates.entries()) {
    for (
      let at = hay.indexOf(part), tries = 0;
      at !== -1 && tries < 50;
      at = hay.indexOf(part, at + 1), tries++
    ) {
      const range = rangeFor(at, part.length);
      if (!range || !isVisible(range)) continue;
      if (window.Highlight && CSS.highlights) {
        CSS.highlights.set(name, new Highlight(range));
      } else {
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
      range.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return { found: true, partial: i > 0 };
    }
  }
  return { found: false };
}
