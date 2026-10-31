/*
 * Xiaohongshu Importer plugin
 * Customized for local vault workflow
 */

const {
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  normalizePath,
  requestUrl,
} = require("obsidian");

const DEFAULT_SETTINGS = {
  noteFolder: "00.收集箱",
  imageFolder: "附件/XHS",
  downloadMedia: true,
  frontmatterFields: [],
};

const XHS_SHORT_LINK_HOSTS = new Set(["xhslink.com", "xhslink.cn"]);
const XHS_NOTE_HOSTS = new Set(["xiaohongshu.com", "www.xiaohongshu.com"]);
const XHS_REQUEST_HEADERS = Object.freeze({
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
});

function cleanURLCandidate(candidate) {
  return candidate
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "")
    .replace(/[.,，。;；!！?？、)\]}>）】》」』]+$/u, "");
}

function normalizeXHSURL(candidate) {
  try {
    const parsed = new URL(cleanURLCandidate(candidate));
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return null;
    }

    if (parsed.username || parsed.password || parsed.port) {
      return null;
    }

    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (XHS_SHORT_LINK_HOSTS.has(hostname)) {
      const pathSegments = parsed.pathname.split("/").filter(Boolean);
      if (pathSegments.length < 2) {
        return null;
      }

      parsed.protocol = "https:";
      parsed.hostname = hostname;
      parsed.hash = "";
      return parsed.toString();
    }

    if (!XHS_NOTE_HOSTS.has(hostname)) {
      return null;
    }

    const notePathMatch = parsed.pathname.match(
      /^\/(discovery\/item|explore|search_result)\/([a-zA-Z0-9]+)\/?$/,
    );
    if (!notePathMatch) {
      return null;
    }

    parsed.protocol = "https:";
    parsed.hostname = "www.xiaohongshu.com";
    parsed.hash = "";
    if (notePathMatch[1] === "explore") {
      parsed.pathname = `/discovery/item/${notePathMatch[2]}`;
    }

    return parsed.toString();
  } catch (_error) {
    return null;
  }
}

