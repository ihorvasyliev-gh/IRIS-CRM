// Clicking the toolbar icon opens the side panel.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// When the browser starts, pick up a newer version left in the extension folder (see checkForUpdate in sidepanel.js).
chrome.runtime.onStartup.addListener(async () => {
  try {
    const onDisk = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json();
    if (onDisk.version !== chrome.runtime.getManifest().version) chrome.runtime.reload();
  } catch (error) {
    console.error(error);
  }
});
