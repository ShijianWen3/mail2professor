// 点击扩展图标直接打开侧边栏（MV3 里 sidePanel 需要显式设置面板行为）
function enableActionClick() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(enableActionClick);
chrome.runtime.onStartup.addListener(enableActionClick);
