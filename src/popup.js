document.addEventListener("DOMContentLoaded", async () => {
  const folderNameEl = document.getElementById("folder-name");
  const changeFolderBtn = document.getElementById("change-folder");
  const frontmatterCheckbox = document.getElementById("include-frontmatter");
  const metricsCheckbox = document.getElementById("include-metrics");
  const mediaCheckbox = document.getElementById("include-media");
  const lastSaveEl = document.getElementById("last-save");

  const settings = await chrome.storage.sync.get({
    includeFrontmatter: true,
    includeMetrics: true,
    includeMedia: true,
  });

  frontmatterCheckbox.checked = settings.includeFrontmatter;
  metricsCheckbox.checked = settings.includeMetrics;
  mediaCheckbox.checked = settings.includeMedia;

  for (const cb of [frontmatterCheckbox, metricsCheckbox, mediaCheckbox]) {
    cb.addEventListener("change", saveOptions);
  }

  // Show saved folder name
  const stored = await chrome.storage.local.get({ folderName: "" });
  if (stored.folderName) {
    folderNameEl.textContent = stored.folderName;
    folderNameEl.classList.add("has-folder");
  }

  // Listen for folder changes while popup is open
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.folderName?.newValue) {
      folderNameEl.textContent = changes.folderName.newValue;
      folderNameEl.classList.add("has-folder");
    }
  });

  // Change folder — send to active x.com tab
  changeFolderBtn.addEventListener("click", async () => {
    changeFolderBtn.disabled = true;
    changeFolderBtn.textContent = "选择中...";
    try {
      const response = await sendToActiveTab({ type: "PICK_FOLDER" });
      if (response?.success) {
        folderNameEl.textContent = response.name;
        folderNameEl.classList.add("has-folder");
      } else if (response?.error !== "cancelled") {
        folderNameEl.textContent = response?.error || "选择失败";
        folderNameEl.classList.remove("has-folder");
      }
    } catch (_e) {
      folderNameEl.textContent = "请先打开 x.com 页面";
      folderNameEl.classList.remove("has-folder");
    }
    changeFolderBtn.disabled = false;
    changeFolderBtn.textContent = "更换";
  });

  loadLastSave();

  async function saveOptions() {
    await chrome.storage.sync.set({
      includeFrontmatter: frontmatterCheckbox.checked,
      includeMetrics: metricsCheckbox.checked,
      includeMedia: mediaCheckbox.checked,
    });
  }

  async function loadLastSave() {
    try {
      const state = await chrome.storage.local.get({ lastSave: null });
      const last = state.lastSave;
      if (!last) {
        lastSaveEl.textContent = "暂无记录";
        return;
      }
      const when = new Date(last.timestamp).toLocaleString("zh-CN", { hour12: false });
      lastSaveEl.textContent = `${when} · ${last.title || last.url}`;
    } catch (_e) {
      lastSaveEl.textContent = "读取失败";
    }
  }
});

function sendToActiveTab(message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.[0];
      if (!tab?.id) {
        reject(new Error("未找到活动标签页"));
        return;
      }
      const url = tab.url || "";
      if (!url.includes("x.com") && !url.includes("twitter.com")) {
        reject(new Error("请先打开 x.com 页面"));
        return;
      }
      chrome.tabs.sendMessage(tab.id, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  });
}
