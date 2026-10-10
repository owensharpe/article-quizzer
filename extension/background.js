// Each panel belongs to one tab. That matches activeTab, which grants access
// only to the tab the user clicked the extension on.

const MENU_PAGE = 'quiz-page';
const MENU_SELECTION = 'quiz-selection';

// Keep the API key out of reach of content scripts.
chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_PAGE, title: 'Create a quiz from this page', contexts: ['page'] });
    chrome.contextMenus.create({
      id: MENU_SELECTION,
      title: 'Create a quiz from the selected text',
      contexts: ['selection'],
    });
  });
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener((tab) => openPanel(tab));

chrome.contextMenus.onClicked.addListener((info, tab) => {
  openPanel(tab, info.menuItemId === MENU_SELECTION ? info.selectionText : null);
});

function openPanel(tab, selectionText = null) {
  if (!tab?.id || tab.id < 0) return;
  // No awaits before open(): Chrome only allows it during the user gesture.
  chrome.sidePanel.setOptions({ tabId: tab.id, path: `sidepanel.html?tabId=${tab.id}`, enabled: true });
  chrome.sidePanel.open({ tabId: tab.id }).catch((err) => console.warn('Could not open side panel:', err));
  // An already-open panel watches this key and re-reads the page.
  chrome.storage.session.set({
    [`intent:${tab.id}`]: {
      selection: selectionText !== null,
      selectionText: selectionText ?? '',
      at: Date.now(),
    },
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([`intent:${tabId}`, `run:${tabId}`]);
});