function extractXHSURL(text) {
  const candidates =
    String(text || "").match(
      /https?:\/\/[^\s\u200B-\u200D\u2060\uFEFF<>"'`,，。；！？？、)\]}>）】》」』]+/giu,
    ) || [];
  for (const candidate of candidates) {
    const normalized = normalizeXHSURL(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function stripTrailingXHSTopics(title) {
  const original = String(title || "").trim();
  const normalized = original.replace(/(?:&#x20;|&#32;|&nbsp;)/gi, " ");
  const topics = normalized.match(/\s+#[^\s#]+#?(?:\s*#[^\s#]+#?)*\s*$/u);
  if (!topics) return normalized;

  const heading = normalized.slice(0, topics.index).trim();
  return heading && !/^#[^\s#]+#?(?:\s*#[^\s#]+#?)*$/u.test(heading)
    ? heading
    : normalized;
}

function createFieldId() {
  return `field-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function createDefaultFrontmatterFields() {
  return [
    {
      id: createFieldId(),
      key: "aliases",
      value: "",
      enabled: true,
      order: 0,
    },
    {
      id: createFieldId(),
      key: "created",
      value: "{{date}}",
      enabled: true,
      order: 1,
    },
    {
      id: createFieldId(),
      key: "tags",
      value: "- 类型/摘录\n- 状态/待加工",
      enabled: true,
      order: 2,
    },
    {
      id: createFieldId(),
      key: "上级概念",
      value: "",
      enabled: true,
      order: 3,
    },
    {
      id: createFieldId(),
      key: "整理状态",
      value: "待整理",
      enabled: true,
      order: 4,
    },
  ];
}

function splitVaultPath(vaultPath) {
  if (!vaultPath || vaultPath === ".") {
    return [];
  }

  return vaultPath.split("/").filter(Boolean);
}

function getVaultDirname(vaultPath) {
  const parts = splitVaultPath(vaultPath);
  if (parts.length <= 1) {
    return "";
  }

  return parts.slice(0, -1).join("/");
}

function getVaultBasename(vaultPath) {
  const parts = splitVaultPath(vaultPath);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

function getRelativeVaultPath(fromDirectory, toPath) {
  const fromParts = splitVaultPath(fromDirectory);
  const toParts = splitVaultPath(toPath);

  let sharedIndex = 0;
  while (
    sharedIndex < fromParts.length &&
    sharedIndex < toParts.length &&
    fromParts[sharedIndex] === toParts[sharedIndex]
  ) {
    sharedIndex += 1;
  }

  const upSegments = new Array(fromParts.length - sharedIndex).fill("..");
  const downSegments = toParts.slice(sharedIndex);
  const segments = upSegments.concat(downSegments);

  return segments.length > 0 ? segments.join("/") : getVaultBasename(toPath);
}

function extractSubtitleUrls(video) {
  const results = [];
  const seen = new Set();
  const visit = (value, language = "", depth = 0, inSubtitles = false) => {
    if (depth > 7 || value == null) return;
    if (typeof value === "string") {
      if (/^\s*[{[]/.test(value)) {
        try { visit(JSON.parse(value), language, depth + 1, inSubtitles); } catch (_error) {}
        return;
      }
      if (!inSubtitles) return;
      try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        if (url.protocol === "http:") url.protocol = "https:";
        if (url.protocol !== "https:" ||
            !(host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com") ||
              host === "xhscdn.com" || host.endsWith(".xhscdn.com"))) return;
        if (!seen.has(url.href)) {
          seen.add(url.href);
          results.push({ language, url: url.href });
        }
      } catch (_error) {}
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, language, depth + 1, inSubtitles));
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const keyLower = key.toLowerCase();
      const isSubtitleKey = keyLower === "subtitles" || keyLower === "subtitlelist";
      const isUrlKey = /^(url|srturl|subtitleurl|captionurl|sourceurl)$/i.test(key);
      const nextLanguage = /^(source|zh-cn|en-us|zh|en)$/i.test(key)
        ? key : (typeof value.language === "string" ? value.language : language);
      visit(child, nextLanguage, depth + 1, inSubtitles || isSubtitleKey || (inSubtitles && isUrlKey));
    }
  };
  visit(video);
  const rank = (item) => ({ source: 0, "zh-cn": 1, zh: 2, "en-us": 3, en: 4 })[item.language.toLowerCase()] ?? 5;
  return results.sort((a, b) => rank(a) - rank(b));
}

const TRANSCRIPT_START = "<!-- xhs-video-transcript:start -->";
const TRANSCRIPT_END = "<!-- xhs-video-transcript:end -->";
const INSIGHTS_START = "<!-- xhs-ai-insights:start -->";
const INSIGHTS_END = "<!-- xhs-ai-insights:end -->";
const RETRY_DELAYS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];

function normalizeNoteTitle(value) {
  return String(value || "")
    .replace(/^\[V\]/i, "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function numberInsightHeadings(insights) {
  let firstLevel = null;
  let section = 0;
  let subsection = 0;
  return insights.split("\n").map((line) => {
    const match = line.match(/^(#{2,6})\s+(.+)$/);
    if (!match) return line;
    const level = match[1].length;
    if (firstLevel === null) firstLevel = level;
    const title = match[2].trim().replace(/^(?:[一二三四五六七八九十]+[、.．]|\d+(?:\.\d+)*[.、．]?)\s*/u, "");
    if (level <= firstLevel || section === 0) {
      section += 1;
      subsection = 0;
      return `## ${section}. ${title}`;
    }
    subsection += 1;
    return `### ${section}.${subsection} ${title}`;
  }).join("\n");
}

function insertInsights(markdown, summary, insights, noteTitle = "") {
  const short = String(summary || "").trim();
  const detailed = numberInsightHeadings(String(insights || "").trim());
  if (!short || !detailed) throw new Error("AI 没有返回完整的总结和知识提炼");
  const block = `${INSIGHTS_START}\n# 一、总结\n\n${short}\n\n# 二、知识提炼\n\n${detailed}\n${INSIGHTS_END}`;
  const start = markdown.indexOf(INSIGHTS_START);
  const end = markdown.indexOf(INSIGHTS_END);
  let original = markdown;
  if (start !== -1 || end !== -1) {
    if (start < 0 || end < start || markdown.indexOf(INSIGHTS_START, start + 1) !== -1 ||
        markdown.indexOf(INSIGHTS_END, end + 1) !== -1) throw new Error("AI 区块边界不完整");
    const afterEnd = end + INSIGHTS_END.length;
    const before = markdown.slice(0, start);
    const after = markdown.slice(afterEnd);
    original = (before.endsWith("\n") ? before.slice(0, -1) : before) +
      (after.startsWith("\n") ? after.slice(1) : after);
    if (start === 0) original = original.replace(/^\n+/, "");
  }
  const frontmatter = original.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  const afterFrontmatter = frontmatter ? frontmatter[0].length : 0;
  const heading = /^# (.+)(?:\r?\n|$)/m.exec(original.slice(afterFrontmatter));
  if (heading && normalizeNoteTitle(heading[1]) === normalizeNoteTitle(noteTitle)) {
    const position = afterFrontmatter + heading.index;
    original = original.slice(0, position) + original.slice(position + heading[0].length).replace(/^\r?\n/, "");
  }
  const position = afterFrontmatter;
  if (position === 0) return `${block}\n\n${original}`;
  return original.slice(0, position) + `\n${block}\n` + original.slice(position);
}

function insertVideoTranscript(markdown, transcript, method) {
  const text = String(transcript || "").trim();
  if (!text) throw new Error("转录结果为空");
  const block = `${TRANSCRIPT_START}\n## 视频文稿\n\n来源：${method}\n\n${text}\n${TRANSCRIPT_END}`;
  const start = markdown.indexOf(TRANSCRIPT_START);
  const end = markdown.indexOf(TRANSCRIPT_END);
  if (start === -1 && end === -1) return `${markdown.trimEnd()}\n\n${block}\n`;
  if (start === -1 || end < start || markdown.indexOf(TRANSCRIPT_START, start + 1) !== -1 ||
      markdown.indexOf(TRANSCRIPT_END, end + 1) !== -1) {
    throw new Error("原笔记的视频文稿边界不完整");
  }
  return markdown.slice(0, start) + block + markdown.slice(end + TRANSCRIPT_END.length);
}

class XiaohongshuImporterPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.runningTranscripts = new Set();
    this.runningInsights = new Set();
    this.transcriptRetries = this.settings.transcriptRetries || {};

    this.addRibbonIcon("book", "Import Xiaohongshu note", async () => {
      const result = await this.promptForShareText();
      if (!result || !result.text) {
        return;
      }

      const url = this.extractURL(result.text);
      if (!url) {
        new Notice("No valid Xiaohongshu URL found in the text.");
        return;
      }

      await this.importXHSNote(url, result.downloadMedia);
    });

    this.addCommand({
      id: "import",
      name: "Import Xiaohongshu note",
      callback: async () => {
        const result = await this.promptForShareText();
        if (!result || !result.text) {
          return;
        }

        const url = this.extractURL(result.text);
        if (!url) {
          new Notice("No valid Xiaohongshu URL found in the text.");
          return;
        }

        await this.importXHSNote(url, result.downloadMedia);
      },
    });

    this.addCommand({
      id: "retry-current-video-transcript",
      name: "重试当前小红书视频文稿",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !(await this.isImportedVideo(file))) {
          new Notice("请先打开小红书导入的视频笔记");
          return;
        }
        await this.processVideoTranscript(file, true);
      },
    });

    this.addCommand({
      id: "generate-current-note-insights",
      name: "生成或更新当前小红书笔记的总结和知识提炼",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.isImportedNote(file)) {
          new Notice("请先打开小红书导入的笔记");
          return;
        }
        await this.generateInsights(file);
      },
    });

    this.registerInterval(window.setInterval(() => { void this.retryDueTranscripts(); }, 60_000));
    void this.retryDueTranscripts();

    this.addSettingTab(new XiaohongshuSettingTab(this.app, this));
  }

  normalizeFrontmatterFields(fields) {
    const safeFields = Array.isArray(fields) && fields.length > 0 ? fields : createDefaultFrontmatterFields();

    return safeFields
      .map((field, index) => ({
        id: field?.id || createFieldId(),
        key: typeof field?.key === "string" ? field.key : "",
        value: typeof field?.value === "string" ? field.value : "",
        enabled: field?.enabled !== false,
        order: Number.isInteger(field?.order) ? field.order : index,
      }))
      .sort((left, right) => left.order - right.order)
      .map((field, index) => ({
        ...field,
        order: index,
      }));
  }

  async loadSettings() {
    const loadedSettings = (await this.loadData()) || {};
    let shouldSave = false;

    this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedSettings);
    if (!this.settings.transcriptRetries || typeof this.settings.transcriptRetries !== "object" ||
        Array.isArray(this.settings.transcriptRetries)) this.settings.transcriptRetries = {};

    if (!Array.isArray(loadedSettings.frontmatterFields) || loadedSettings.frontmatterFields.length === 0) {
      this.settings.frontmatterFields = createDefaultFrontmatterFields();
      shouldSave = true;
    } else {
      const normalizedFields = this.normalizeFrontmatterFields(loadedSettings.frontmatterFields);
      this.settings.frontmatterFields = normalizedFields;

      const needsNormalization = normalizedFields.some((field, index) => {
        const originalField = loadedSettings.frontmatterFields[index] || {};
        return (
          field.id !== originalField.id ||
          field.order !== originalField.order ||
          field.key !== originalField.key ||
          field.value !== originalField.value ||
          field.enabled !== originalField.enabled
        );
      });

      shouldSave = shouldSave || needsNormalization;
    }

    if (!this.settings.frontmatterFields.some((field) => field.key.trim() === "整理状态")) {
      this.settings.frontmatterFields.push({
        id: createFieldId(),
        key: "整理状态",
        value: "待整理",
        enabled: true,
        order: this.settings.frontmatterFields.length,
      });
      shouldSave = true;
    }

    if (typeof this.settings.noteFolder !== "string") {
      this.settings.noteFolder = DEFAULT_SETTINGS.noteFolder;
      shouldSave = true;
    }

    if (typeof this.settings.imageFolder !== "string") {
      this.settings.imageFolder = DEFAULT_SETTINGS.imageFolder;
      shouldSave = true;
    }

    if (typeof this.settings.downloadMedia !== "boolean") {
      this.settings.downloadMedia = DEFAULT_SETTINGS.downloadMedia;
      shouldSave = true;
    }

    if (shouldSave) {
      await this.saveSettings();
    }
  }

  async saveSettings() {
    this.settings.frontmatterFields = this.normalizeFrontmatterFields(this.settings.frontmatterFields);
    await this.saveData(this.settings);
  }

  async promptForShareText() {
    return new Promise((resolve) => {
      new XiaohongshuImportModal(this.app, this.settings, resolve).open();
    });
  }

  extractURL(text) {
    return extractXHSURL(text);
  }

  sanitizeFilename(text) {
    let sanitized = text.replace(/[^a-zA-Z0-9\u4e00-\u9fa5\s-_]/g, "").trim();
    sanitized = sanitized.replace(/\s+/g, "-");
    sanitized = sanitized.length > 0 ? sanitized : "Untitled";
    return sanitized.substring(0, 50);
  }

  sanitizeNoteFilename(text) {
    let sanitized = text.replace(/[/\\?%*:|"<>]/g, "-").trim();
    sanitized = sanitized.length > 0 ? sanitized : "Untitled";
    return sanitized.substring(0, 50);
  }

  async ensureFolder(folderPath) {
    const normalized = normalizePath(folderPath || "");
    if (!normalized) {
      return;
    }

    if (await this.app.vault.adapter.exists(normalized)) {
      return;
    }

    const parts = normalized.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  buildVaultFilePath(folderPath, fileNameWithExtension) {
    if (!folderPath || folderPath.trim() === "") {
      return normalizePath(fileNameWithExtension);
    }

    return normalizePath(`${folderPath}/${fileNameWithExtension}`);
  }

  async getUniqueFilePath(folderPath, baseName, extension) {
    let candidate = this.buildVaultFilePath(folderPath, `${baseName}.${extension}`);
    let counter = 1;

    while (await this.app.vault.adapter.exists(candidate)) {
      candidate = this.buildVaultFilePath(folderPath, `${baseName}-${counter}.${extension}`);
      counter += 1;
    }

    return candidate;
  }

  async getUniqueMediaPath(folderPath, baseName, extension) {
    let candidate = this.buildVaultFilePath(folderPath, `${baseName}.${extension}`);
    let counter = 1;

    while (await this.app.vault.adapter.exists(candidate)) {
      candidate = this.buildVaultFilePath(folderPath, `${baseName}-${counter}.${extension}`);
      counter += 1;
    }

    return candidate;
  }

  getExtensionFromUrl(url, fallbackExtension) {
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname || "";
      const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
      return match ? match[1].toLowerCase() : fallbackExtension;
    } catch (_error) {
      return fallbackExtension;
    }
  }

  async downloadMediaFile(url, folderPath, filenameBase, fallbackExtension) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }

      const extension = this.getExtensionFromUrl(url, fallbackExtension);
      const targetPath = await this.getUniqueMediaPath(folderPath, filenameBase, extension);
      const bytes = await (await response.blob()).arrayBuffer();

      await this.app.vault.adapter.writeBinary(targetPath, bytes);
      return targetPath;
    } catch (error) {
      console.log(`Failed to download media from ${url}: ${error.message}`);
      new Notice(`Failed to download media: ${error.message}`);
      return url;
    }
  }

  toMarkdownAssetPath(vaultPath) {
    if (vaultPath.startsWith("http")) {
      return vaultPath;
    }

    return normalizePath(vaultPath);
  }

  buildPlaceholderContext({ title, source, date, videoUrl }) {
    return {
      date: date || "",
      title: title || "",
      source: source || "",
      videoUrl: videoUrl || "",
    };
  }

  replacePlaceholders(value, context) {
    return value.replace(/\{\{(date|title|source|videoUrl)\}\}/g, (_match, key) => context[key] || "");
  }

  buildFrontmatter(context) {
    const lines = ["---"];
    const fields = this.normalizeFrontmatterFields(this.settings.frontmatterFields).filter((field) => field.enabled);

    for (const field of fields) {
      const key = (field.key || "").trim();
      if (!key) {
        continue;
      }

      const resolvedValue = this.replacePlaceholders(field.value || "", context);
      if (resolvedValue.trim() === "") {
        lines.push(`${key}:`);
        continue;
      }

      if (resolvedValue.includes("\n")) {
        lines.push(`${key}:`);
        for (const line of resolvedValue.split("\n")) {
          lines.push(`  ${line}`);
        }
        continue;
      }

      lines.push(`${key}: ${resolvedValue}`);
    }

    lines.push("---");
    return `${lines.join("\n")}\n`;
  }

  async importXHSNote(url, downloadMedia) {
    try {
      const html = (
        await requestUrl({
          url,
          headers: { ...XHS_REQUEST_HEADERS },
        })
      ).text;
      const note = this.getNoteDetail(html);
      if (!note) {
        throw new Error(
          "Xiaohongshu returned no note data. The share link may have expired or the page format may have changed.",
        );
      }

      const title = this.extractTitle(html, note);
      const videoUrl = this.extractVideoUrl(html, note);
      const images = this.extractImages(html, note);
      const content = this.extractContent(html, note);
      const isVideo = this.isVideoNote(html, note);
      const today = new Date().toISOString().split("T")[0];

      const noteFolder = (this.settings.noteFolder || "").trim();
      const imageFolder = (this.settings.imageFolder || "").trim();
      await this.ensureFolder(noteFolder);
      if (downloadMedia && !isVideo) {
        await this.ensureFolder(imageFolder);
      }

      const sanitizedTitle = this.sanitizeFilename(title);
      const noteBaseName = this.sanitizeNoteFilename(title);
      const notePath = await this.getUniqueFilePath(noteFolder, noteBaseName, "md");
      const frontmatterContext = this.buildPlaceholderContext({
        title,
        source: url,
        date: today,
        videoUrl,
      });

      let markdown = `${this.buildFrontmatter(frontmatterContext)}\n`;

      if (isVideo) {
        if (videoUrl) {
          markdown += `[Video Link](${videoUrl})\n\n`;
        } else {
          new Notice("Video URL not found; imported note without a video link.");
        }

        // Save video inputs so the local transcription process can run after import.
        const transcriptData = {
          version: 1,
          source: url,
          videoUrl: videoUrl || null,
          subtitleUrls: extractSubtitleUrls(note.video),
        };
        markdown += `<!-- xhs-transcript-data ${JSON.stringify(transcriptData)} -->\n\n`;

        const cleanedContent = content.replace(/#\S+/g, "").trim();
        markdown += `${cleanedContent.split("\n").join("\n")}\n\n`;

      } else {
        let localImagePaths = [];
        if (images.length > 0) {
          if (downloadMedia) {
            for (let index = 0; index < images.length; index += 1) {
              const downloadedImage = await this.downloadMediaFile(
                images[index],
                imageFolder,
                `${sanitizedTitle}-${index}`,
                "jpg",
              );
              localImagePaths.push(this.toMarkdownAssetPath(downloadedImage));
            }
          } else {
            localImagePaths = images;
          }

          markdown += `![Cover Image](${localImagePaths[0]})\n\n`;
        }

        const cleanedContent = content.replace(/#[^#\s]*(?:\s+#[^#\s]*)*\s*/g, "").trim();
        markdown += `${cleanedContent.split("\n").join("\n")}\n\n`;

        if (localImagePaths.length > 0) {
          markdown += `${localImagePaths.map((assetPath) => `![Image](${assetPath})`).join("\n")}\n`;
        }
      }

      const createdFile = await this.app.vault.create(notePath, markdown);
      await this.app.workspace.getLeaf(true).openFile(createdFile);
      await this.saveSettings();
      if (isVideo) {
        new Notice("视频笔记已导入，正在生成文稿…");
        await this.processVideoTranscript(createdFile, false);
      } else {
        new Notice(`Imported Xiaohongshu note as ${notePath}`);
        void this.generateInsights(createdFile);
      }
    } catch (error) {
      console.log(`Failed to import note from ${url}: ${error.message}`);
      new Notice(`Failed to import note: ${error.message}`);
    }
  }

  isImportedNote(file) {
    const folder = (this.settings.noteFolder || "").replace(/\/+$/, "");
    return file?.extension === "md" && file.parent?.path === folder;
  }

  async isImportedVideo(file) {
    if (!this.isImportedNote(file)) return false;
    const text = await this.app.vault.cachedRead(file);
    return text.includes("<!-- xhs-transcript-data ") || text.includes("[Video Link](");
  }

  async processVideoTranscript(file, manual) {
    if (this.runningTranscripts.has(file.path)) return;
    this.runningTranscripts.add(file.path);
    try {
      const method = await this.transcribeImportedVideo(file);
      delete this.transcriptRetries[file.path];
      await this.saveSettings();
      new Notice(`视频文稿已写入原笔记（${method}）`);
      void this.generateInsights(file);
    } catch (error) {
      console.error("Failed to transcribe imported video:", error);
      const attempt = manual ? 0 : (this.transcriptRetries[file.path]?.attempt || 0);
      if (attempt < RETRY_DELAYS.length) {
        this.transcriptRetries[file.path] = {
          attempt: attempt + 1,
          nextAt: Date.now() + RETRY_DELAYS[attempt],
        };
        await this.saveSettings();
        new Notice(`文稿生成失败，稍后自动重试：${error.message}`);
      } else {
        delete this.transcriptRetries[file.path];
        await this.saveSettings();
        new Notice(`文稿生成失败，可用命令“重试当前小红书视频文稿”：${error.message}`);
      }
    } finally {
      this.runningTranscripts.delete(file.path);
    }
  }

  async retryDueTranscripts() {
    for (const [notePath, state] of Object.entries(this.transcriptRetries)) {
      if (!state || !Number.isFinite(state.nextAt) || state.nextAt > Date.now()) continue;
      const file = this.app.vault.getAbstractFileByPath(notePath);
      if (!file || !(await this.isImportedVideo(file))) {
        delete this.transcriptRetries[notePath];
        await this.saveSettings();
        continue;
      }
      const text = await this.app.vault.cachedRead(file);
      if (text.includes(TRANSCRIPT_START)) {
        delete this.transcriptRetries[notePath];
        await this.saveSettings();
        continue;
      }
      if (!this.runningTranscripts.has(notePath)) {
        this.transcriptRetries[notePath].nextAt = Date.now() + 60_000;
        await this.saveSettings();
        await this.processVideoTranscript(file, false);
      }
    }
  }

  async generateInsights(file) {
    if (this.runningInsights.has(file.path)) return;
    this.runningInsights.add(file.path);
    const { spawn } = require("child_process");
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    let tempDir;
    try {
      const vaultPath = this.app.vault.adapter.getBasePath?.();
      if (!vaultPath) throw new Error("AI 总结需要桌面版 Obsidian");
      const skill = path.join(os.homedir(), ".codex", "skills", "xhs-note-insights", "SKILL.md");
      if (!fs.existsSync(skill)) throw new Error("未安装 xhs-note-insights Skill");
      const appCodex = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
      const codex = process.env.CODEX_BIN || (fs.existsSync(appCodex) ? appCodex : "codex");
      const note = path.join(vaultPath, file.path);
      const source = await this.app.vault.cachedRead(file);
      if (source.includes("<!-- xhs-transcript-data ") && !source.includes(TRANSCRIPT_START)) {
        throw new Error("视频文稿尚未完成，暂不生成总结");
      }
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-insights-"));
      const outputPath = path.join(tempDir, "result.json");
      const schemaPath = path.join(tempDir, "schema.json");
      fs.writeFileSync(schemaPath, JSON.stringify({
        type: "object",
        properties: { summary: { type: "string" }, insights: { type: "string" } },
        required: ["summary", "insights"],
        additionalProperties: false,
      }));
      const prompt = `阅读 ${skill}，严格按照该 Skill 处理笔记 ${note}。只输出 JSON 对象，字段为 summary 和 insights；不要直接修改文件。`;
      await new Promise((resolve, reject) => {
        const child = spawn(codex, ["exec", "-C", vaultPath, "--sandbox", "read-only", "--skip-git-repo-check", "--output-schema", schemaPath, "--output-last-message", outputPath, prompt], {
          cwd: vaultPath, stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1000); });
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim().slice(-300) || `Codex 退出：${code}`)));
      });
      const result = JSON.parse(fs.readFileSync(outputPath, "utf8"));
      if (typeof result.summary !== "string" || typeof result.insights !== "string") {
        throw new Error("AI 返回格式不正确");
      }
      await this.app.vault.process(file, (current) => insertInsights(current, result.summary, result.insights, file.basename));
      new Notice("总结和知识提炼已写入当前笔记");
    } catch (error) {
      console.error("Failed to generate insights:", error);
      new Notice(`AI 总结未完成：${error.message}`);
    } finally {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      this.runningInsights.delete(file.path);
    }
  }

  async transcribeImportedVideo(file) {
    const { spawn } = require("child_process");
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const vaultPath = this.app.vault.adapter.getBasePath?.();
    if (!vaultPath) throw new Error("自动转录需要桌面版 Obsidian");
    const pluginDir = path.join(vaultPath, this.app.vault.configDir, "plugins", this.manifest.id);
    const script = path.join(pluginDir, "transcribe_note.py");
    const localPython = path.join(os.homedir(), "Library", "Application Support", "xhs-importer-transcript", ".venv", "bin", "python");
    const legacyPython = path.join(os.homedir(), ".codex", "skills", "xhs-video-transcript", ".venv", "bin", "python");
    const python = fs.existsSync(localPython) ? localPython :
      (fs.existsSync(legacyPython) ? legacyPython : "python3");
    if (!fs.existsSync(script)) throw new Error("转录程序未安装完整");
    const note = path.join(vaultPath, file.path);
    const output = await new Promise((resolve, reject) => {
      const child = spawn(python, [script, "--vault", vaultPath, "--note", note, "--stdout"], {
        cwd: pluginDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error((stderr || stdout).trim().slice(-300) || `转录进程退出：${code}`));
        } else {
          resolve(stdout);
        }
      });
    });
    const resultLine = output.split("\n").find((line) => line.startsWith("XHS_TRANSCRIPT_JSON:"));
    if (!resultLine) throw new Error("转录进程没有返回文稿");
    const result = JSON.parse(resultLine.slice("XHS_TRANSCRIPT_JSON:".length));
    if (!["小红书平台字幕", "本地语音转录"].includes(result.method)) {
      throw new Error("转录来源不明");
    }
    await this.app.vault.process(file, (current) => insertVideoTranscript(current, result.transcript, result.method));
    return result.method;
  }

  extractTitle(html, note = this.getNoteDetail(html)) {
    const noteTitle = typeof note?.title === "string" ? note.title.trim() : "";
    if (noteTitle) {
      return stripTrailingXHSTopics(noteTitle);
    }

    const match = html.match(/<title>(.*?)<\/title>/);
    return match ? stripTrailingXHSTopics(match[1].replace(" - 小红书", "")) : "Untitled Xiaohongshu Note";
  }

  parseInitialState(html) {
    const match = html.match(/window\.__INITIAL_STATE__=(.*?)<\/script>/s);
    if (!match) {
      return null;
    }

    try {
      const json = match[1].trim().replace(/undefined/g, "null");
      return JSON.parse(json);
    } catch (error) {
      console.log(`Failed to parse initial state: ${error.message}`);
      return null;
    }
  }

  getNoteDetail(html) {
    const state = this.parseInitialState(html);
    if (!state?.note?.noteDetailMap) {
      return null;
    }

    return (
      Object.values(state.note.noteDetailMap)
        .map((entry) => entry?.note)
        .find(Boolean) || null
    );
  }

  extractImages(html, note = this.getNoteDetail(html)) {
    if (!note?.imageList) {
      return [];
    }

    return note.imageList
      .map((image) => image.urlDefault || "")
      .filter((imageUrl) => imageUrl && imageUrl.startsWith("http"));
  }

  extractVideoUrl(html, note = this.getNoteDetail(html)) {
    const video = note?.video;

    if (!video?.media?.stream) {
      return null;
    }

    if (video.media.stream.h264 && video.media.stream.h264.length > 0) {
      return video.media.stream.h264[0].masterUrl || null;
    }

    if (video.media.stream.h265 && video.media.stream.h265.length > 0) {
      return video.media.stream.h265[0].masterUrl || null;
    }

    return null;
  }

  extractContent(html, note = this.getNoteDetail(html)) {
    const htmlMatch = html.match(/<div id="detail-desc" class="desc">([\s\S]*?)<\/div>/);
    if (htmlMatch) {
      return (
        htmlMatch[1]
          .replace(/<[^>]+>/g, "")
          .replace(/\[话题\]/g, "")
          .replace(/\[[^\]]+\]/g, "")
          .trim() || "Content not found"
      );
    }

    if (!note?.desc) {
      return "Content not found";
    }

    return (
      note.desc
        .replace(/\[话题\]/g, "")
        .replace(/\[[^\]]+\]/g, "")
        .trim() || "Content not found"
    );
  }

  isVideoNote(html, note = this.getNoteDetail(html)) {
    return note?.type === "video";
  }

  extractTags(text) {
    return (text.match(/#\S+/g) || []).map((tag) => tag.replace("#", "").trim());
  }
}

class XiaohongshuSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async moveField(index, direction) {
    const fields = this.plugin.normalizeFrontmatterFields(this.plugin.settings.frontmatterFields);
    const targetIndex = index + direction;

    if (targetIndex < 0 || targetIndex >= fields.length) {
      return;
    }

    [fields[index], fields[targetIndex]] = [fields[targetIndex], fields[index]];
    this.plugin.settings.frontmatterFields = fields.map((field, order) => ({
      ...field,
      order,
    }));

    await this.plugin.saveSettings();
    this.display();
  }

  async deleteField(index) {
    const fields = this.plugin.normalizeFrontmatterFields(this.plugin.settings.frontmatterFields);
    fields.splice(index, 1);
    this.plugin.settings.frontmatterFields = fields.map((field, order) => ({
      ...field,
      order,
    }));
    await this.plugin.saveSettings();
    this.display();
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Default note folder")
      .setDesc("Imported notes will use this folder by default.")
      .addText((text) =>
        text.setPlaceholder("00.收集箱").setValue(this.plugin.settings.noteFolder).onChange(async (value) => {
          this.plugin.settings.noteFolder = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Default image folder")
      .setDesc("Downloaded images will use this folder by default.")
      .addText((text) =>
        text.setPlaceholder("附件/XHS").setValue(this.plugin.settings.imageFolder).onChange(async (value) => {
          this.plugin.settings.imageFolder = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Download images")
      .setDesc("If enabled, note images are downloaded to the local vault. Videos remain remote links.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.downloadMedia).onChange(async (value) => {
          this.plugin.settings.downloadMedia = value;
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl("h3", { text: "Frontmatter Fields" });
    containerEl.createEl("p", {
      text: "Supported placeholders: {{date}}, {{title}}, {{source}}, {{videoUrl}}.",
      cls: "xhs-frontmatter-hint",
    });

    const fields = this.plugin.normalizeFrontmatterFields(this.plugin.settings.frontmatterFields);
    fields.forEach((field, index) => {
      const fieldContainer = containerEl.createDiv({ cls: "xhs-field-setting" });

      new Setting(fieldContainer)
        .setName(`Field ${index + 1}`)
        .setDesc("Edit the field key, enable state, and order.")
        .addText((text) =>
          text.setPlaceholder("Field key").setValue(field.key).onChange(async (value) => {
            this.plugin.settings.frontmatterFields[index].key = value.trim();
            await this.plugin.saveSettings();
          }),
        )
        .addToggle((toggle) =>
          toggle.setTooltip("Enable field").setValue(field.enabled).onChange(async (value) => {
            this.plugin.settings.frontmatterFields[index].enabled = value;
            await this.plugin.saveSettings();
          }),
        )
        .addButton((button) =>
          button.setIcon("arrow-up").setTooltip("Move up").setDisabled(index === 0).onClick(async () => {
            await this.moveField(index, -1);
          }),
        )
        .addButton((button) =>
          button
            .setIcon("arrow-down")
            .setTooltip("Move down")
            .setDisabled(index === fields.length - 1)
            .onClick(async () => {
              await this.moveField(index, 1);
            }),
        )
        .addButton((button) =>
          button.setButtonText("Remove").setWarning().onClick(async () => {
            await this.deleteField(index);
          }),
        );

      const valueWrapper = fieldContainer.createDiv({ cls: "xhs-field-value-wrapper" });
      valueWrapper.createEl("label", {
        text: "Default value (raw YAML value, multiline supported)",
        cls: "xhs-field-value-label",
      });

      const textarea = valueWrapper.createEl("textarea", { cls: "xhs-field-value" });
      textarea.value = field.value;
      textarea.rows = Math.max(3, field.value.split("\n").length + 1);
      textarea.addEventListener("change", async () => {
        this.plugin.settings.frontmatterFields[index].value = textarea.value;
        await this.plugin.saveSettings();
      });
    });

    new Setting(containerEl).addButton((button) =>
      button.setButtonText("Add field").onClick(async () => {
        this.plugin.settings.frontmatterFields.push({
          id: createFieldId(),
          key: "newField",
          value: "",
          enabled: true,
          order: this.plugin.settings.frontmatterFields.length,
        });
        await this.plugin.saveSettings();
        this.display();
      }),
    );
  }
}

class XiaohongshuImportModal extends Modal {
  constructor(app, settings, onSubmit) {
    super(app);
    this.settings = settings;
    this.onSubmit = onSubmit;
    this.result = null;
    this.downloadMedia = settings.downloadMedia;
  }

  onOpen() {
    const { contentEl } = this;

    contentEl.addClass("xhs-modal-content");
    contentEl.createEl("h2", { text: "Import Xiaohongshu note" });

    const textRow = contentEl.createEl("div", { cls: "xhs-modal-row" });
    textRow.createEl("p", { text: "Paste the share text below:" });
    const textarea = textRow.createEl("textarea", {
      cls: "xhs-modal-textarea",
      attr: {
        placeholder: "e.g., 64 不叫小黄了发布了一篇小红书笔记...",
      },
    });

    const toggleWrapper = contentEl
      .createEl("div", { cls: ["xhs-modal-row", "xhs-download-row"] })
      .createEl("div", { cls: "xhs-download-wrapper" });

    const checkboxId = "download-media-checkbox";
    const checkbox = toggleWrapper.createEl("input", {
      attr: { type: "checkbox", id: checkboxId },
    });
    checkbox.checked = this.downloadMedia;
    checkbox.addEventListener("change", () => {
      this.downloadMedia = checkbox.checked;
    });

    toggleWrapper.createEl("label", {
      text: "Download images locally for this import",
      cls: "xhs-download-label",
      attr: { for: checkboxId },
    });

    contentEl
      .createEl("div", { cls: ["xhs-modal-row", "xhs-button-row"] })
      .createEl("button", { text: "Import", cls: "xhs-submit-button" })
      .addEventListener("click", () => {
        this.result = {
          text: textarea.value.trim(),
          downloadMedia: this.downloadMedia,
        };
        this.close();
      });

    textarea.addEventListener("keypress", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.result = {
          text: textarea.value.trim(),
          downloadMedia: this.downloadMedia,
        };
        this.close();
      }
    });
  }

  onClose() {
    this.onSubmit(this.result);
  }
}

module.exports = {
  default: XiaohongshuImporterPlugin,
  __test: {
    XHS_REQUEST_HEADERS,
    cleanURLCandidate,
    extractXHSURL,
    normalizeXHSURL,
    stripTrailingXHSTopics,
    extractSubtitleUrls,
    insertVideoTranscript,
    insertInsights,
  },
};

/* nosourcemap */
