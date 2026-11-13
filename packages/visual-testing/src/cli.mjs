#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { resolveAnalysisModel } from "./pi-model.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(process.env.SLOCK_VISUAL_REPO_ROOT || findRepoRoot(process.cwd()));
const repoHasWebPackage = fs.existsSync(path.join(repoRoot, "packages", "web", "package.json"));
const defaultReactRepoRoot = repoHasWebPackage ? repoRoot : path.join(repoRoot, "third_party", "slock-source");
const defaultAndroidRepoRoot = path.resolve(
  initialFlagValue(["android-repo-dir", "androidRepoDir"]) ||
    process.env.SLOCK_ANDROID_REPO_DIR ||
    (repoHasWebPackage ? path.join(repoRoot, "../..") : repoRoot),
);
const reactRepoRoot = path.resolve(
  initialFlagValue(["react-repo-dir", "reactRepoDir"]) ||
    process.env.SLOCK_REACT_REPO_DIR ||
    process.env.SLOCK_VISUAL_REACT_REPO_ROOT ||
    defaultReactRepoRoot,
);
const webRoot = path.join(reactRepoRoot, "packages", "web");
const srcRoot = path.join(webRoot, "src");
const sharedVisualRoot = path.join(packageRoot, "shared");
const artifactRoot = path.join(repoRoot, "artifacts", "visual-testing");
const resultRoot = path.join(repoRoot, "visual-testing-results");
const siteRoot = path.join(repoRoot, "artifacts", "visual-testing-site");
const sharedTokensPath = path.join(sharedVisualRoot, "sharedTokens.json");
const sharedCasesPath = path.join(sharedVisualRoot, "sharedCases.json");
const tokenAuditClassificationPath = path.join(sharedVisualRoot, "tokenAuditColorClassifications.json");
const defaultManifestPath = path.join(artifactRoot, "visual-testing-cases.json");
const inventoryPath = path.join(artifactRoot, "react-component-inventory.json");
const providerSpecPath = path.join(artifactRoot, "provider-spec.json");
const sharpImageDiffScriptPath = path.join(packageRoot, "src", "sharp-image-diff.mjs");
const fullLengthTrimScriptPath = path.join(packageRoot, "src", "full-length-trim.mjs");
const sharpImageOverlayScriptPath = path.join(packageRoot, "src", "sharp-image-overlay.mjs");
const analysisRoot = path.join(resultRoot, "analysis");
const analyzeConcurrencyLimit = 6;
// Pass/basic-pass thresholds are configured per pair class (spec:
// provider-pair-first, Resolved review decisions #3): baseline and
// cross-platform are two slots that START with identical values — the
// sameness is a configuration choice, never hard-coded into the model.
// Cross-platform thresholds get revisited once android__ios data accumulates.
const pairClassTolerances = {
  baseline: { pixelPerfectPass: 0.99, pixelPerfectBasicPass: 0.96 },
  "cross-platform": { pixelPerfectPass: 0.99, pixelPerfectBasicPass: 0.96 },
};
const componentFixtureCaptureType = "component-fixture";
const realScreenCaptureType = "real-screen";
const captureTypeValues = new Set([componentFixtureCaptureType, realScreenCaptureType]);
const captureTypeLabels = {
  [componentFixtureCaptureType]: "Components Parity",
  [realScreenCaptureType]: "Screens Parity",
};
const captureTypeSegments = {
  [componentFixtureCaptureType]: "components",
  [realScreenCaptureType]: "screens",
};
const defaultKmpTokenPath = path.join(
  "compose",
  "shared",
  "src",
  "commonMain",
  "kotlin",
  "ai",
  "slock",
  "compose",
  "SlockDesignTokens.kt"
);
const tokenKmpColorMap = {
  brutalYellow: "BrandYellow",
  brutalPink: "AccentPink",
  brutalLavender: "AccentLavender",
  brutalCream: "SurfaceCream",
  brutalBlack: "ShadowBlack",
  brutalCyan: "AccentCyan",
  brutalOrange: "AccentOrange",
  brutalLime: "AccentLime",
  brutalRed: "AccentRed",
  brutalStone: "AccentStone",
  surfaceWhite: "SurfaceWhite",
  surfaceCream: "SurfaceCream",
  appBgLightBlue: "AppBgLightBlue",
  emptyStateGray: "EmptyStateGray",
  textBlack: "TextBlack",
  textMutedGray: "TextMutedGray",
  borderBlack: "BorderBlack",
  shadowBlack: "ShadowBlack",
};
const tokenAuditAllowedReactFiles = new Set([
  "packages/web/src/index.css",
  "packages/visual-testing/shared/sharedTokens.json",
  "packages/visual-testing/shared/tokenAuditColorClassifications.json",
  "packages/web/src/pages/PaletteAuditPage.tsx",
  "packages/web/src/components/agent/PixelAvatar.tsx",
]);
const tokenAuditAllowedKmpFiles = new Set([
  defaultKmpTokenPath,
  path.join("compose", "shared", "src", "commonMain", "kotlin", "ai", "slock", "compose", "TokenPaletteVisualPage.kt"),
  path.join("compose", "shared", "src", "commonMain", "kotlin", "ai", "slock", "compose", "ReverseLazyColumnDemoPage.kt"),
]);

function initialFlagValue(names) {
  const wanted = new Set(names.map((name) => `--${name}`));
  for (let index = 2; index < process.argv.length - 1; index += 1) {
    if (wanted.has(process.argv[index]) && !process.argv[index + 1].startsWith("--")) return process.argv[index + 1];
  }
  return "";
}

const defaultCases = [
  {
    id: "home.left-rail.default",
    surface: "home",
    reactPathHint: "packages/web/src/components/layout/LeftRail.tsx",
    androidCaseHint: "compose_home_left_rail_default",
    selector: "[data-testid='left-rail-tab-chat']",
  },
  {
    id: "home.server-switcher.unread",
    surface: "home",
    reactPathHint: "packages/web/src/components/ui/ServerSwitcherMenu.tsx",
    androidCaseHint: "compose_home_server_switcher_unread",
    selector: "[data-testid='desktop-server-switcher-menu']",
  },
  {
    id: "home.sidebar.channels-expanded",
    surface: "home",
    reactPathHint: "packages/web/src/features/sidebar/Sidebar.tsx",
    androidCaseHint: "compose_home_sidebar_channels_expanded",
    selector: "[data-testid='sidebar-section-toggle-channels']",
  },
  {
    id: "thread.message.markdown-chips",
    surface: "thread",
    reactPathHint: "packages/web/src/components/message/MessageItem.tsx",
    androidCaseHint: "compose_thread_message_markdown_chips",
    selector: "[data-testid='message-thread-replies-badge']",
  },
  {
    id: "navigation.tabbar.badges",
    surface: "navigation",
    reactPathHint: "packages/web/src/components/layout/mobile/MobileShell.tsx",
    androidCaseHint: "compose_bottom_tabbar_badges",
    selector: "[data-visual-case='navigation.tabbar.badges']",
  },
];

function parseArgs(argv) {
  const args = { command: argv[2] || "all", flags: {} };
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args.flags[key] = true;
    } else {
      args.flags[key] = next;
      i += 1;
    }
  }
  return args;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.stdio || "inherit",
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    encoding: options.encoding,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
  return result;
}

function findRepoRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml")) || fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return startDir;
    current = parent;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function parseTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return null;
    const millis = numeric < 100000000000 ? numeric * 1000 : numeric;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function utcTimestampText(value) {
  const date = parseTimestamp(value);
  if (!date) return value ? String(value) : "unknown";
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function localizedTimestampHtml(value, options = {}) {
  const date = parseTimestamp(value);
  const label = options.label ? `${options.label} ` : "";
  if (!date) return `${xmlEscape(label)}${xmlEscape(value ? String(value) : "unknown")}`;
  const iso = date.toISOString();
  return `${xmlEscape(label)}<time class="localizedTime" datetime="${xmlEscape(iso)}" data-timestamp="${xmlEscape(iso)}" title="${xmlEscape(String(value))}">${xmlEscape(utcTimestampText(iso))}</time>`;
}

function localizedTimeScript() {
  return `<script>
    (() => {
      const formatter = new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      });
      for (const node of document.querySelectorAll("time.localizedTime[data-timestamp]")) {
        const date = new Date(node.dataset.timestamp);
        if (!Number.isNaN(date.getTime())) node.textContent = formatter.format(date);
      }
    })();
  </script>`;
}

function overlayComparisonScript() {
  return `<script>
    (() => {
      const loadImage = (src) => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Unable to load overlay image: " + src));
        image.src = src;
      });
      const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
      const sliderValue = (panel, selector, fallback) => {
        const value = Number(panel.querySelector(selector)?.value ?? fallback);
        return Number.isFinite(value) ? clamp(value / 100, 0, 1) : fallback / 100;
      };
      const snapValue = (value, size) => {
        const snapPoints = [0, -size, -size / 2, size / 2, size];
        const threshold = Math.max(4, size * 0.02);
        for (const point of snapPoints) {
          if (Math.abs(value - point) <= threshold) return point;
        }
        return value;
      };
      const snappedOffset = (panel, x, y, width, height) => {
        if (!panel.querySelector("[data-overlay-snap]")?.checked) return { x, y };
        return {
          x: snapValue(x, width),
          y: snapValue(y, height),
        };
      };

      const drawOverlay = (panel, baselineImage, currentImage) => {
        const canvas = panel.querySelector("canvas[data-overlay-canvas]");
        if (!canvas) return;
        const context = canvas.getContext("2d");
        if (!context) return;
        const width = Number(panel.dataset.overlayWidth) || baselineImage.naturalWidth || currentImage.naturalWidth;
        const height = Number(panel.dataset.overlayHeight) || baselineImage.naturalHeight || currentImage.naturalHeight;
        const mode = panel.querySelector("[data-overlay-mode]")?.value || "blend";
        const baselineOpacity = sliderValue(panel, "[data-overlay-baseline-opacity]", 100);
        const currentOpacity = sliderValue(panel, "[data-overlay-opacity]", 50);
        const split = Math.max(0, Math.min(1, Number(panel.dataset.overlaySplit || 0.5)));
        const offsetX = Number(panel.dataset.overlayOffsetX || 0);
        const offsetY = Number(panel.dataset.overlayOffsetY || 0);
        panel.dataset.overlayMode = mode;
        canvas.width = width;
        canvas.height = height;
        context.clearRect(0, 0, width, height);
        context.globalAlpha = baselineOpacity;
        context.globalCompositeOperation = "source-over";
        context.drawImage(baselineImage, 0, 0, width, height);
        context.save();
        context.globalAlpha = mode === "split" ? 1 : currentOpacity;
        context.globalCompositeOperation = mode === "difference" ? "difference" : "source-over";
        if (mode === "split") {
          context.beginPath();
          context.rect(0, 0, Math.round(width * split), height);
          context.clip();
          context.globalAlpha = 1;
        }
        context.drawImage(currentImage, mode === "align" ? offsetX : 0, mode === "align" ? offsetY : 0, width, height);
        context.restore();
        if (mode === "split") {
          const x = Math.round(width * split);
          context.save();
          context.strokeStyle = "#141111";
          context.lineWidth = Math.max(2, Math.round(width / 160));
          context.beginPath();
          context.moveTo(x, 0);
          context.lineTo(x, height);
          context.stroke();
          context.fillStyle = "#FFD440";
          context.strokeStyle = "#141111";
          context.lineWidth = Math.max(1, Math.round(width / 300));
          context.beginPath();
          context.arc(x, Math.max(20, Math.round(height * 0.08)), Math.max(8, Math.round(width / 36)), 0, Math.PI * 2);
          context.fill();
          context.stroke();
          context.restore();
        }
        if (mode === "align") {
          context.save();
          context.strokeStyle = "rgba(20, 17, 17, 0.35)";
          context.lineWidth = Math.max(1, Math.round(width / 300));
          context.setLineDash([6, 6]);
          context.beginPath();
          context.moveTo(width / 2, 0);
          context.lineTo(width / 2, height);
          context.moveTo(0, height / 2);
          context.lineTo(width, height / 2);
          context.stroke();
          context.setLineDash([]);
          context.strokeStyle = "#141111";
          context.fillStyle = "#FFD440";
          context.lineWidth = Math.max(2, Math.round(width / 180));
          context.strokeRect(offsetX, offsetY, width, height);
          context.beginPath();
          context.arc(clamp(offsetX + width / 2, 12, width - 12), clamp(offsetY + height * 0.08, 12, height - 12), Math.max(8, Math.round(width / 40)), 0, Math.PI * 2);
          context.fill();
          context.stroke();
          context.restore();
        }
        const baselineValueLabel = panel.querySelector("[data-overlay-baseline-opacity-value]");
        if (baselineValueLabel) baselineValueLabel.textContent = Math.round(baselineOpacity * 100) + "%";
        const valueLabel = panel.querySelector("[data-overlay-opacity-value]");
        if (valueLabel) valueLabel.textContent = Math.round(currentOpacity * 100) + "%";
        const splitLabel = panel.querySelector("[data-overlay-split-value]");
        if (splitLabel) splitLabel.textContent = Math.round(split * 100) + "%";
        const offsetLabel = panel.querySelector("[data-overlay-offset-value]");
        if (offsetLabel) offsetLabel.textContent = Math.round(offsetX) + "px, " + Math.round(offsetY) + "px";
      };

      const initPanel = (panel) => {
        if (!panel || panel.dataset.overlayReady === "1") return;
        const canvas = panel.querySelector("canvas[data-overlay-canvas]");
        if (!canvas) return;
        panel.dataset.overlayReady = "1";
        Promise.all([
          loadImage(panel.dataset.baselineSrc),
          loadImage(panel.dataset.currentSrc),
        ]).then(([baselineImage, currentImage]) => {
          const redraw = () => drawOverlay(panel, baselineImage, currentImage);
          const updateSplitFromPointer = (event) => {
            const rect = canvas.getBoundingClientRect();
            if (!rect.width) return;
            panel.dataset.overlaySplit = String(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)));
            redraw();
          };
          const beginAlignDrag = (event) => {
            const rect = canvas.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            panel.dataset.overlayDragClientX = String(event.clientX);
            panel.dataset.overlayDragClientY = String(event.clientY);
            panel.dataset.overlayDragStartX = String(Number(panel.dataset.overlayOffsetX || 0));
            panel.dataset.overlayDragStartY = String(Number(panel.dataset.overlayOffsetY || 0));
            panel.dataset.overlayDragScaleX = String(canvas.width / rect.width);
            panel.dataset.overlayDragScaleY = String(canvas.height / rect.height);
          };
          const updateAlignFromPointer = (event) => {
            const startClientX = Number(panel.dataset.overlayDragClientX || event.clientX);
            const startClientY = Number(panel.dataset.overlayDragClientY || event.clientY);
            const startX = Number(panel.dataset.overlayDragStartX || 0);
            const startY = Number(panel.dataset.overlayDragStartY || 0);
            const scaleX = Number(panel.dataset.overlayDragScaleX || 1);
            const scaleY = Number(panel.dataset.overlayDragScaleY || 1);
            const next = snappedOffset(
              panel,
              startX + (event.clientX - startClientX) * scaleX,
              startY + (event.clientY - startClientY) * scaleY,
              canvas.width,
              canvas.height,
            );
            panel.dataset.overlayOffsetX = String(next.x);
            panel.dataset.overlayOffsetY = String(next.y);
            redraw();
          };
          panel.querySelector("[data-overlay-mode]")?.addEventListener("change", redraw);
          panel.querySelector("[data-overlay-opacity]")?.addEventListener("input", redraw);
          panel.querySelector("[data-overlay-baseline-opacity]")?.addEventListener("input", redraw);
          panel.querySelector("[data-overlay-snap]")?.addEventListener("change", redraw);
          panel.querySelector("[data-overlay-reset]")?.addEventListener("click", () => {
            panel.dataset.overlayOffsetX = "0";
            panel.dataset.overlayOffsetY = "0";
            panel.dataset.overlaySplit = "0.5";
            redraw();
          });
          canvas.addEventListener("pointerdown", (event) => {
            const currentMode = panel.querySelector("[data-overlay-mode]")?.value;
            if (currentMode !== "split" && currentMode !== "align") return;
            canvas.setPointerCapture(event.pointerId);
            if (currentMode === "split") {
              updateSplitFromPointer(event);
            } else {
              beginAlignDrag(event);
              updateAlignFromPointer(event);
            }
          });
          canvas.addEventListener("pointermove", (event) => {
            const currentMode = panel.querySelector("[data-overlay-mode]")?.value;
            if (currentMode !== "split" && currentMode !== "align") return;
            if (!canvas.hasPointerCapture(event.pointerId)) return;
            if (currentMode === "split") updateSplitFromPointer(event);
            else updateAlignFromPointer(event);
          });
          canvas.addEventListener("pointerup", (event) => {
            if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
          });
          canvas.addEventListener("pointercancel", (event) => {
            if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
          });
          redraw();
        }).catch((error) => {
          panel.dataset.overlayReady = "";
          const status = panel.querySelector("[data-overlay-status]");
          if (status) status.textContent = error.message;
        });
      };

      // Expose the per-panel initializer so client-rendered pages (e.g. the
      // Storybook-style homepage that swaps cases in the DOM) can wire an
      // overlay panel that was not present at load time.
      window.__slockInitOverlayComparison = initPanel;

      for (const panel of document.querySelectorAll("[data-overlay-comparison]")) {
        initPanel(panel);
      }
    })();
  </script>`;
}

function normalizeHex(value) {
  const raw = String(value || "").trim().replace(/^0x/i, "").replace(/^#/, "").toUpperCase();
  if (/^[0-9A-F]{8}$/.test(raw)) return `#${raw.slice(2)}`;
  if (/^[0-9A-F]{6}$/.test(raw)) return `#${raw}`;
  return null;
}

function readTextIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function walk(dir, predicate, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(full, predicate, acc);
    } else if (predicate(full)) {
      acc.push(full);
    }
  }
  return acc;
}

function reactSourceLabel() {
  const relative = path.relative(repoRoot, reactRepoRoot);
  return relative && !relative.startsWith("..") ? relative : reactRepoRoot;
}

function assertReactSourceReady(reason) {
  const requiredFiles = [
    path.join(webRoot, "package.json"),
    path.join(srcRoot, "index.css"),
    path.join(srcRoot, "components"),
  ];
  const missing = requiredFiles.find((item) => !fs.existsSync(item));
  if (!missing) return;

  const defaultHint = repoHasWebPackage
    ? "Run from the React repo root, or pass --react-repo-dir /path/to/slock."
    : path.resolve(reactRepoRoot) === path.resolve(defaultReactRepoRoot)
      ? "Run `git submodule update --init third_party/slock-source` from the Android repo, or pass --react-repo-dir /path/to/slock."
      : "Pass --react-repo-dir /path/to/slock or set SLOCK_REACT_REPO_DIR to a Slock web source checkout.";
  throw new Error(
    `React source repo is not ready for ${reason}: missing ${path.relative(reactRepoRoot, missing)} under ${reactSourceLabel()}. ${defaultHint}`,
  );
}

function assertReactProviderHarnessReady() {
  assertReactSourceReady("react capture");
  const requiredFiles = [
    path.join(webRoot, "playwright.visual-testing.config.ts"),
    path.join(webRoot, "visual-testing", "VisualTestingCases.tsx"),
    path.join(packageRoot, "tests", "react-provider.spec.ts"),
  ];
  const missing = requiredFiles.find((item) => !fs.existsSync(item));
  if (!missing) return;
  throw new Error(
    `React visual provider harness is missing from ${reactSourceLabel()}: ${path.relative(reactRepoRoot, missing)}. ` +
      "The visual-testing CLI will not fall back to another web checkout; update the React visual provider harness or pass --react-repo-dir explicitly for a one-off run.",
  );
}

function extractThemeTokens(css) {
  const themeMatch = css.match(/@theme\s*\{([\s\S]*?)\n\}/);
  if (!themeMatch) return {};
  const tokens = {};
  for (const line of themeMatch[1].split(/\n/)) {
    const match = line.match(/--([a-zA-Z0-9-]+):\s*([^;]+);/);
    if (match) tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

function extractReactComponent(file) {
  const source = fs.readFileSync(file, "utf8");
  const names = new Set();
  const patterns = [
    /export\s+default\s+function\s+([A-Z][A-Za-z0-9_]*)/g,
    /export\s+function\s+([A-Z][A-Za-z0-9_]*)/g,
    /export\s+const\s+([A-Z][A-Za-z0-9_]*)\s*=/g,
    /const\s+([A-Z][A-Za-z0-9_]*)\s*=\s*(?:memo|forwardRef|\()/g,
    /function\s+([A-Z][A-Za-z0-9_]*)\s*\(/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  const testIds = [...source.matchAll(/data-testid=["'`]([^"'`]+)["'`]/g)].map((match) => match[1]);
  const visualClassSamples = [...source.matchAll(/className=["'`]([^"'`]+)["'`]/g)]
    .map((match) => match[1])
    .filter((value) => value.includes("brutal") || value.includes("border") || value.includes("font") || value.includes("shadow"))
    .slice(0, 12);
  if (names.size === 0 && testIds.length === 0) return null;
  return {
    path: path.relative(reactRepoRoot, file),
    components: [...names].sort(),
    testIds: [...new Set(testIds)].sort(),
    visualClassSamples: [...new Set(visualClassSamples)].sort(),
  };
}

function normalizeCase(item, knownPaths) {
  const captureType = normalizeCaptureType(item.captureType, item.id);
  const category = item.category || caseCategory(item);
  return {
    ...item,
    captureType,
    captureGroup: captureTypeLabel(captureType),
    category,
    surface: item.surface || caseSurface(item) || "unknown",
    fixture: item.fixture || `fixtures/${item.id}.json`,
    viewport: item.viewport || { width: 390, height: 844, density: 3 },
    theme: item.theme || "light",
    locale: item.locale || "zh-CN",
    tolerance: item.tolerance || { pixelRatio: 0.02, layoutDp: 1, ignoreAntialiasing: true },
    capture: {
      ...(item.capture || {}),
      selector: item.selector || item.capture?.selector || `[data-visual-case='${item.id}']`,
      crop: item.capture?.crop || "element",
    },
    variants: normalizeVariants(item),
    reactSourceExists: item.reactPathHint ? knownPaths.has(item.reactPathHint) : false,
  };
}

function normalizeVariants(item) {
  if (Array.isArray(item.variants) && item.variants.length > 0) {
    return item.variants.map((variant) => ({
      id: variant.id,
      name: variant.name || variant.id,
      fixture: variant.fixture || item.fixture || `fixtures/${item.id}.json`,
      props: variant.props || {},
      interactions: variant.interactions || [],
    }));
  }
  return [
    {
      id: "default",
      name: "Default",
      fixture: item.fixture || `fixtures/${item.id}.json`,
      props: {},
      interactions: [],
    },
  ];
}

function scanReact() {
  assertReactSourceReady("scan");
  const componentFiles = walk(path.join(srcRoot, "components"), (file) => /\.(tsx|ts)$/.test(file));
  const inventory = componentFiles.map(extractReactComponent).filter(Boolean);
  const cssTokens = extractThemeTokens(fs.readFileSync(path.join(srcRoot, "index.css"), "utf8"));
  const sharedTokens = fs.existsSync(sharedTokensPath) ? readJson(sharedTokensPath) : {};
  const tokens = { ...cssTokens, shared: sharedTokens };
  const knownPaths = new Set(inventory.map((item) => item.path));
  const sharedManifest = fs.existsSync(sharedCasesPath) ? readJson(sharedCasesPath) : null;
  const rawCases = sharedManifest?.cases?.length ? sharedManifest.cases : defaultCases;
  const cases = rawCases.map((item) => normalizeCase(item, knownPaths));
  const componentMatrix = normalizeComponentMatrix(sharedManifest, cases);

  ensureDir(artifactRoot);
  writeJson(inventoryPath, { generatedAt: new Date().toISOString(), tokens, inventory });
  writeJson(defaultManifestPath, {
    version: sharedManifest?.version || 1,
    name: sharedManifest?.name || "Raft Visual Testing",
    cases,
    componentMatrix,
  });
  writeJson(providerSpecPath, {
    version: 1,
    name: "Visual Testing Provider Spec",
    env: [
      "SLOCK_VISUAL_PROVIDER",
      "SLOCK_VISUAL_CASE_ID",
      "SLOCK_VISUAL_VARIANT_ID",
      "SLOCK_VISUAL_CASE_JSON",
      "SLOCK_VISUAL_RESULT_DIR",
    ],
    output: {
      image: "visual-testing-results/<provider>/<case-id>.<png|svg|jpg|jpeg|webp>",
      metadata: "visual-testing-results/<provider>/<case-id>.metadata.json",
    },
    metadataRequiredFields: ["provider", "caseId", "image", "viewport", "capturedAt"],
    metadataOptionalFields: {
      typography: "Array or object with text/style probes such as selector, text, fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, color.",
      styleTokens: "Array or object with relevant design-token/computed-style probes such as backgroundColor, borderColor, shadow, radius, spacing.",
      computedStyles: "Array or object for provider-specific computed CSS/KMP style snapshots. Prefer stable selector/component labels.",
    },
  });
  console.log(`scan: ${inventory.length} component files, ${Object.keys(tokens).length} tokens, ${cases.length} cases, ${componentMatrix.length} matrix rows`);
}

function normalizeComponentMatrix(sharedManifest, cases) {
  const rows = new Map();
  const skippedCases = new Map(cases.filter(isSkippedCase).map((visualCase) => [visualCase.id, visualCase]));
  for (const visualCase of cases) {
    rows.set(visualCase.id, normalizeMatrixRow({
      id: visualCase.id,
      title: visualCase.title || visualCase.id,
      captureType: visualCase.captureType,
      captureGroup: visualCase.captureGroup,
      category: visualCase.category || caseCategory(visualCase),
      surface: visualCase.surface || "unknown",
      group: visualCase.group || visualCase.category || visualCase.surface || "unknown",
      status: isSkippedCase(visualCase) ? "skipped" : visualCase.baselineStatus || "active",
      providers: visualCase.providerMatrix || {},
      notes: skipReason(visualCase),
    }));
  }
  for (const row of sharedManifest?.componentMatrix || []) {
    const base = rows.get(row.id) || {};
    const skippedCase = skippedCases.get(row.id);
    rows.set(row.id, normalizeMatrixRow({
      ...base,
      ...row,
      status: skippedCase ? "skipped" : row.status || base.status,
      notes: skippedCase ? skipReason(skippedCase) : row.notes || base.notes,
      providers: mergeProviderMatrix(base.providers, row.providers),
    }));
  }
  return [...rows.values()].sort((a, b) => {
    const groupCompare = String(a.group || "").localeCompare(String(b.group || ""));
    return groupCompare || String(a.id).localeCompare(String(b.id));
  });
}

function normalizeMatrixRow(row) {
  const captureType = normalizeCaptureType(row.captureType, row.id);
  return {
    id: row.id,
    title: row.title || row.id,
    captureType,
    captureGroup: row.captureGroup || captureTypeLabel(captureType),
    category: row.category || caseCategory(row),
    surface: row.surface || "unknown",
    group: row.group || row.category || row.surface || "unknown",
    status: row.status || "active",
    providers: normalizeProviderMatrix(row.providers),
    notes: row.notes || "",
  };
}

function skipReason(visualCase) {
  if (!isSkippedCase(visualCase)) return visualCase.notes || "";
  if (typeof visualCase.skip === "object" && visualCase.skip.reason) return visualCase.skip.reason;
  return visualCase.notes || "Skipped from visual similarity accounting.";
}

function normalizeProviderMatrixEntry(value) {
  if (typeof value === "string") return { status: value, components: [], path: "", fixture: "", reason: "" };
  return {
    ...value,
    status: value.status || "pending",
    components: Array.isArray(value.components) ? value.components : [],
    path: value.path || "",
    fixture: value.fixture || "",
    reason: value.reason || "",
  };
}

function normalizeProviderMatrix(providers) {
  const normalized = {};
  const entries = Array.isArray(providers)
    ? providers.map((entry) => [entry.id || entry.provider || entry.name, entry])
    : Object.entries(providers || {});
  for (const [provider, value] of entries) {
    if (!provider) continue;
    normalized[provider] = normalizeProviderMatrixEntry(value);
  }
  return normalized;
}

function mergeProviderMatrix(baseProviders, nextProviders) {
  return {
    ...normalizeProviderMatrix(baseProviders),
    ...normalizeProviderMatrix(nextProviders),
  };
}

function resolveManifestPath(manifestFlag) {
  if (!manifestFlag) return defaultManifestPath;
  if (manifestFlag === "shared" || manifestFlag === "package") return sharedCasesPath;
  return path.resolve(manifestFlag);
}

function loadManifest(flags, { createIfMissing = true } = {}) {
  const manifestPath = resolveManifestPath(flags.manifest);
  if (!fs.existsSync(manifestPath) && createIfMissing) {
    scanReact();
  }
  return readJson(manifestPath);
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function runExternalProvider(provider, command, visualCase) {
  const env = {
    ...process.env,
    SLOCK_VISUAL_PROVIDER: provider,
    SLOCK_VISUAL_CASE_ID: visualCase.id,
    SLOCK_VISUAL_CASE_JSON: JSON.stringify(visualCase),
    SLOCK_VISUAL_RESULT_DIR: path.join(resultRoot, provider),
  };
  ensureDir(env.SLOCK_VISUAL_RESULT_DIR);
  const result = spawnSync(command, { shell: true, stdio: "inherit", cwd: repoRoot, env });
  if (result.status !== 0) {
    throw new Error(`provider ${provider} failed for ${visualCase.id} with status ${result.status}`);
  }
}

function runReactProvider(cases, flags) {
  assertReactProviderHarnessReady();
  const env = {
    ...process.env,
    SLOCK_VISUAL_PROVIDER: "react",
    SLOCK_VISUAL_CASE_IDS: cases.map((item) => item.id).join(","),
    SLOCK_VISUAL_CASE_MANIFEST: sharedCasesPath,
    SLOCK_REACT_REPO_DIR: reactRepoRoot,
    SLOCK_VISUAL_RESULT_ROOT: resultRoot,
    SLOCK_ANDROID_REPO_ROOT: defaultAndroidRepoRoot,
    PLAYWRIGHT_WEB_PORT: String(flags.webPort || process.env.PLAYWRIGHT_WEB_PORT || "4173"),
  };
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@botiverse/raft-web",
      "exec",
      "playwright",
      "test",
      "--config",
      "playwright.visual-testing.config.ts",
    ],
    { stdio: "inherit", cwd: reactRepoRoot, env },
  );
  if (result.status !== 0) {
    throw new Error(`react provider failed with status ${result.status}`);
  }
}

function selectedCases(manifest, flags) {
  const only = flags.case ? new Set(String(flags.case).split(",").map((item) => item.trim()).filter(Boolean)) : null;
  const filters = String(flags.category || flags.filter || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const includePending = Boolean(flags["include-pending"]);
  const includeSkipped = Boolean(flags["include-skipped"]);
  const allCases = manifest.cases || [];
  let cases = only
    ? allCases.filter((item) => only.has(item.id))
    : allCases.filter((item) => includePending || item.baselineStatus !== "pending");
  cases = cases.filter((item) => includeSkipped || !isSkippedCase(item));
  if (filters.length > 0) {
    cases = cases.filter((item) => filters.some((filter) => caseMatchesFilter(item, filter)));
  }
  if (only && cases.length !== only.size) {
    const found = new Set(cases.map((item) => item.id));
    const missing = [...only].filter((item) => !found.has(item));
    const skipped = allCases.filter((item) => only.has(item.id) && isSkippedCase(item)).map((item) => item.id);
    if (skipped.length > 0 && !includeSkipped) {
      throw new Error(`Skipped visual testing case(s): ${skipped.join(", ")}. Pass --include-skipped to run them explicitly.`);
    }
    throw new Error(`Unknown visual testing case(s): ${missing.join(", ")}`);
  }
  return cases;
}

function isSkippedCase(visualCase) {
  const value = visualCase?.skip;
  if (value === true) return true;
  return Boolean(value && typeof value === "object" && value.enabled !== false);
}

function hasCaseSelection(flags) {
  return Boolean(flags.case || flags.category || flags.filter);
}

function expectedFullPublishCaseCount(flags) {
  const manifest = loadManifest(flags);
  return selectedCases(manifest, {
    ...flags,
    case: undefined,
    category: undefined,
    filter: undefined,
  }).length;
}

function normalizeCaptureType(value, id = "") {
  const raw = String(value || "").trim();
  if (captureTypeValues.has(raw)) return raw;
  if (String(id || "").startsWith("screens.")) return realScreenCaptureType;
  return componentFixtureCaptureType;
}

function captureTypeLabel(value) {
  return captureTypeLabels[normalizeCaptureType(value)] || captureTypeLabels[componentFixtureCaptureType];
}

function captureTypeSegment(value) {
  return captureTypeSegments[normalizeCaptureType(value)] || captureTypeSegments[componentFixtureCaptureType];
}

function caseSurface(visualCase) {
  const id = String(visualCase.id || "");
  if (!id) return visualCase.surface || "unknown";
  const parts = id.split(".");
  if ((parts[0] === "components" || parts[0] === "screens") && parts[1]) return parts[1];
  return visualCase.surface || parts[0] || "unknown";
}

function caseCategory(visualCase) {
  if (visualCase.category) return visualCase.category;
  if (String(visualCase.id || "").includes("/")) {
    const parts = String(visualCase.id).split("/");
    return parts.slice(0, -1).join("/") || parts[0] || "uncategorized";
  }
  const surface = caseSurface(visualCase);
  if (["home", "thread", "settings", "navigation", "tasks"].includes(surface)) return `app/${surface}`;
  if (surface === "components") return "components";
  if (surface === "tokens") return "tokens";
  if (surface === "auth") return "auth";
  return surface;
}

function casePath(visualCase) {
  if (String(visualCase.id || "").includes("/")) return String(visualCase.id);
  const captureType = normalizeCaptureType(visualCase.captureType, visualCase.id);
  const captureSegment = captureTypeSegment(captureType);
  const category = caseCategory(visualCase);
  const id = String(visualCase.id || "");
  const taxonomyPrefix = `${captureSegment}.`;
  const withoutTaxonomy = id.startsWith(taxonomyPrefix) ? id.slice(taxonomyPrefix.length) : id;
  const surfacePrefix = `${caseSurface(visualCase)}.`;
  const local = surfacePrefix !== "." && withoutTaxonomy.startsWith(surfacePrefix)
    ? withoutTaxonomy.slice(surfacePrefix.length)
    : withoutTaxonomy;
  return `${captureSegment}/${category}/${local.replaceAll(".", "/")}`;
}

function caseMatchesFilter(visualCase, filter) {
  const normalized = filter.replace(/\/+$/g, "");
  const captureType = normalizeCaptureType(visualCase.captureType, visualCase.id);
  const candidates = [
    visualCase.id,
    captureType,
    captureTypeLabel(captureType),
    captureTypeSegment(captureType),
    caseCategory(visualCase),
    casePath(visualCase),
    visualCase.surface,
    visualCase.group,
  ]
    .filter(Boolean)
    .map(String);
  if (normalized.endsWith("/*")) {
    const prefix = normalized.slice(0, -1);
    return candidates.some((candidate) => candidate.startsWith(prefix));
  }
  return candidates.some((candidate) => candidate === normalized || candidate.startsWith(`${normalized}/`));
}

function capture(flags) {
  const manifest = loadManifest(flags);
  const providers = String(flags.providers || "react").split(",").map((item) => item.trim()).filter(Boolean);
  const command = flags.command ? String(flags.command) : null;
  const cases = selectedCases(manifest, flags);
  for (const provider of providers) {
    if (!command && provider === "react") {
      runReactProvider(cases, flags);
      continue;
    }
    if (command) {
      for (const visualCase of cases) {
        runExternalProvider(provider, command, visualCase);
      }
      continue;
    }
    throw new Error(`provider ${provider} requires --command; built-in demo provider output is disabled for canonical visual testing`);
  }
  console.log(`capture: ${cases.length} cases x ${providers.length} providers`);
}

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Perceptual fingerprint for the analysis cache. Captures are not byte-stable
// across CI runs (antialiasing noise flips sha256 on visually identical
// images), so the cache keys on a 32x32 grayscale mean-threshold bitmap:
// 1024 bits, hex-encoded with a "p1:" version prefix.
async function visualFingerprint(file) {
  const pixels = await sharp(file, { limitInputPixels: false }).resize(32, 32, { fit: "fill" }).grayscale().raw().toBuffer();
  let sum = 0;
  for (const value of pixels) sum += value;
  const mean = sum / pixels.length;
  const bits = Buffer.alloc(pixels.length / 8);
  for (let index = 0; index < pixels.length; index += 1) {
    if (pixels[index] > mean) bits[index >> 3] |= 0x80 >> (index & 7);
  }
  return `p1:${bits.toString("hex")}`;
}

const fingerprintHammingBudget = 4;
const nibblePopcount = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

// Equal fingerprints always match; p1 fingerprints additionally match within a
// small Hamming distance to absorb residual capture noise. Legacy sha256
// values never equal a p1 value, so they age out via one full re-analysis.
function fingerprintsMatch(cachedHash, currentHash) {
  if (!cachedHash || !currentHash) return false;
  if (cachedHash === currentHash) return true;
  if (!cachedHash.startsWith("p1:") || !currentHash.startsWith("p1:") || cachedHash.length !== currentHash.length) return false;
  let distance = 0;
  for (let index = 3; index < cachedHash.length; index += 1) {
    distance += nibblePopcount[parseInt(cachedHash[index], 16) ^ parseInt(currentHash[index], 16)];
    if (distance > fingerprintHammingBudget) return false;
  }
  return true;
}

function findImage(provider, caseId) {
  const dir = path.join(resultRoot, provider);
  for (const ext of ["png", "svg", "jpg", "jpeg", "webp"]) {
    const candidate = path.join(dir, `${caseId}.${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readMetadata(provider, caseId) {
  const file = path.join(resultRoot, provider, `${caseId}.metadata.json`);
  return fs.existsSync(file) ? readJson(file) : null;
}

function isCanonicalProviderCapture(provider, metadata) {
  return !String(provider || "").endsWith("-demo") && (!metadata || metadata.providerType !== "builtin-demo");
}

function currentProviderList(flags) {
  const items = String(flags.current || "android")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : ["android"];
}

// ----- comparison pairs (spec: provider-pair-first, task #430) -----
// Pair identity is unordered; the canonical key orders the two ends by
// provider precedence (react > android > ios > ohos) so CLI input, URLs,
// cache keys and artifact directories never fork (ios__android canonicalizes
// to android__ios). Downstream code must read a pair's ends from the entry
// (leftProvider/rightProvider), never by parsing the key.
const providerPrecedence = ["react", "android", "ios", "ohos"];

function providerRank(provider) {
  const index = providerPrecedence.indexOf(String(provider || "").toLowerCase());
  return index === -1 ? providerPrecedence.length : index;
}

function pairClass(left, right) {
  return left === "react" || right === "react" ? "baseline" : "cross-platform";
}

function makePair(providerA, providerB) {
  const [left, right] = providerRank(providerB) < providerRank(providerA)
    ? [providerB, providerA]
    : [providerA, providerB];
  return {
    key: `${left}__${right}`,
    leftProvider: left,
    rightProvider: right,
    label: `${providerLabel(left)} ↔ ${providerLabel(right)}`,
    class: pairClass(left, right),
  };
}

function parsePairsFlag(value) {
  const pairs = [];
  for (const token of String(value).split(",").map((item) => item.trim()).filter(Boolean)) {
    const ends = token.split("__").map((item) => item.trim()).filter(Boolean);
    if (ends.length !== 2) {
      throw new Error(`--pairs entries must be <providerA>__<providerB>, got: ${token}`);
    }
    pairs.push(makePair(ends[0], ends[1]));
  }
  return pairs;
}

// Uniform pair list for every pair-consuming command. --pairs is the explicit
// form; --baseline X --current a,b stays supported as sugar for X__a,X__b.
function requestedPairs(flags) {
  const pairs = flags.pairs
    ? parsePairsFlag(flags.pairs)
    : currentProviderList(flags).map((current) => makePair(String(flags.baseline || "react"), current));
  const byKey = new Map();
  for (const pair of pairs) {
    if (!byKey.has(pair.key)) byKey.set(pair.key, pair);
  }
  return [...byKey.values()];
}

function diff(flags) {
  for (const pair of requestedPairs(flags)) {
    diffPair(flags, pair);
  }
}

function diffPair(flags, pair) {
  const manifest = loadManifest(flags);
  const baseline = pair.leftProvider;
  const current = pair.rightProvider;
  const cases = selectedCases(manifest, flags);
  const results = [];
  const comparisonDir = path.join(resultRoot, "diff", pair.key);
  for (const visualCase of cases) {
    const rawBaselineImage = findImage(baseline, visualCase.id);
    const rawCurrentImage = findImage(current, visualCase.id);
    const baselineMetadata = readMetadata(baseline, visualCase.id);
    const currentMetadata = readMetadata(current, visualCase.id);
    const baselineImage = rawBaselineImage && isCanonicalProviderCapture(baseline, baselineMetadata) ? rawBaselineImage : null;
    const currentImage = rawCurrentImage && isCanonicalProviderCapture(current, currentMetadata) ? rawCurrentImage : null;
    const captureType = normalizeCaptureType(visualCase.captureType, visualCase.id);
    const entry = {
      id: visualCase.id,
      surface: visualCase.surface,
      category: visualCase.category || caseCategory(visualCase),
      captureType,
      captureGroup: captureTypeLabel(captureType),
      baseline,
      current,
      tolerance: visualCase.tolerance,
      baselineImage: baselineImage ? path.relative(repoRoot, baselineImage) : null,
      currentImage: currentImage ? path.relative(repoRoot, currentImage) : null,
      baselineMetadata,
      currentMetadata,
      status: "missing",
    };
    const ignoredProviders = [];
    if (rawBaselineImage && !baselineImage) ignoredProviders.push(baseline);
    if (rawCurrentImage && !currentImage) ignoredProviders.push(current);
    if (ignoredProviders.length > 0) {
      entry.note = `Ignored non-real provider capture(s): ${ignoredProviders.join(", ")}`;
    }
    if (baselineImage && currentImage) {
      if (visualCase.capture?.fullLength) {
        // Same blank-tail margin on both sides before hashing and scoring (see
        // full-length-trim.mjs). Rewrites the capture in place, so the site
        // shows exactly what was scored; idempotent across pairs.
        entry.fullLengthTrim = {
          [baseline]: trimFullLengthTail(baselineImage, visualCase),
          [current]: trimFullLengthTail(currentImage, visualCase),
        };
      }
      const baselineHash = hashFile(baselineImage);
      const currentHash = hashFile(currentImage);
      entry.baselineSha256 = baselineHash;
      entry.currentSha256 = currentHash;
      entry.rawStatus = baselineHash === currentHash ? "same" : "different";
      entry.status = entry.rawStatus;
      if (path.extname(baselineImage).toLowerCase() === ".png" && path.extname(currentImage).toLowerCase() === ".png") {
        const sideBySidePath = path.join(comparisonDir, `${visualCase.id}.side-by-side.png`);
        const metricsPath = path.join(comparisonDir, `${visualCase.id}.metrics.json`);
        runImageDiff(baselineImage, currentImage, sideBySidePath, metricsPath, visualCase, baseline, current);
        const metrics = readJson(metricsPath);
        const thresholds = toleranceForPair(pair, visualCase);
        entry.sideBySideImage = path.relative(repoRoot, sideBySidePath);
        entry.metrics = metrics;
        entry.status = comparisonStatusFromMetrics(entry.rawStatus, metrics, thresholds);
        if (entry.status !== entry.rawStatus) entry.acceptance = comparisonAcceptance(entry.status, metrics, thresholds);
        entry.note = metrics.fullLength
          ? "Full-length capture: raw long screenshots, never rescaled. Both metrics pad the shorter image to the taller canvas with a marker colour and count every padded pixel as a mismatch, so a missing or extra tail lowers the score."
          : "Side-by-side and site raw captures preserve provider image sizes. Metrics use an in-memory comparison canvas: rgbSimilarity rescales for coarse color similarity, while pixelPerfectSimilarity pads the original images without cropping.";
      } else {
        entry.note = "File-level comparison only; PNG metrics require PNG inputs.";
      }
    }
    results.push(entry);
  }
  ensureDir(path.join(resultRoot, "diff"));
  writeJson(path.join(resultRoot, "diff", `${pair.key}.json`), {
    generatedAt: new Date().toISOString(),
    // baseline/current are compat mirrors of the pair ends (left/right).
    baseline,
    current,
    key: pair.key,
    leftProvider: pair.leftProvider,
    rightProvider: pair.rightProvider,
    class: pair.class,
    results,
    summary: summarize(results),
  });
  console.log(`diff: ${baseline} vs ${current}, ${results.length} cases`);
}

// Resolves the pass/basic-pass thresholds for one case of one pair. Keyed by
// pair.class today; visualCase is part of the contract so a per-case override
// can slot in without touching call sites.
function toleranceForPair(pair, visualCase) {
  return pairClassTolerances[pair?.class] || pairClassTolerances.baseline;
}

function comparisonStatusFromMetrics(rawStatus, metrics, thresholds) {
  if (rawStatus !== "different") return rawStatus;
  const pixel = Number(metrics?.pixelPerfectSimilarity);
  if (!Number.isFinite(pixel)) return rawStatus;
  if (pixel > thresholds.pixelPerfectPass) return "pass";
  if (pixel > thresholds.pixelPerfectBasicPass) return "basic-pass";
  return rawStatus;
}

function comparisonAcceptance(status, metrics, thresholds) {
  const pixel = Number(metrics?.pixelPerfectSimilarity || 0) * 100;
  if (status === "pass") return `pass: pixel perfect ${pixel.toFixed(2)}% > ${(thresholds.pixelPerfectPass * 100).toFixed(0)}%`;
  if (status === "basic-pass") return `basic pass: pixel perfect ${pixel.toFixed(2)}% > ${(thresholds.pixelPerfectBasicPass * 100).toFixed(0)}%`;
  return "";
}

function trimFullLengthTail(image, visualCase) {
  if (path.extname(image).toLowerCase() !== ".png") return null;
  const result = spawnSync("node", [fullLengthTrimScriptPath, image, String(visualCase.viewport?.width || 390)], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`full-length tail trim failed for ${path.basename(image)}: ${result.stderr || result.status}`);
  }
  try {
    return JSON.parse(String(result.stdout).trim().split("\n").pop());
  } catch {
    return null;
  }
}

function runImageDiff(baselineImage, currentImage, sideBySidePath, metricsPath, visualCase, baseline, current) {
  ensureDir(path.dirname(sideBySidePath));
  const result = spawnSync(
    "node",
    [
      sharpImageDiffScriptPath,
      baselineImage,
      currentImage,
      sideBySidePath,
      metricsPath,
      visualCase.id,
      visualCase.title || visualCase.id,
      providerLabel(baseline),
      providerLabel(current),
      ...(visualCase.capture?.fullLength ? ["full-length"] : []),
    ],
    { stdio: "inherit", cwd: repoRoot },
  );
  if (result.status !== 0) {
    throw new Error(`visual image diff failed for ${path.basename(baselineImage)} with status ${result.status}`);
  }
}

function overlay(flags) {
  const manifest = loadManifest(flags);
  // The overlay region tool is inherently single-pair; with a comma list the
  // first requested pair wins.
  const pair = requestedPairs(flags)[0];
  const baseline = pair.leftProvider;
  const current = pair.rightProvider;
  const alpha = String(flags.alpha || "0.5");
  const region = flags.region ? String(flags.region) : "none";
  const regionName = flags["region-name"] ? String(flags["region-name"]) : String(flags.regionName || "region");
  const cases = selectedCases(manifest, flags);
  const comparisonDir = path.join(resultRoot, "diff", pair.key);
  const outputs = [];
  for (const visualCase of cases) {
    const rawBaselineImage = findImage(baseline, visualCase.id);
    const rawCurrentImage = findImage(current, visualCase.id);
    const baselineMetadata = readMetadata(baseline, visualCase.id);
    const currentMetadata = readMetadata(current, visualCase.id);
    const baselineImage = rawBaselineImage && isCanonicalProviderCapture(baseline, baselineMetadata) ? rawBaselineImage : null;
    const currentImage = rawCurrentImage && isCanonicalProviderCapture(current, currentMetadata) ? rawCurrentImage : null;
    if (!baselineImage || !currentImage) {
      console.warn(`overlay: ${visualCase.id}: missing canonical ${baseline}/${current} image`);
      continue;
    }
    if (path.extname(baselineImage).toLowerCase() !== ".png" || path.extname(currentImage).toLowerCase() !== ".png") {
      console.warn(`overlay: ${visualCase.id}: PNG inputs required`);
      continue;
    }
    const overlayPath = path.join(comparisonDir, `${visualCase.id}.overlay.png`);
    const regionFileSegment = anchorId(regionName);
    const regionOverlayPath = region === "none" ? "none" : path.join(comparisonDir, `${visualCase.id}.${regionFileSegment}.overlay.png`);
    const regionSideBySidePath = region === "none" ? "none" : path.join(comparisonDir, `${visualCase.id}.${regionFileSegment}.side-by-side.png`);
    const metricsPath = path.join(comparisonDir, `${visualCase.id}.overlay.metrics.json`);
    run("node", [
      sharpImageOverlayScriptPath,
      baselineImage,
      currentImage,
      overlayPath,
      regionOverlayPath,
      regionSideBySidePath,
      metricsPath,
      alpha,
      regionName,
      region,
    ]);
    const metrics = readJson(metricsPath);
    outputs.push({
      id: visualCase.id,
      overlay: path.relative(repoRoot, overlayPath),
      regionOverlay: regionOverlayPath === "none" ? null : path.relative(repoRoot, regionOverlayPath),
      regionSideBySide: regionSideBySidePath === "none" ? null : path.relative(repoRoot, regionSideBySidePath),
      metrics: path.relative(repoRoot, metricsPath),
      region: metrics.region || null,
    });
  }
  console.log(`overlay: ${baseline} vs ${current}, ${outputs.length} cases`);
  for (const output of outputs) {
    const regionText = output.region
      ? ` region ${output.region.name}: RGB ${(output.region.rgbSimilarity * 100).toFixed(2)}%, pixel ${(output.region.pixelPerfectSimilarity * 100).toFixed(2)}%, mismatch ${(output.region.pixelMismatchRatio * 100).toFixed(2)}%`
      : "";
    console.log(`overlay: ${output.id}: ${output.overlay}${regionText}`);
  }
}

function providerLabel(provider) {
  if (provider === "android" || provider === "android-connected" || provider === "kmp-shared") return "Android";
  if (provider === "harmony" || provider === "ohos-shared") return "Harmony";
  if (provider === "ios") return "iOS";
  if (provider === "react") return "React";
  return provider;
}

function summarize(results) {
  return results.reduce(
    (acc, item) => {
      acc.total += 1;
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    },
    { total: 0, same: 0, pass: 0, "basic-pass": 0, different: 0, missing: 0 },
  );
}

// Builds one uniform pair object per requested pair (--pairs, or the
// --baseline/--current sugar). The first pair keeps the historical index.html
// slot while additional pairs render next to it as <pairKey>.html.
async function comparisonPairs(flags, manifest, shouldAnalyzePair) {
  const pairs = [];
  const requested = requestedPairs(flags);
  for (let index = 0; index < requested.length; index += 1) {
    const pair = requested[index];
    const diffPath = path.join(resultRoot, "diff", `${pair.key}.json`);
    if (!fs.existsSync(diffPath)) diffPair(flags, pair);
    if (shouldAnalyzePair && shouldAnalyzePair(pair.key)) await analyzePair(flags, pair);
    const diffData = await withAnalysis(fs.existsSync(diffPath) ? readJson(diffPath) : { results: [], summary: {} }, pair.key);
    const componentMatrix = enrichComponentMatrix(manifest.componentMatrix || normalizeComponentMatrix(null, manifest.cases || []), diffData, pair.leftProvider, pair.rightProvider);
    pairs.push({
      ...pair,
      // baseline/current/comparison are compat mirrors of the pair ends for
      // the per-run detail layer and pre-pairs metadata readers.
      baseline: pair.leftProvider,
      current: pair.rightProvider,
      comparison: pair.key,
      diffData,
      componentMatrix,
      detailHref: index === 0 ? "index.html" : `${pair.key}.html`,
    });
  }
  return pairs;
}

function comparisonMetadataEntries(pairs) {
  return pairs.map((pair) => ({
    key: pair.key,
    leftProvider: pair.leftProvider,
    rightProvider: pair.rightProvider,
    label: pair.label,
    class: pair.class,
    baseline: pair.baseline,
    current: pair.current,
    comparison: pair.comparison,
    detailHref: pair.detailHref,
    summary: pair.diffData.summary || {},
    analysisSummary: pair.diffData.analysis?.summary || {},
  }));
}


async function report(flags) {
  const manifest = loadManifest(flags);
  const pairs = await comparisonPairs(flags, manifest, (comparison) =>
    shouldRunAnalysis(flags) && (flags.force || flags.analyze || flags.analysis || !fs.existsSync(analysisPath(comparison))));
  const primary = pairs[0];
  const metadata = {
    generatedAt: primary.diffData.generatedAt || new Date().toISOString(),
    runId: "local",
    commit: "local",
    commitSubject: "",
    baseline: primary.baseline,
    current: primary.current,
    comparison: primary.comparison,
    comparisons: comparisonMetadataEntries(pairs),
    summary: primary.diffData.summary || {},
    componentMatrixSummary: summarizeComponentMatrix(primary.componentMatrix),
    componentMatrix: primary.componentMatrix,
  };
  ensureDir(resultRoot);
  // The local report is the site's home page too (the yellow per-pair page is retired).
  const homeCases = siteHomeCases(primary.diffData, metadata, manifest.cases || [], pairs.slice(1));
  const outputPath = path.join(resultRoot, "index.html");
  fs.writeFileSync(outputPath, siteHomeHtml(metadata, [], rebaseLatestPaths(homeCases)));
  console.log(`report: ${path.relative(process.cwd(), outputPath)}`);
}

async function analyze(flags) {
  const outputs = [];
  for (const pair of requestedPairs(flags)) outputs.push(await analyzePair(flags, pair));
  return outputs.length === 1 ? outputs[0] : outputs;
}

async function analyzePair(flags, pair) {
  const baseline = pair.leftProvider;
  const current = pair.rightProvider;
  const comparison = pair.key;
  const diffPath = path.join(resultRoot, "diff", `${comparison}.json`);
  if (!fs.existsSync(diffPath)) diffPair(flags, pair);
  const diffData = readJson(diffPath);
  const existing = readAnalysis(comparison);
  const entriesById = new Map((existing.cases || []).map((item) => [item.id, item]));
  // Read (never create) the manifest so the prompt can carry per-case
  // note/tolerance; analyze must keep working without a manifest on disk.
  const manifestPath = resolveManifestPath(flags.manifest);
  const manifestById = new Map(
    (fs.existsSync(manifestPath) ? readJson(manifestPath).cases || [] : []).map((visualCase) => [visualCase.id, visualCase]),
  );
  const items = diffData.results || [];
  const cases = new Array(items.length);
  let fresh = 0;
  let cachedHits = 0;
  // Bounded worker pool: model analysis is ~15s/case, so fresh cases run
  // concurrently; results land by index to preserve diff order.
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      const sideBySidePath = item.sideBySideImage ? path.join(repoRoot, item.sideBySideImage) : null;
      const imageHash = sideBySidePath && fs.existsSync(sideBySidePath) ? await visualFingerprint(sideBySidePath) : null;
      const cached = entriesById.get(item.id);
      const mismatch = itemMismatchRatio(item);
      if (!flags.force && cachedAnalysisValid(cached, imageHash, mismatch)) {
        cachedHits += 1;
        // Re-anchor to the current fingerprint so drift never accumulates
        // against a stale anchor.
        cases[index] = { ...cached, imageHash, metricMismatch: mismatch ?? cached.metricMismatch ?? null };
        continue;
      }
      fresh += 1;
      const analyzed = await analyzeCase(item, { baseline, current, comparison, pairClass: pair.class, imageHash, sideBySidePath, flags, manifestCase: manifestById.get(item.id) || null });
      cases[index] = { ...analyzed, metricMismatch: mismatch };
    }
  };
  await Promise.all(Array.from({ length: Math.min(analyzeConcurrencyLimit, items.length) }, () => worker()));
  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    baseline,
    current,
    comparison,
    // Pair-level backend stamp: the backend used this run, preserved from the
    // prior file when every case came from cache.
    analysisProvider: cases.map((item) => item.analysisProvider).find(Boolean) || existing.analysisProvider || "",
    analysisModel: cases.map((item) => item.analysisModel).find(Boolean) || existing.analysisModel || "",
    summary: summarizeAnalysis(cases),
    cases,
  };
  writeJson(analysisPath(comparison), output);
  console.log(`analyze: ${comparison} fresh=${fresh} cached=${cachedHits}`);
  console.log(`analyze: ${comparison}, ${cases.length} cases, ${output.summary.ready} ready, ${output.summary.pending} pending`);
  return output;
}

// Model backend selection: the pi SDK (MiniMax et al.) wins whenever its
// credential is present; otherwise fall back to the codex CLI shell-out.
async function analyzeCase(item, context) {
  return shouldUsePiAnalysis() ? analyzeCaseWithPi(item, context) : analyzeCaseWithCodex(item, context);
}

function piApiKey() {
  return process.env.MINIMAX_API_KEY || process.env.PI_API_KEY || "";
}

function shouldUsePiAnalysis() {
  return Boolean(piApiKey());
}

// Lazy so the CLI keeps working (codex path, --skip-model) when the optional
// @earendil-works/pi-ai dependency is not installed. SLOCK_PI_AI_MODULE lets
// tests/ops point at an alternate module implementing the same surface.
let piModelsPromise = null;
function loadPiModels() {
  piModelsPromise ??= import(process.env.SLOCK_PI_AI_MODULE || "@earendil-works/pi-ai/providers/all").then((pi) =>
    pi.builtinModels(),
  );
  return piModelsPromise;
}

function pendingAnalysisCaseBase(item, context) {
  return {
    id: item.id,
    status: "pending",
    imageHash: context.imageHash,
    generatedAt: new Date().toISOString(),
    severity: "unknown",
    summary: [],
    likelyCauses: [],
    suggestedOwner: "",
    suggestedFixes: [],
    error: null,
  };
}

// Direct pi-SDK analysis (in-process, no CLI shell-out). Builds one user
// message with the analysis prompt + the side-by-side PNG as a base64 image
// block (pi-ai ImageContent: { type: "image", data, mimeType }) and asks for
// strict JSON matching analysisJsonSchema(); anthropic-messages via pi has no
// response-format constraint, so the schema is embedded in the prompt and the
// reply is parsed tolerating markdown fences.
async function analyzeCaseWithPi(item, context) {
  const base = pendingAnalysisCaseBase(item, context);
  if (!context.sideBySidePath || !fs.existsSync(context.sideBySidePath)) {
    return { ...base, error: "missing side-by-side image" };
  }
  if (context.flags["dry-run"] || context.flags["skip-model"]) {
    return { ...base, error: "analysis skipped by flag" };
  }
  let models;
  try {
    models = await loadPiModels();
  } catch (error) {
    return { ...base, error: `pi-ai SDK unavailable (install @earendil-works/pi-ai): ${trimForJson(error.message, 300)}` };
  }
  let model;
  try {
    model = resolveAnalysisModel(models, context.flags);
  } catch (error) {
    return { ...base, error: trimForJson(error.message, 300) };
  }
  const providerId = model.provider;
  const modelId = model.id;
  const prompt = [
    visualAnalysisPrompt(item, context),
    "",
    "Respond with STRICT JSON only (a single JSON object, no markdown fences, no prose) matching this JSON schema:",
    JSON.stringify(analysisJsonSchema(), null, 2),
  ].join("\n");
  const piContext = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image", data: fs.readFileSync(context.sideBySidePath).toString("base64"), mimeType: "image/png" },
        ],
        timestamp: Date.now(),
      },
    ],
  };
  const timeoutMs = Number(context.flags.timeout || 180000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let message;
  try {
    message = await models.complete(model, piContext, {
      apiKey: piApiKey(),
      maxTokens: 4096,
      signal: controller.signal,
      timeoutMs,
    });
  } catch (error) {
    return { ...base, error: `pi analysis failed: ${trimForJson(error?.message || String(error), 600)}` };
  } finally {
    clearTimeout(timer);
  }
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    const suffix = message.stopReason === "aborted" ? " (timeout)" : "";
    return { ...base, error: `pi analysis failed${suffix}: ${trimForJson(message.errorMessage || "unknown error", 600)}` };
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  try {
    const parsed = JSON.parse(extractJsonObjectText(text));
    return normalizeAnalysisCase({
      ...base,
      ...parsed,
      id: item.id,
      status: "ready",
      imageHash: context.imageHash,
      analysisProvider: providerId,
      analysisModel: modelId,
    });
  } catch (error) {
    return { ...base, error: `invalid pi JSON: ${error.message}`, raw: trimForJson(text, 1200) };
  }
}

// Tolerates ```json fences and surrounding prose around the JSON object.
function extractJsonObjectText(text) {
  const trimmed = String(text || "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const body = fenced ? fenced[1].trim() : trimmed;
  if (body.startsWith("{")) return body;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

function analyzeCaseWithCodex(item, context) {
  const base = pendingAnalysisCaseBase(item, context);
  if (!context.sideBySidePath || !fs.existsSync(context.sideBySidePath)) {
    return { ...base, error: "missing side-by-side image" };
  }
  if (context.flags["dry-run"] || context.flags["skip-model"]) {
    return { ...base, error: "analysis skipped by flag" };
  }
  const codexPath = findExecutable("codex");
  if (!codexPath) return { ...base, error: "codex CLI not found" };
  const modelId = context.flags.model ? String(context.flags.model) : "";
  const outputFile = path.join(os.tmpdir(), `slock-visual-analysis-${process.pid}-${anchorId(item.id)}.json`);
  const schemaFile = path.join(os.tmpdir(), `slock-visual-analysis-schema-${process.pid}.json`);
  fs.writeFileSync(schemaFile, `${JSON.stringify(analysisJsonSchema(), null, 2)}\n`);
  const prompt = visualAnalysisPrompt(item, context);
  const args = [
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "-C",
    repoRoot,
    "--image",
    context.sideBySidePath,
    "--output-schema",
    schemaFile,
    "-o",
    outputFile,
    prompt,
  ];
  if (context.flags.model) args.splice(1, 0, "--model", String(context.flags.model));
  try {
    const result = spawnSync(codexPath, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: Number(context.flags.timeout || 180000) });
    if (result.status !== 0 || !fs.existsSync(outputFile)) {
      return {
        ...base,
        error: `codex analysis failed${result.status === null ? " (timeout)" : ` status ${result.status}`}`,
        stderr: trimForJson(result.stderr || result.stdout || "", 1200),
      };
    }
    const parsed = JSON.parse(fs.readFileSync(outputFile, "utf8"));
    return normalizeAnalysisCase({
      ...base,
      ...parsed,
      id: item.id,
      status: "ready",
      imageHash: context.imageHash,
      analysisProvider: "codex",
      analysisModel: modelId,
    });
  } catch (error) {
    return { ...base, error: `invalid codex JSON: ${error.message}`, raw: trimForJson(fs.readFileSync(outputFile, "utf8"), 1200) };
  } finally {
    fs.rmSync(outputFile, { force: true });
    fs.rmSync(schemaFile, { force: true });
  }
}

// Lazy module-level cache of the intentional-divergence registry. Resolved
// relative to this package (sharedVisualRoot), NOT process.cwd(): the CLI is
// routinely invoked from other repo checkouts.
let platformDivergencesCache = null;
// An entry's optional appliesTo key scopes it to a pair class: baselineOnly |
// crossPlatform | allPairs. Absent defaults by direction (spec:
// provider-pair-first §AI analysis): react-adopts-later describes distance
// from the react reference, so it is baselineOnly; platform-difference holds
// on any pair.
function divergenceAppliesTo(entry) {
  if (entry.appliesTo) return entry.appliesTo;
  return entry.direction === "react-adopts-later" ? "baselineOnly" : "allPairs";
}

function platformDivergencesForCase(caseId, pairClass) {
  if (!platformDivergencesCache) {
    const file = path.join(sharedVisualRoot, "platformDivergences.json");
    platformDivergencesCache = fs.existsSync(file) ? readJson(file).divergences || [] : [];
  }
  const accepted = pairClass === "cross-platform" ? ["crossPlatform", "allPairs"] : ["baselineOnly", "allPairs"];
  return platformDivergencesCache.filter((entry) => entry.caseId === caseId && accepted.includes(divergenceAppliesTo(entry)));
}

function visualAnalysisPrompt(item, context) {
  const metadata = {
    id: item.id,
    status: item.status,
    baseline: context.baseline,
    current: context.current,
    baselineRawSize: rawSizeText(item.baselineMetadata),
    currentRawSize: rawSizeText(item.currentMetadata),
    rgbSimilarity: item.metrics?.rgbSimilarity ?? null,
    pixelPerfectSimilarity: item.metrics?.pixelPerfectSimilarity ?? null,
    pixelMismatchRatio: item.metrics?.pixelMismatchRatio ?? null,
    crop: {
      baseline: item.baselineMetadata?.crop || null,
      current: item.currentMetadata?.crop || null,
    },
  };
  if (context.manifestCase?.note) metadata.manifestNote = String(context.manifestCase.note);
  if (context.manifestCase?.tolerance !== undefined) metadata.tolerance = context.manifestCase.tolerance;
  // Pair-class framing (spec: provider-pair-first §AI analysis): baseline
  // pairs keep the react-reference framing unchanged; cross-platform pairs
  // compare two Kuikly ends for isomorphism — neither side is the reference.
  const crossPlatform = context.pairClass === "cross-platform";
  const framing = crossPlatform
    ? `Both sides are Kuikly-rendered mobile ends: the left side is ${providerLabel(context.baseline)} and the right side is ${providerLabel(context.current)}. Neither side is the reference — the question is whether the two ends are isomorphic, so report divergences between them.`
    : `The left side is ${providerLabel(context.baseline)} and the right side is ${providerLabel(context.current)}.`;
  const divergences = platformDivergencesForCase(item.id, context.pairClass);
  const divergenceGuidance = [
    "Entries with direction platform-difference are intentional: both sides are correct for their platform. Do NOT report them as defects and do NOT raise severity because of them; if observed, mention them only in the `intentional` list, never in summary.",
    crossPlatform
      ? divergences.some((entry) => entry.direction === "react-adopts-later")
        ? "Entries with direction react-adopts-later describe a product feature the mobile ends carry ahead of the web client — not a defect of either side; list under `intentional` if observed."
        : null
      : "Entries with direction react-adopts-later mean the current-side behavior is the desired product feature and react will adopt it later — likewise not a defect of the current platform; list under `intentional` if observed.",
  ].filter(Boolean).join(" ");
  const divergenceSection = divergences.length
    ? [
        "",
        "Known intentional divergences for this case:",
        ...divergences.map((entry) => `- [${entry.direction}] ${entry.area}: ${entry.note}`),
        divergenceGuidance,
      ].join("\n")
    : "";
  return `Analyze this Slock visual-testing side-by-side image. ${framing} Use the image plus metadata to produce concise, actionable UI differences. Focus on concrete visual differences only: typography weight/size, spacing, alignment, color, shape, missing elements, clipping/cropping, state indicators, and component bounds. Return JSON only matching the schema.\n\nMetadata:\n${JSON.stringify(metadata, null, 2)}${divergenceSection}`;
}

function analysisJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["severity", "summary", "likelyCauses", "suggestedOwner", "suggestedFixes"],
    properties: {
      severity: { type: "string", enum: ["low", "medium", "high", "unknown"] },
      summary: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
      likelyCauses: { type: "array", maxItems: 5, items: { type: "string" } },
      suggestedOwner: { type: "string" },
      suggestedFixes: { type: "array", maxItems: 5, items: { type: "string" } },
      intentional: { type: "array", maxItems: 5, items: { type: "string" } },
    },
  };
}

function normalizeAnalysisCase(value) {
  return {
    id: String(value.id || ""),
    status: value.status === "ready" ? "ready" : "pending",
    imageHash: value.imageHash || null,
    generatedAt: value.generatedAt || new Date().toISOString(),
    severity: ["low", "medium", "high", "unknown"].includes(value.severity) ? value.severity : "unknown",
    summary: asStringArray(value.summary).slice(0, 5),
    likelyCauses: asStringArray(value.likelyCauses).slice(0, 5),
    suggestedOwner: String(value.suggestedOwner || ""),
    suggestedFixes: asStringArray(value.suggestedFixes).slice(0, 5),
    intentional: asStringArray(value.intentional).slice(0, 5),
    analysisProvider: String(value.analysisProvider || ""),
    analysisModel: String(value.analysisModel || ""),
    error: value.error || null,
  };
}

function asStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function summarizeAnalysis(cases) {
  return cases.reduce(
    (acc, item) => {
      acc.total += 1;
      if (item.status === "ready") acc.ready += 1;
      else acc.pending += 1;
      return acc;
    },
    { total: 0, ready: 0, pending: 0 },
  );
}

// Shared cache-validity predicate for analyzePair AND withAnalysis (the
// report/site path runs WITHOUT a fresh analyze in the async design, so it
// must apply the exact same staleness rules or stale ready notes publish).
function itemMismatchRatio(item) {
  return typeof item.metrics?.pixelMismatchRatio === "number" ? item.metrics.pixelMismatchRatio : null;
}
function cachedAnalysisValid(cached, currentFingerprint, currentMismatch) {
  if (cached?.status !== "ready") return false;
  // Belt-and-braces alongside the fingerprint: on very large captures a
  // small REAL change can stay inside the Hamming budget, but it still
  // moves the diff mismatch ratio — a material delta busts the cache.
  const metricsStable = cached.metricMismatch == null || currentMismatch == null
    ? true
    : Math.abs(cached.metricMismatch - currentMismatch) <= 0.005;
  return metricsStable && fingerprintsMatch(cached.imageHash, currentFingerprint);
}

async function withAnalysis(diffData, comparison) {
  const analysis = readAnalysis(comparison);
  const byId = new Map((analysis.cases || []).map((item) => [item.id, item]));
  const results = await Promise.all((diffData.results || []).map(async (item) => {
    const currentHash = await currentSideBySideHash(item);
    const cached = byId.get(item.id);
    const isValid = cachedAnalysisValid(cached, currentHash, itemMismatchRatio(item));
    return {
      ...item,
      analysis: isValid
        ? cached
        : pendingAnalysisForItem(item, currentHash, cached ? "analysis stale; rerun analyze" : "analysis pending"),
    };
  }));
  const cases = results.map((item) => item.analysis).filter(Boolean);
  return {
    ...diffData,
    analysis: {
      ...analysis,
      summary: summarizeAnalysis(cases),
      cases,
    },
    results,
  };
}

function readAnalysis(comparison) {
  const file = analysisPath(comparison);
  return fs.existsSync(file) ? readJson(file) : { version: 1, cases: [], summary: { total: 0, ready: 0, pending: 0 } };
}

function analysisPath(comparison) {
  return path.join(analysisRoot, `${comparison}.json`);
}

async function currentSideBySideHash(item) {
  const sideBySidePath = item.sideBySideImage ? path.join(repoRoot, item.sideBySideImage) : null;
  return sideBySidePath && fs.existsSync(sideBySidePath) ? visualFingerprint(sideBySidePath) : null;
}

function pendingAnalysisForItem(item, imageHash, error) {
  return {
    id: item.id,
    status: "pending",
    imageHash,
    generatedAt: new Date().toISOString(),
    severity: "unknown",
    summary: [],
    likelyCauses: [],
    suggestedOwner: "",
    suggestedFixes: [],
    analysisProvider: "",
    analysisModel: "",
    error: item.sideBySideImage ? error : "missing side-by-side image",
  };
}

function findExecutable(name) {
  const result = spawnSync("command", ["-v", name], { shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim().split(/\n/)[0] : "";
}

function trimForJson(value, maxLength) {
  const text = String(value || "");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

function copyFileIntoSite(source, destination) {
  if (!fs.existsSync(source)) return false;
  ensureDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
  return true;
}

function copyDirIntoSite(source, destination) {
  if (!fs.existsSync(source)) return false;
  ensureDir(destination);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirIntoSite(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      copyFileIntoSite(sourcePath, destinationPath);
    }
  }
  return true;
}

async function site(flags) {
  const manifest = loadManifest(flags);
  const runId = sourceRunId(flags);
  const pairs = await comparisonPairs(flags, manifest, () => shouldRunAnalysis(flags));
  const primary = pairs[0];

  const targetRoot = path.resolve(flags.siteDir || flags["site-dir"] || siteRoot);
  const latestDir = path.join(targetRoot, "latest");
  const runDir = path.join(targetRoot, "runs", runId);
  fs.rmSync(latestDir, { recursive: true, force: true });
  fs.rmSync(runDir, { recursive: true, force: true });
  ensureDir(latestDir);
  ensureDir(runDir);

  const metadata = {
    generatedAt: new Date().toISOString(),
    runId,
    commit: runId,
    commitSubject: sourceCommitSubject(flags),
    baseline: primary.baseline,
    current: primary.current,
    comparison: primary.comparison,
    comparisons: comparisonMetadataEntries(pairs),
    summary: primary.diffData.summary || {},
    analysisSummary: primary.diffData.analysis?.summary || {},
    componentMatrixSummary: summarizeComponentMatrix(primary.componentMatrix),
    componentMatrix: primary.componentMatrix,
  };
  const homeCases = siteHomeCases(primary.diffData, metadata, manifest.cases || [], pairs.slice(1));
  writeRunContent(latestDir, pairs, metadata, "../", homeCases);
  writeRunContent(runDir, pairs, metadata, "../../", homeCases);
  const runs = [runSummary(metadata, `runs/${runId}/`)];
  writeJson(path.join(targetRoot, "metadata.json"), metadata);
  writeJson(path.join(targetRoot, "index.json"), siteIndexJson(metadata, runs));
  fs.writeFileSync(path.join(targetRoot, "llms.txt"), siteLlmsText(metadata, runs));
  fs.writeFileSync(path.join(targetRoot, "index.html"), siteHomeHtml(metadata, runs, homeCases));

  console.log(`site: ${path.relative(process.cwd(), targetRoot)}`);
  return targetRoot;
}

function shouldRunAnalysis(flags) {
  return !flags["skip-analysis"] && !flags["no-analysis"] && !flags["dry-run"];
}

function writeRunContent(targetDir, pairs, metadata, homeHref, homeCases) {
  for (const pair of pairs) {
    copyFileIntoSite(path.join(resultRoot, "diff", `${pair.comparison}.json`), path.join(targetDir, "diff", `${pair.comparison}.json`));
    copyFileIntoSite(analysisPath(pair.comparison), path.join(targetDir, "analysis", `${pair.comparison}.json`));
    copyCurrentResultFiles(pair.diffData, targetDir, pair.comparison);
  }
  // One report (artin 2026-11-02: the yellow per-run page is retired): the directory's
  // index.html is the same home page as the site root, showing this run.
  writeJson(path.join(targetDir, "home-cases.json"), { generatedAt: metadata.generatedAt, runId: metadata.runId, cases: homeCases });
  fs.writeFileSync(path.join(targetDir, "index.html"), siteHomeHtmlForDir(metadata, homeCases, homeHref));
  writeJson(path.join(targetDir, "component-matrix.json"), {
    generatedAt: metadata.generatedAt,
    runId: metadata.runId,
    baseline: metadata.baseline,
    current: metadata.current,
    summary: metadata.componentMatrixSummary || {},
    rows: metadata.componentMatrix || [],
  });
  writeJson(path.join(targetDir, "metadata.json"), metadata);
  const primary = pairs[0];
  if (primary.diffData.analysis?.summary) {
    writeJson(path.join(targetDir, "analysis-summary.json"), primary.diffData.analysis.summary);
  }
}

function normalizeRunId(value) {
  return String(value || "local").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "local";
}

function gitOutput(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() : "";
}

function sourceRepoRoot(flags) {
  const explicit = flags.sourceRepoDir || flags["source-repo-dir"] || process.env.SLOCK_VISUAL_SOURCE_REPO;
  return explicit ? path.resolve(explicit) : repoRoot;
}

function sourceRunId(flags) {
  return normalizeRunId(flags.runId || flags["run-id"] || gitOutput(sourceRepoRoot(flags), ["rev-parse", "--short", "HEAD"]) || "local");
}

function sourceCommitSubject(flags) {
  return String(flags.commitSubject || flags["commit-subject"] || gitOutput(sourceRepoRoot(flags), ["log", "-1", "--pretty=%s"]) || "");
}

function runSummary(metadata, hrefPrefix) {
  const summary = {
    runId: metadata.runId,
    commit: metadata.commit,
    commitSubject: metadata.commitSubject,
    generatedAt: metadata.generatedAt,
    baseline: metadata.baseline,
    current: metadata.current,
    summary: metadata.summary,
    analysisSummary: metadata.analysisSummary || {},
    comparisons: (metadata.comparisons || []).map((pair) => pair.comparison),
    componentMatrixSummary: metadata.componentMatrixSummary,
    href: hrefPrefix,
    componentMatrix: `${hrefPrefix}component-matrix.json`,
    llms: `${hrefPrefix}metadata.json`,
  };
  return summary;
}

function enrichComponentMatrix(matrix, diffData, baseline, current) {
  const resultById = new Map((diffData.results || []).map((item) => [item.id, item]));
  return (matrix || []).map((row) => {
    const result = resultById.get(row.id);
    const captureType = normalizeCaptureType(row.captureType, row.id);
    return {
      ...row,
      captureType,
      captureGroup: row.captureGroup || captureTypeLabel(captureType),
      category: row.category || caseCategory(row),
      comparison: result
        ? {
            baseline,
            current,
            status: result.status,
            rawStatus: result.rawStatus || result.status,
            acceptance: result.acceptance || "",
            rgbSimilarity: result.metrics?.rgbSimilarity ?? null,
            pixelPerfectSimilarity: result.metrics?.pixelPerfectSimilarity ?? null,
            sideBySideImage: result.sideBySideImage || null,
          }
        : null,
    };
  });
}

function summarizeComponentMatrix(matrix) {
  const summary = {
    total: 0,
    active: 0,
    pending: 0,
    skipped: 0,
    captureTypes: {
      [componentFixtureCaptureType]: { total: 0, active: 0, pending: 0, skipped: 0 },
      [realScreenCaptureType]: { total: 0, active: 0, pending: 0, skipped: 0 },
    },
    providers: {},
  };
  for (const row of matrix || []) {
    const captureType = normalizeCaptureType(row.captureType, row.id);
    summary.total += 1;
    if (isActiveCoverageStatus(row.status)) summary.active += 1;
    else if (row.status === "skipped") summary.skipped += 1;
    else summary.pending += 1;
    if (!summary.captureTypes[captureType]) summary.captureTypes[captureType] = { total: 0, active: 0, pending: 0, skipped: 0 };
    summary.captureTypes[captureType].total += 1;
    if (isActiveCoverageStatus(row.status)) summary.captureTypes[captureType].active += 1;
    else if (row.status === "skipped") summary.captureTypes[captureType].skipped += 1;
    else summary.captureTypes[captureType].pending += 1;
    for (const [provider, entry] of Object.entries(row.providers || {})) {
      if (!summary.providers[provider]) summary.providers[provider] = { active: 0, pending: 0, unsupported: 0, total: 0 };
      summary.providers[provider].total += 1;
      if (isActiveCoverageStatus(entry.status)) summary.providers[provider].active += 1;
      else if (entry.status === "unsupported") summary.providers[provider].unsupported += 1;
      else summary.providers[provider].pending += 1;
    }
  }
  return summary;
}

function isActiveCoverageStatus(status) {
  return ["active", "baseline", "ready"].includes(String(status || ""));
}

function copyCurrentResultFiles(diffData, latestDir, comparison) {
  for (const item of diffData.results || []) {
    for (const relativePath of [item.baselineImage, item.currentImage, item.sideBySideImage]) {
      copyRelativeResultFile(relativePath, latestDir);
    }
    const metricsPath = path.join(resultRoot, "diff", comparison, `${item.id}.metrics.json`);
    if (fs.existsSync(metricsPath)) {
      copyFileIntoSite(metricsPath, path.join(latestDir, "diff", comparison, `${item.id}.metrics.json`));
    }
    for (const metadata of [item.baselineMetadata, item.currentMetadata]) {
      if (metadata?.image) {
        const parsed = path.parse(metadata.image);
        copyRelativeResultFile(path.join(parsed.dir, `${parsed.name}.metadata.json`), latestDir);
      }
    }
    copyFileIntoSite(path.join(resultRoot, item.baseline, `${item.id}.metadata.json`), path.join(latestDir, item.baseline, `${item.id}.metadata.json`));
    copyFileIntoSite(path.join(resultRoot, item.current, `${item.id}.metadata.json`), path.join(latestDir, item.current, `${item.id}.metadata.json`));
  }
  // Capture failure diagnostics ({case}.failure.png / {case}.failure.json with
  // capture-env details) and the shard _capture-timing.log are written even for
  // cases that never produce a capture, so diffData.results cannot enumerate
  // them; publish them from the provider result directories directly so
  // missing-capture triage works from the public site.
  for (const provider of new Set([diffData.baseline, diffData.current].filter(Boolean))) {
    copyProviderDiagnosticFiles(provider, latestDir);
  }
}

function copyProviderDiagnosticFiles(provider, latestDir) {
  const providerDir = path.join(resultRoot, provider);
  if (!fs.existsSync(providerDir)) return;
  for (const entry of fs.readdirSync(providerDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const isDiagnosticFile = entry.name.endsWith(".failure.png") || entry.name.endsWith(".failure.json") || entry.name === "_capture-timing.log";
    if (!isDiagnosticFile) continue;
    copyFileIntoSite(path.join(providerDir, entry.name), path.join(latestDir, provider, entry.name));
  }
}

function copyRelativeResultFile(relativePath, latestDir) {
  if (!relativePath) return;
  const absolutePath = path.join(repoRoot, relativePath);
  if (!absolutePath.startsWith(resultRoot)) return;
  copyFileIntoSite(absolutePath, path.join(latestDir, path.relative(resultRoot, absolutePath)));
}













function rawSizeText(metadata) {
  const rect = metadata?.crop?.rect;
  if (rect?.width && rect?.height) return `${Math.round(Number(rect.width))}×${Math.round(Number(rect.height))}`;
  const viewport = metadata?.viewport;
  if (viewport?.width && viewport?.height) return `${Math.round(Number(viewport.width))}×${Math.round(Number(viewport.height))}`;
  return "n/a";
}


function treeNodeHtml(node, hrefPrefix) {
  const groups = [...node.children.entries()];
  const cases = [...node.cases];
  const children = [
    ...groups.map(([name, child]) => `<li><strong>${xmlEscape(name)}</strong>${treeNodeHtml(child, hrefPrefix)}</li>`),
    ...cases.map((item) => `<li><a href="#case-${xmlEscape(anchorId(item.id))}"><span>${xmlEscape(item.label)}</span><code>${xmlEscape(item.status)}</code></a></li>`),
  ].join("");
  return `<ul>${children}</ul>`;
}



function siteIndexJson(metadata, runs) {
  const latest = runs[0] || null;
  const index = {
    version: 1,
    name: "Raft Visual Testing",
    generatedAt: metadata.generatedAt,
    latestRunId: metadata.runId,
    latest,
    componentMatrixSummary: metadata.componentMatrixSummary || {},
    runs,
  };
  return index;
}

function siteLlmsText(metadata, runs) {
  const matrixSummary = metadata.componentMatrixSummary || {};
  const analysisSummary = metadata.analysisSummary || {};
  const comparisons = metadataComparisons(metadata);
  const comparisonLines = comparisons.map((pair) => {
    const summary = pair.summary || {};
    return `- ${pair.comparison}: total ${Number(summary.total || 0)}, same ${Number(summary.same || 0)}, pass ${Number(summary.pass || 0)}, basic-pass ${Number(summary["basic-pass"] || 0)}, different ${Number(summary.different || 0)}, missing ${Number(summary.missing || 0)}`;
  });
  const providerLines = Object.entries(matrixSummary.providers || {}).map(
    ([provider, value]) => `- ${provider}: active ${Number(value.active || 0)}, pending ${Number(value.pending || 0)}, unsupported ${Number(value.unsupported || 0)}`,
  );
  const captureTypeLines = Object.entries(matrixSummary.captureTypes || {})
    .filter(([, value]) => Number(value.total || 0) > 0)
    .map(([captureType, value]) => `- ${captureTypeLabel(captureType)} (${captureType}): active ${Number(value.active || 0)}, pending ${Number(value.pending || 0)}, total ${Number(value.total || 0)}`);
  const pendingRows = (metadata.componentMatrix || []).filter((row) => row.status !== "active");
  const lines = [
    "# Raft Visual Testing",
    "",
    `Generated: ${utcTimestampText(metadata.generatedAt)}`,
    `Latest run: ${metadata.runId}`,
    `Latest commit: ${metadata.commit}`,
    metadata.commitSubject ? `Commit subject: ${metadata.commitSubject}` : null,
    `Providers: ${comparisons.map((pair) => `${pair.baseline} vs ${pair.current}`).join(", ")}`,
    `Summary: total ${Number(metadata.summary.total || 0)}, same ${Number(metadata.summary.same || 0)}, pass ${Number(metadata.summary.pass || 0)}, basic-pass ${Number(metadata.summary["basic-pass"] || 0)}, different ${Number(metadata.summary.different || 0)}, missing ${Number(metadata.summary.missing || 0)}`,
    `AI analysis: ready ${Number(analysisSummary.ready || 0)} / total ${Number(analysisSummary.total || 0)}, pending ${Number(analysisSummary.pending || 0)}`,
    `Visual coverage matrix: active ${Number(matrixSummary.active || 0)} / total ${Number(matrixSummary.total || 0)}, pending ${Number(matrixSummary.pending || 0)}, skipped ${Number(matrixSummary.skipped || 0)}`,
    `Capture taxonomy: components use ${componentFixtureCaptureType}; real screens use ${realScreenCaptureType}`,
    "",
    "## Comparisons",
    "",
    ...(comparisonLines.length ? comparisonLines : ["- none"]),
    "",
    "## Capture Type Coverage",
    "",
    ...(captureTypeLines.length ? captureTypeLines : ["- none"]),
    "",
    "## Provider Coverage",
    "",
    ...providerLines,
    "",
    "## Pending Coverage Rows",
    "",
    ...(pendingRows.length ? pendingRows.map((row) => `- ${row.id}: ${row.notes || row.title || row.status}`) : ["- none"]),
    "",
    "## Runs",
    "",
    ...runs.map((run) => `- ${run.runId}: ${run.baseline} vs ${run.current}, total ${Number(run.summary?.total || 0)}, pass ${Number(run.summary?.pass || 0)}, basic-pass ${Number(run.summary?.["basic-pass"] || 0)}, different ${Number(run.summary?.different || 0)}, matrix ${run.componentMatrix}, page ${run.href}`),
    "",
    "## Baseline Gate",
    "",
    "Only real product component paths should be included in this report. Pending, fake, preview-only, or mis-scaled provider cases should be excluded from similarity accounting.",
    "",
  ].filter((line) => line !== null);
  return `${lines.join("\n")}\n`;
}

function siteHomeImageHref(relativePath) {
  if (!relativePath) return null;
  const normalized = String(relativePath).replace(/\\/g, "/");
  const marker = "visual-testing-results/";
  const index = normalized.indexOf(marker);
  if (index === -1) return null;
  return `latest/${normalized.slice(index + marker.length)}`;
}

function siteHomeMetrics(metrics) {
  if (!metrics) return null;
  const entry = {};
  for (const key of ["pixelPerfectSimilarity", "rgbSimilarity", "pixelMismatchRatio", "comparisonWidth", "comparisonHeight", "baselineWidth", "baselineHeight", "currentWidth", "currentHeight"]) {
    if (typeof metrics[key] === "number") entry[key] = metrics[key];
  }
  return entry;
}

function siteHomeAnalysis(analysis) {
  if (!analysis) return null;
  return {
    status: analysis.status || "pending",
    generatedAt: analysis.generatedAt || null,
    severity: analysis.severity || "unknown",
    summary: asStringArray(analysis.summary).slice(0, 5),
    likelyCauses: asStringArray(analysis.likelyCauses).slice(0, 5),
    suggestedOwner: String(analysis.suggestedOwner || ""),
    suggestedFixes: asStringArray(analysis.suggestedFixes).slice(0, 5),
    intentional: asStringArray(analysis.intentional).slice(0, 5),
    analysisProvider: String(analysis.analysisProvider || ""),
    analysisModel: String(analysis.analysisModel || ""),
    error: analysis.error || null,
  };
}

// Raw capture facts for one provider, independent of any pair diff outcome
// (the Matrix view and the Left/Right raw tabs read these).
function siteHomeProviderEntry(image, metadata) {
  const entry = {
    status: image ? "captured" : "missing",
    image: siteHomeImageHref(image),
  };
  if (metadata?.capturedAt) entry.capturedAt = metadata.capturedAt;
  const meta = {};
  if (metadata?.viewport) meta.viewport = metadata.viewport;
  if (metadata?.crop) meta.crop = metadata.crop;
  // Renderer capability facts + declared divergences (task #441): captured
  // from the SLOCK_RICHTEXT_CAPS marker into per-case metadata; the site
  // renders them as declared-fallback badges. Passed through verbatim --
  // field names are owned by the #429 contract.
  if (metadata?.richTextCapabilities && typeof metadata.richTextCapabilities === "object") {
    meta.richTextCapabilities = metadata.richTextCapabilities;
  }
  if (Array.isArray(metadata?.declaredDivergences) && metadata.declaredDivergences.length > 0) {
    meta.declaredDivergences = metadata.declaredDivergences.slice(0, 10);
  }
  if (Object.keys(meta).length > 0) entry.metadata = meta;
  return entry;
}

function addSiteHomeProvider(providers, provider, image, metadata) {
  if (!provider) return;
  const existing = providers[provider];
  if (existing && existing.status === "captured") return;
  const entry = siteHomeProviderEntry(image, metadata);
  if (!existing || entry.status === "captured") providers[provider] = entry;
}

function siteHomePairCaseEntry(pair, result) {
  const entry = {
    leftProvider: pair.leftProvider,
    rightProvider: pair.rightProvider,
    class: pair.class,
    status: result.status || "unknown",
    similarity: typeof result.metrics?.pixelPerfectSimilarity === "number" ? result.metrics.pixelPerfectSimilarity : null,
    rgbSimilarity: typeof result.metrics?.rgbSimilarity === "number" ? result.metrics.rgbSimilarity : null,
    sideBySideImage: siteHomeImageHref(result.sideBySideImage),
  };
  const metrics = siteHomeMetrics(result.metrics || null);
  if (metrics) entry.metrics = metrics;
  const analysis = siteHomeAnalysis(result.analysis || null);
  if (analysis) entry.analysis = analysis;
  return entry;
}

function siteHomeComparisonEntry(pair, result) {
  const entry = {
    current: pair.current,
    label: providerLabel(pair.current),
    comparison: pair.comparison,
    status: result.status || "unknown",
    similarity: typeof result.metrics?.pixelPerfectSimilarity === "number" ? result.metrics.pixelPerfectSimilarity : null,
    rgbSimilarity: typeof result.metrics?.rgbSimilarity === "number" ? result.metrics.rgbSimilarity : null,
    currentImage: siteHomeImageHref(result.currentImage),
    sideBySideImage: siteHomeImageHref(result.sideBySideImage),
  };
  const metrics = siteHomeMetrics(result.metrics || null);
  if (metrics) entry.metrics = metrics;
  const analysis = siteHomeAnalysis(result.analysis || null);
  if (analysis) entry.analysis = analysis;
  return entry;
}

function siteHomeCases(diffData, metadata, manifestCases = [], additionalPairs = []) {
  const matrixById = new Map((metadata.componentMatrix || []).map((row) => [row.id, row]));
  const manifestById = new Map((manifestCases || []).map((visualCase) => [visualCase.id, visualCase]));
  // diffData.baseline/current are already canonical, so makePair reproduces
  // the pair identity for legacy diff files that predate the key fields.
  const primaryPair = makePair(diffData.baseline || metadata.baseline || "react", diffData.current || metadata.current || "android");
  const pairResults = additionalPairs.map((pair) => ({
    pair,
    resultById: new Map((pair.diffData.results || []).map((item) => [item.id, item])),
  }));
  const results = diffData.results || [];
  const noteCounts = new Map();
  for (const item of results) {
    const note = String(item.note || "");
    if (note) noteCounts.set(note, (noteCounts.get(note) || 0) + 1);
  }
  const isBoilerplateNote = (note) => note && results.length > 2 && (noteCounts.get(note) || 0) > results.length / 2;
  return results.map((item) => {
    const row = matrixById.get(item.id);
    const manifestCase = manifestById.get(item.id);
    const variants = (manifestCase?.variants || [])
      .filter((variant) => variant && (variant.name || variant.id))
      .map((variant) => {
        const entry = { name: String(variant.name || variant.id) };
        if (variant.props && typeof variant.props === "object" && Object.keys(variant.props).length > 0) entry.props = variant.props;
        return entry;
      })
      .filter((variant, _, all) => all.length > 1 || variant.props || !/^default$/i.test(variant.name));
    const entry = {
      id: item.id,
      title: String(row?.title || manifestCase?.title || item.id),
      surface: item.surface || row?.surface || "unknown",
      category: item.category || row?.category || "unknown",
      captureType: normalizeCaptureType(item.captureType, item.id),
      status: item.status || "unknown",
      similarity: typeof item.metrics?.pixelPerfectSimilarity === "number" ? item.metrics.pixelPerfectSimilarity : null,
      rgbSimilarity: typeof item.metrics?.rgbSimilarity === "number" ? item.metrics.rgbSimilarity : null,
      baselineImage: siteHomeImageHref(item.baselineImage),
      currentImage: siteHomeImageHref(item.currentImage),
      sideBySideImage: siteHomeImageHref(item.sideBySideImage),
    };
    const metrics = siteHomeMetrics(item.metrics || null);
    if (metrics) entry.metrics = metrics;
    const analysis = siteHomeAnalysis(item.analysis || null);
    if (analysis) entry.analysis = analysis;
    // Pair-first indexes: raw provider captures plus one entry per pair. The
    // flat fields above and comparisons[] below stay as output-only compat
    // mirrors of the first pair for pre-pairs readers.
    const providers = {};
    const pairsIndex = {};
    addSiteHomeProvider(providers, primaryPair.leftProvider, item.baselineImage, item.baselineMetadata);
    addSiteHomeProvider(providers, primaryPair.rightProvider, item.currentImage, item.currentMetadata);
    pairsIndex[primaryPair.key] = siteHomePairCaseEntry(primaryPair, item);
    const comparisons = pairResults
      .map(({ pair, resultById }) => {
        const result = resultById.get(item.id);
        if (!result) return null;
        addSiteHomeProvider(providers, pair.leftProvider, result.baselineImage, result.baselineMetadata);
        addSiteHomeProvider(providers, pair.rightProvider, result.currentImage, result.currentMetadata);
        pairsIndex[pair.key] = siteHomePairCaseEntry(pair, result);
        return siteHomeComparisonEntry(pair, result);
      })
      .filter(Boolean);
    entry.providers = providers;
    entry.pairs = pairsIndex;
    // Providers the case's matrix row declares (react-only cases list just
    // react). The site shows an undeclared provider as n/a, not missing.
    // The case's own providerMatrix stands in when the matrix came from a raw
    // manifest without a row for it. Omitted when neither declares any, so
    // the site keeps its old reading.
    const rowProviders = Object.keys(normalizeProviderMatrix(row?.providers));
    const declaredProviders = rowProviders.length > 0
      ? rowProviders
      : Object.keys(normalizeProviderMatrix(manifestCase?.providerMatrix));
    if (declaredProviders.length > 0) entry.declaredProviders = declaredProviders;
    if (comparisons.length > 0) entry.comparisons = comparisons;
    const rawNote = String(item.note || "");
    const note = isBoilerplateNote(rawNote) ? String(row?.notes || "") : rawNote || String(row?.notes || "");
    if (note) entry.note = note;
    if (variants.length > 0) entry.variants = variants;
    return entry;
  });
}

const siteAssetRoot = path.join(packageRoot, "site");

function readSiteAsset(name) {
  // Resolved relative to this package (import.meta), NOT process.cwd():
  // the CLI is routinely invoked from other repo checkouts (e.g. the mobile
  // repo pointing at slock-source) where cwd is unrelated to this package.
  return fs.readFileSync(path.join(siteAssetRoot, name), "utf8");
}

function renderSiteTemplate(template, replacements) {
  let html = template;
  for (const [token, value] of Object.entries(replacements)) {
    html = html.split(`{{${token}}}`).join(value);
  }
  const leftover = html.match(/\{\{[A-Z0-9_]+\}\}/);
  if (leftover) throw new Error(`site template: unresolved placeholder ${leftover[0]}`);
  return html;
}

function metadataComparisons(metadata) {
  const comparisons = metadata.comparisons || [];
  if (comparisons.length > 0) return comparisons;
  return [{
    baseline: metadata.baseline,
    current: metadata.current,
    comparison: metadata.comparison,
    summary: metadata.summary || {},
    analysisSummary: metadata.analysisSummary || {},
  }];
}

// Pair entry for the vt-data payload. Metadata entries written before the
// pair-first model lack the explicit ends; those are synthesized from the
// baseline/current mirrors (canonical order by construction).
function siteHomePairDef(entry) {
  const base = entry.key && entry.leftProvider
    ? { key: entry.key, leftProvider: entry.leftProvider, rightProvider: entry.rightProvider, label: entry.label, class: entry.class }
    : makePair(entry.baseline, entry.current);
  return {
    ...base,
    leftLabel: providerLabel(base.leftProvider),
    rightLabel: providerLabel(base.rightProvider),
    summary: entry.summary || {},
    analysisSummary: entry.analysisSummary || {},
    detailHref: entry.detailHref || "",
  };
}

function siteHomeHtml(metadata, runs, cases = [], siteRootHref = "") {
  const summary = metadata.summary || {};
  const analysisSummary = metadata.analysisSummary || {};
  const comparisons = metadataComparisons(metadata);
  const pairDefs = comparisons.map((entry) => siteHomePairDef(entry));
  const providerIds = [...new Set(pairDefs.flatMap((pair) => [pair.leftProvider, pair.rightProvider]))];
  const passCount = Number(summary.same || 0) + Number(summary.pass || 0) + Number(summary["basic-pass"] || 0);
  const payload = {
    name: "Raft Visual Testing",
    runId: metadata.runId,
    commit: metadata.commit,
    commitSubject: metadata.commitSubject || "",
    generatedAt: metadata.generatedAt,
    providers: providerIds.map((id) => ({ id, label: providerLabel(id) })),
    pairs: pairDefs,
    // baseline/current/comparisons are output-only compat mirrors of the
    // first pair (pre-pairs bookmarks/readers); new home.js reads pairs only.
    baseline: metadata.baseline,
    baselineLabel: providerLabel(metadata.baseline),
    current: metadata.current,
    currentLabel: providerLabel(metadata.current),
    comparisons: comparisons.map((pair) => ({
      baseline: pair.baseline,
      baselineLabel: providerLabel(pair.baseline),
      current: pair.current,
      currentLabel: providerLabel(pair.current),
      comparison: pair.comparison,
      summary: pair.summary || {},
      analysisSummary: pair.analysisSummary || {},
    })),
    summary,
    analysisSummary,
    runs: runs.map((run) => ({
      runId: run.runId,
      commitSubject: run.commitSubject || "",
      generatedAt: run.generatedAt,
      baseline: run.baseline,
      current: run.current,
      summary: run.summary || {},
      href: run.href,
    })),
    cases,
  };
  // The emitted index.html stays a single self-contained artifact: css/js are
  // inlined from packages/visual-testing/site/ and the data is embedded as
  // JSON, so the published page makes zero extra requests beyond the images.
  return renderSiteTemplate(readSiteAsset("home.html"), {
    HOME_CSS: readSiteAsset("home.css").trimEnd(),
    APPLICABILITY_JS: readSiteAsset("applicability.js").trimEnd(),
    HOME_JS: readSiteAsset("home.js").trimEnd(),
    VT_DATA_JSON: JSON.stringify(payload).replace(/</g, "\\u003c"),
    OVERLAY_SCRIPT: overlayComparisonScript(),
    // The site-wide data links (index.json, llms.txt, latest/…) from a page in latest/ or runs/<id>/.
    SITE_ROOT: xmlEscape(siteRootHref),
    LOCALIZED_TIME_SCRIPT: localizedTimeScript(),
    RUN_ID: xmlEscape(metadata.runId),
    BASELINE: xmlEscape(metadata.baseline),
    // Distinct non-baseline pair ends (cross-platform pairs would otherwise
    // repeat a provider in the "react vs ..." header line).
    CURRENT: xmlEscape(providerIds.filter((id) => id !== metadata.baseline).join(", ")),
    GENERATED_AT_HTML: localizedTimestampHtml(metadata.generatedAt, { label: "generated" }),
    TOTAL: String(Number(summary.total || 0)),
    PASS_COUNT: String(passCount),
    DIFFERENT: String(Number(summary.different || 0)),
    MISSING: String(Number(summary.missing || 0)),
    AI_READY: String(Number(analysisSummary.ready || 0)),
    AI_TOTAL: String(Number(analysisSummary.total || 0)),
  });
}

function mergeSiteIntoPublishWorktree(sourceRoot, targetSubdir, runId, options = {}) {
  ensureDir(targetSubdir);
  const runSource = path.join(sourceRoot, "runs", runId);
  const runTarget = path.join(targetSubdir, "runs", runId);
  const latestTarget = path.join(targetSubdir, "latest");
  if (options.resetRuns) {
    fs.rmSync(path.join(targetSubdir, "runs"), { recursive: true, force: true });
  }
  fs.rmSync(runTarget, { recursive: true, force: true });
  fs.rmSync(latestTarget, { recursive: true, force: true });
  copyDirIntoSite(runSource, runTarget);
  copyDirIntoSite(path.join(sourceRoot, "latest"), latestTarget);
  // Legacy Raft UI package mirror retired (task #354): the homepage LIBRARY
  // group covers it now, so drop any previously published latest/raft-ui/.
  fs.rmSync(path.join(latestTarget, "raft-ui"), { recursive: true, force: true });

  const latestMetadata = readJson(path.join(sourceRoot, "metadata.json"));
  const existingIndexPath = path.join(targetSubdir, "index.json");
  const existingRuns = readExistingSiteRuns(targetSubdir, options);
  const nextRun = runSummary(latestMetadata, `runs/${runId}/`);
  const runs = [nextRun, ...existingRuns.filter((run) => run.runId !== runId)];
  writeJson(path.join(targetSubdir, "metadata.json"), latestMetadata);
  writeJson(existingIndexPath, siteIndexJson(latestMetadata, runs));
  fs.writeFileSync(path.join(targetSubdir, "llms.txt"), siteLlmsText(latestMetadata, runs));
  fs.writeFileSync(path.join(targetSubdir, "index.html"), siteHomeHtml(latestMetadata, runs, readSiteHomeCases(latestTarget, latestMetadata)));
  retireLegacyRunReports(targetSubdir);
}

/**
 * The home page for one directory of the site (latest/ or runs/<id>/): its cases' image
 * paths become relative to that directory (they are site-root relative, `latest/…`, and
 * every run directory holds the same files), and its run link goes back up by [homeHref].
 */
function siteHomeHtmlForDir(metadata, homeCases, homeHref) {
  const run = runSummary(metadata, `runs/${metadata.runId}/`);
  return siteHomeHtml(metadata, [{ ...run, href: `${homeHref}${run.href}` }], rebaseLatestPaths(homeCases), homeHref);
}

function rebaseLatestPaths(value) {
  if (typeof value === "string") return value.startsWith("latest/") ? value.slice("latest/".length) : value;
  if (Array.isArray(value)) return value.map(rebaseLatestPaths);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rebaseLatestPaths(entry)]));
  }
  return value;
}

/**
 * Every published run directory gets the current home page in place of the retired yellow
 * report (its other pair pages are removed), rebuilt from the data the run kept.
 */
function retireLegacyRunReports(targetSubdir) {
  for (const dir of [path.join(targetSubdir, "latest"), ...listRunDirs(targetSubdir)]) {
    const metadataPath = path.join(dir, "metadata.json");
    if (!fs.existsSync(metadataPath)) continue;
    const metadata = { ...readJson(metadataPath), runId: readJson(metadataPath).runId || path.basename(dir) };
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".html") && entry.name !== "index.html") fs.rmSync(path.join(dir, entry.name), { force: true });
    }
    const homeHref = path.basename(dir) === "latest" && path.dirname(dir) === targetSubdir ? "../" : "../../";
    fs.writeFileSync(path.join(dir, "index.html"), siteHomeHtmlForDir(metadata, readSiteHomeCases(dir, metadata), homeHref));
  }
}

function listRunDirs(targetSubdir) {
  const runsRoot = path.join(targetSubdir, "runs");
  if (!fs.existsSync(runsRoot)) return [];
  return fs.readdirSync(runsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(runsRoot, entry.name));
}

function readSiteHomeCases(latestDir, metadata) {
  const homeCasesPath = path.join(latestDir, "home-cases.json");
  if (fs.existsSync(homeCasesPath)) {
    const parsed = readJson(homeCasesPath);
    if (Array.isArray(parsed?.cases)) return parsed.cases;
  }
  const diffPath = path.join(latestDir, "diff", `${metadata.comparison}.json`);
  if (metadata.comparison && fs.existsSync(diffPath)) {
    return siteHomeCases(readJson(diffPath), metadata, []);
  }
  return [];
}

function readExistingSiteRuns(targetSubdir, options = {}) {
  if (options.resetRuns) return [];
  const runsById = new Map();
  const existingIndexPath = path.join(targetSubdir, "index.json");
  if (fs.existsSync(existingIndexPath)) {
    for (const run of readJson(existingIndexPath).runs || []) {
      if (run?.runId) runsById.set(run.runId, run);
    }
  }
  const runsRoot = path.join(targetSubdir, "runs");
  if (fs.existsSync(runsRoot)) {
    for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metadataPath = path.join(runsRoot, entry.name, "metadata.json");
      if (!fs.existsSync(metadataPath)) continue;
      const metadata = { ...readJson(metadataPath), runId: readJson(metadataPath).runId || entry.name };
      if (!runsById.has(metadata.runId)) {
        runsById.set(metadata.runId, runSummary(metadata, `runs/${entry.name}/`));
      }
    }
  }
  return [...runsById.values()].sort((a, b) => String(b.generatedAt || "").localeCompare(String(a.generatedAt || "")));
}

function defaultPublishRunId(flags) {
  const sourceCommit = gitOutput(sourceRepoRoot(flags), ["rev-parse", "--short", "HEAD"]) || "local";
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `${sourceCommit}-${timestamp}`;
}

async function publishGhPages(flags) {
  const publishRepoRoot = path.resolve(flags.repoDir || flags["repo-dir"] || repoRoot);
  const remote = String(flags.remote || "origin");
  const branch = String(flags.branch || "gh-pages");
  const subdir = String(flags.subdir || "visual-testing").replace(/^\/+|\/+$/g, "");
  const runId = normalizeRunId(flags.runId || flags["run-id"] || defaultPublishRunId(flags));
  const commitSubject = sourceCommitSubject(flags);
  const allowPartialPublish = Boolean(flags["allow-partial-publish"]);
  if (!allowPartialPublish && !hasCaseSelection(flags)) {
    diff(flags);
  }
  const targetRoot = await site({ ...flags, runId, commitSubject });
  assertPublishSourceSiteScope(targetRoot, flags);
  const dryRun = Boolean(flags["dry-run"]);
  const resetRuns = Boolean(flags["reset-runs"]);
  const url = inferPagesUrl(remote, subdir, publishRepoRoot);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-visual-gh-pages-"));
  const publishBranch = `slock-visual-gh-pages-${Date.now()}`;
  const branchExists = remoteBranchExists(publishRepoRoot, remote, branch);
  try {
    if (branchExists) {
      run("git", ["worktree", "add", "-B", publishBranch, tempDir, `${remote}/${branch}`], { cwd: publishRepoRoot });
    } else {
      run("git", ["worktree", "add", "--detach", tempDir, "HEAD"], { cwd: publishRepoRoot });
      run("git", ["checkout", "--orphan", publishBranch], { cwd: tempDir });
      run("git", ["rm", "-r", "-f", "--ignore-unmatch", "."], { cwd: tempDir });
      removeWorktreeContents(tempDir);
    }

    const targetSubdir = path.join(tempDir, subdir);
    const previousSiteState = readPublishSiteState(targetSubdir);
    mergeSiteIntoPublishWorktree(targetRoot, targetSubdir, runId, { resetRuns });
    assertMergedPublishSiteScope(targetSubdir, flags, previousSiteState);
    const rootIndex = path.join(tempDir, "index.html");
    fs.writeFileSync(rootIndex, `<!doctype html><meta charset="utf-8"><title>Raft</title><a href="./${subdir}/">Raft Visual Testing</a>\n`);
    run("git", ["add", subdir, "index.html"], { cwd: tempDir });
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: tempDir, encoding: "utf8" }).stdout.trim();
    if (!status) {
      console.log("publish-gh-pages: no changes to publish");
      return;
    }
    if (dryRun) {
      const resetSuffix = resetRuns ? " and reset existing runs" : "";
      console.log(`publish-gh-pages dry-run: would publish ${path.relative(repoRoot, targetRoot)} to ${publishRepoRoot} ${remote}/${branch}:${subdir}${resetSuffix}`);
      if (url) console.log(`publish-gh-pages dry-run: expected url ${url}`);
      return;
    }
    const message = String(flags.message || `chore: publish visual testing report ${new Date().toISOString()}`);
    run("git", ["commit", "-m", message], { cwd: tempDir });
    run("git", ["push", remote, `HEAD:${branch}`], { cwd: tempDir });
    console.log(`publish-gh-pages: pushed ${subdir} to ${remote}/${branch}${resetRuns ? " (reset runs)" : ""}`);
    if (url) console.log(`publish-gh-pages: ${url}`);
  } finally {
    const removeResult = spawnSync("git", ["worktree", "remove", "--force", tempDir], { cwd: publishRepoRoot, stdio: "ignore" });
    if (removeResult.status !== 0) {
      console.warn(`publish-gh-pages: kept temporary worktree ${tempDir}`);
    }
    spawnSync("git", ["branch", "-D", publishBranch], { cwd: publishRepoRoot, stdio: "ignore" });
  }
}

function assertPublishSourceSiteScope(targetRoot, flags) {
  if (flags["allow-partial-publish"]) return;
  const metadataPath = path.join(targetRoot, "metadata.json");
  if (!fs.existsSync(metadataPath)) throw new Error(`publish-gh-pages: missing site metadata at ${metadataPath}`);
  const metadata = readJson(metadataPath);
  const actual = Number(metadata.summary?.total || 0);
  const expected = expectedFullPublishCaseCount(flags);
  if (actual < expected) {
    const selectionText = hasCaseSelection(flags) ? " with a case/category filter" : "";
    throw new Error(
      `publish-gh-pages: refusing to publish partial visual site${selectionText}: summary.total=${actual}, expected at least ${expected}. ` +
        "Run full diff/report/site first, or pass --allow-partial-publish for an explicit partial publish.",
    );
  }
  // A provider whose capture directory is absent/empty still yields a full
  // case list (every case "missing"), so the count guard above passes while
  // the published site shows an entirely blank side for that pair. The
  // tolerance is two-sided (spec: provider-pair-first / Publish guards): a
  // missing capture leg tolerates every pair touching it without blocking the
  // other pairs, but an all-missing pair whose BOTH ends have captures is a
  // pair-generation failure and never folds into "tolerated".
  const comparisons = Array.isArray(metadata.comparisons) && metadata.comparisons.length
    ? metadata.comparisons
    : [{ comparison: metadata.comparison, summary: metadata.summary || {} }];
  const allMissing = comparisons.filter((entry) => {
    const total = Number(entry.summary?.total || 0);
    return total > 0 && Number(entry.summary?.missing || 0) >= total;
  });
  for (const entry of allMissing) {
    const ends = [entry.leftProvider || entry.baseline, entry.rightProvider || entry.current].filter(Boolean);
    if (ends.length === 2 && ends.every((provider) => providerHasCaptures(provider))) {
      throw new Error(
        `publish-gh-pages: refusing to publish site where every ${entry.comparison} case is missing while both ` +
          `${ends.join(" and ")} captures exist: the pair diff produced no entries. ` +
          "Re-run diff for that pair, or pass --allow-partial-publish for an explicit partial publish.",
      );
    }
  }
  if (allMissing.length === comparisons.length) {
    const failed = allMissing.map((entry) => entry.comparison).join(", ");
    throw new Error(
      `publish-gh-pages: refusing to publish site where every case of every pair is missing (${failed}): ` +
        "no provider produced screenshots (absent or empty capture directories). " +
        "Re-run capture, or pass --allow-partial-publish for an explicit partial publish.",
    );
  }
  for (const entry of allMissing) {
    console.warn(
      `publish-gh-pages: tolerating all-missing pair ${entry.comparison} (capture leg absent); other pairs publish normally`,
    );
  }
}

function providerHasCaptures(provider) {
  const dir = path.join(resultRoot, provider);
  if (!fs.existsSync(dir)) return false;
  return fs
    .readdirSync(dir)
    .some((name) => /\.(png|svg|jpe?g|webp)$/i.test(name) && !name.endsWith(".failure.png"));
}

function assertMergedPublishSiteScope(targetSubdir, flags, previousSiteState) {
  if (flags["allow-partial-publish"]) return;
  const nextSiteState = readPublishSiteState(targetSubdir);
  if (!nextSiteState.hasLatestIndex) {
    throw new Error(`publish-gh-pages: refusing to publish site without latest/index.html at ${path.join(targetSubdir, "latest", "index.html")}`);
  }
  if (!nextSiteState.hasIndexJson) {
    throw new Error(`publish-gh-pages: refusing to publish site without index.json at ${path.join(targetSubdir, "index.json")}`);
  }

  const allowCaseDrop = Boolean(flags["allow-case-drop"]);
  // Degraded additive legs (task #498): a capture provider whose artifact is
  // loudly absent (leg failed red upstream — e.g. the iOS capture job) must not
  // block publishing the healthy legs; the workflow passes
  // --allow-degraded-providers=<names> to declare that absence. The flag is
  // validated against the actual capture results, so it can never excuse a leg
  // that DID capture (partial breakage is not degradation). Pairs touching a
  // degraded provider may then shrink or vanish; pairs that do not are still
  // held to their previous totals below, so silent case loss inside a healthy
  // pair (or a silently vanishing pair) keeps failing loudly.
  const degradedProviders = String(flags["allow-degraded-providers"] || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const provider of degradedProviders) {
    if (providerHasCaptures(provider)) {
      throw new Error(
        `publish-gh-pages: --allow-degraded-providers names "${provider}", but ${path.join(resultRoot, provider)} contains captures: ` +
          "a leg that produced screenshots is not degraded — publish it normally, or drop the flag.",
      );
    }
  }
  const pairTouchesDegraded = (pairKey) => degradedProviders.some((provider) => String(pairKey).split("__").includes(provider));
  const previousPairTotals = previousSiteState.pairTotals || {};
  const nextPairTotals = nextSiteState.pairTotals || {};
  if (!allowCaseDrop && Object.keys(previousPairTotals).length > 0) {
    const violations = [];
    for (const [pairKey, previousTotal] of Object.entries(previousPairTotals)) {
      const nextTotal = Number(nextPairTotals[pairKey] || 0);
      if (nextTotal < previousTotal && !pairTouchesDegraded(pairKey)) {
        violations.push(`${pairKey} ${previousTotal} -> ${nextTotal}`);
      }
    }
    if (violations.length) {
      throw new Error(
        `publish-gh-pages: refusing to reduce pair case counts (${violations.join("; ")}). ` +
          "Regenerate the full report, pass --allow-case-drop for an intentional reduction (e.g. retired cases), " +
          "or --allow-degraded-providers=<legs> when an additive capture leg is loudly absent.",
      );
    }
  } else if (!allowCaseDrop && previousSiteState.latestTotal > 0 && nextSiteState.latestTotal > 0 && nextSiteState.latestTotal < previousSiteState.latestTotal) {
    // Legacy fallback for sites whose latest/metadata.json predates per-pair summaries.
    throw new Error(
      `publish-gh-pages: refusing to reduce latest case count from ${previousSiteState.latestTotal} to ${nextSiteState.latestTotal}. ` +
        "Regenerate the full report, or pass --allow-case-drop for an intentional reduction.",
    );
  }
  if (degradedProviders.length) {
    const tolerated = Object.keys(previousPairTotals).filter(
      (pairKey) => pairTouchesDegraded(pairKey) && Number(nextPairTotals[pairKey] || 0) < previousPairTotals[pairKey],
    );
    console.warn(
      `publish-gh-pages: degraded additive leg(s) ${degradedProviders.join(", ")} absent from captures; ` +
        `tolerating pair reductions: ${tolerated.length ? tolerated.join(", ") : "(none needed)"}`,
    );
  }

  // Anti-loss preserve guards for the site's essential artifacts (mirrors the
  // retired raft-ui preserve guard, task #354): once the published site has
  // exposed one of these, a merge that would drop it is refused.
  const preserveGuards = [
    ["homepage index.html with embedded case data (vt-data marker)", previousSiteState.hasStorybookHome, nextSiteState.hasStorybookHome],
    ["latest/home-cases.json (homepage case data)", previousSiteState.hasHomeCases, nextSiteState.hasHomeCases],
  ];
  for (const [label, hadBefore, hasNow] of preserveGuards) {
    if (hadBefore && !hasNow) {
      throw new Error(`publish-gh-pages: refusing to drop ${label} from the published site. Regenerate the full site, or pass --allow-partial-publish for an explicit partial publish.`);
    }
  }
  const checkText = (label, hasNow) => `${label} ${hasNow ? "ok" : "absent"}`;
  console.log(
    "publish-gh-pages preflight: " +
      [
        checkText("latest/index.html", nextSiteState.hasLatestIndex),
        checkText("index.json", nextSiteState.hasIndexJson),
        checkText("storybook homepage", nextSiteState.hasStorybookHome),
        checkText("home-cases.json", nextSiteState.hasHomeCases),
        `latest case count ${previousSiteState.latestTotal || "n/a"} -> ${nextSiteState.latestTotal}`,
      ].join("; "),
  );
}

function readPublishSiteState(siteRoot) {
  const indexJsonPath = path.join(siteRoot, "index.json");
  const indexJson = fs.existsSync(indexJsonPath) ? readJson(indexJsonPath) : null;
  const latestMetadataPath = path.join(siteRoot, "latest", "metadata.json");
  const latestMetadata = fs.existsSync(latestMetadataPath) ? readJson(latestMetadataPath) : null;
  const indexHtmlPath = path.join(siteRoot, "index.html");
  const indexHtml = fs.existsSync(indexHtmlPath) ? fs.readFileSync(indexHtmlPath, "utf8") : "";
  return {
    hasIndexJson: Boolean(indexJson),
    hasLatestIndex: fs.existsSync(path.join(siteRoot, "latest", "index.html")),
    hasHomeCases: fs.existsSync(path.join(siteRoot, "latest", "home-cases.json")),
    // The Storybook-style homepage embeds its case data in a #vt-data JSON
    // block and mounts the sidebar tree/resizer; detect those markers rather
    // than merely checking that some index.html file exists.
    hasStorybookHome: indexHtml.includes('id="vt-data"') && indexHtml.includes('id="vt-tree"'),
    latestTotal: Number(latestMetadata?.summary?.total || indexJson?.latest?.summary?.total || 0),
    // Per-pair case totals (e.g. { react__android: 86, react__ios: 95 }) from
    // latest/metadata.json comparisons[]; falls back to the legacy
    // single-pair top-level `comparison` field when no array exists. Used by
    // the merged-publish guard to hold each non-degraded pair to its previous
    // total instead of only guarding the primary pair's headline number.
    pairTotals: readLatestPairTotals(latestMetadata),
  };
}

function readLatestPairTotals(latestMetadata) {
  const totals = {};
  const comparisons = Array.isArray(latestMetadata?.comparisons) ? latestMetadata.comparisons : [];
  for (const entry of comparisons) {
    const key = entry?.key || entry?.comparison;
    const total = Number(entry?.summary?.total || 0);
    if (key && total > 0) totals[key] = total;
  }
  if (!Object.keys(totals).length && latestMetadata?.comparison) {
    const total = Number(latestMetadata?.summary?.total || 0);
    if (total > 0) totals[latestMetadata.comparison] = total;
  }
  return totals;
}

function removeWorktreeContents(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

function remoteBranchExists(cwd, remote, branch) {
  const fetchResult = spawnSync("git", ["fetch", remote, branch], { cwd, stdio: "ignore" });
  if (fetchResult.status === 0) return true;
  const showRef = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`], { cwd, stdio: "ignore" });
  if (showRef.status === 0) return true;
  const lsRemote = spawnSync("git", ["ls-remote", "--exit-code", "--heads", remote, branch], { cwd, stdio: "ignore" });
  return lsRemote.status === 0;
}

function inferPagesUrl(remote, subdir, publishRepoRoot = repoRoot) {
  const remoteInfo = spawnSync("git", ["remote", "get-url", remote], { cwd: publishRepoRoot, encoding: "utf8" });
  const remoteUrl = remoteInfo.status === 0 ? remoteInfo.stdout.trim() : remote;
  const match = remoteUrl.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/);
  if (!match) return null;
  return `https://${match[1]}.github.io/${match[2]}/${subdir}/`;
}




function anchorId(value) {
  return String(value || "case").replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function validate(flags) {
  const manifest = loadManifest(flags);
  const errors = [];
  const ids = new Set();
  for (const visualCase of manifest.cases || []) {
    if (!visualCase.id) errors.push("case missing id");
    if (visualCase.id && ids.has(visualCase.id)) errors.push(`duplicate case id: ${visualCase.id}`);
    if (visualCase.id) ids.add(visualCase.id);
    if (visualCase.captureType !== undefined && !captureTypeValues.has(String(visualCase.captureType))) {
      errors.push(`${visualCase.id}: captureType must be ${[...captureTypeValues].join(" or ")}`);
    }
    if (visualCase.skip !== undefined && typeof visualCase.skip !== "boolean" && (typeof visualCase.skip !== "object" || Array.isArray(visualCase.skip))) {
      errors.push(`${visualCase.id}: skip must be a boolean or object`);
    }
    if (!visualCase.fixture) errors.push(`${visualCase.id}: missing fixture`);
    if (!Array.isArray(visualCase.variants) || visualCase.variants.length === 0) {
      errors.push(`${visualCase.id}: variants must include at least one state variant`);
    } else {
      const variantIds = new Set();
      for (const variant of visualCase.variants) {
        if (!variant.id) errors.push(`${visualCase.id}: variant missing id`);
        if (variant.id && variantIds.has(variant.id)) errors.push(`${visualCase.id}: duplicate variant id: ${variant.id}`);
        if (variant.id) variantIds.add(variant.id);
        if (variant.interactions && !Array.isArray(variant.interactions)) {
          errors.push(`${visualCase.id}.${variant.id}: interactions must be an array`);
        }
      }
    }
    if (!visualCase.viewport?.width || !visualCase.viewport?.height || !visualCase.viewport?.density) {
      errors.push(`${visualCase.id}: viewport must include width, height, density`);
    }
    if (!visualCase.capture?.selector && !visualCase.selector) errors.push(`${visualCase.id}: missing capture selector`);
    const fullLength = visualCase.capture?.fullLength;
    if (
      fullLength !== undefined &&
      typeof fullLength !== "boolean" &&
      !(fullLength && typeof fullLength === "object" && (fullLength.maxHeight === undefined || (Number.isFinite(fullLength.maxHeight) && fullLength.maxHeight > 0)))
    ) {
      errors.push(`${visualCase.id}: capture.fullLength must be a boolean or { maxHeight: <positive dp> }`);
    }
    if (!visualCase.tolerance?.pixelRatio) errors.push(`${visualCase.id}: missing tolerance.pixelRatio`);
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`validate: ${error}`);
    throw new Error(`Visual Testing Spec validation failed with ${errors.length} error(s)`);
  }
  console.log(`validate: ${manifest.cases.length} cases ok`);
}

function clean() {
  fs.rmSync(artifactRoot, { recursive: true, force: true });
  fs.rmSync(resultRoot, { recursive: true, force: true });
  console.log("clean: removed visual testing artifacts/results");
}

function parseKmpSlockColors(kmpTokenFile) {
  const source = readTextIfExists(kmpTokenFile);
  const colors = {};
  const colorBlock = source.match(/internal\s+object\s+SlockColor\s*\{([\s\S]*?)\n\}/);
  if (!colorBlock) return colors;
  const colorPattern = /val\s+([A-Za-z0-9_]+)\s*=\s*Color\((0x[0-9A-Fa-f]{8})\)/g;
  for (const match of colorBlock[1].matchAll(colorPattern)) {
    colors[match[1]] = normalizeHex(match[2]);
  }
  return colors;
}

function tokenNamesForHex(sharedColors) {
  const byHex = new Map();
  for (const [name, hex] of Object.entries(sharedColors || {})) {
    const normalized = normalizeHex(hex);
    if (!normalized) continue;
    if (!byHex.has(normalized)) byHex.set(normalized, []);
    byHex.get(normalized).push(name);
  }
  return byHex;
}

function lineNumberForOffset(source, offset) {
  return source.slice(0, offset).split(/\n/).length;
}

function scanHardcodedColorUsage({ root, files, allowedFiles, sharedColors, label }) {
  const knownByHex = tokenNamesForHex(sharedColors);
  const usage = [];
  for (const file of files) {
    const relative = path.relative(root, file);
    const source = fs.readFileSync(file, "utf8");
    const hexPattern = /(?<![A-Za-z0-9])#([0-9A-Fa-f]{6})(?:[0-9A-Fa-f]{2})?(?![A-Za-z0-9])/g;
    for (const match of source.matchAll(hexPattern)) {
      const hex = normalizeHex(match[0]);
      if (!hex) continue;
      usage.push({
        provider: label,
        file: relative,
        line: lineNumberForOffset(source, match.index),
        value: hex,
        tokenNames: knownByHex.get(hex) || [],
        allowedFile: allowedFiles.has(relative),
      });
    }
    const colorPattern = /Color\(\s*0x([0-9A-Fa-f]{8})\s*\)/g;
    for (const match of source.matchAll(colorPattern)) {
      const hex = normalizeHex(match[1]);
      if (!hex) continue;
      usage.push({
        provider: label,
        file: relative,
        line: lineNumberForOffset(source, match.index),
        value: hex,
        tokenNames: knownByHex.get(hex) || [],
        allowedFile: allowedFiles.has(relative),
      });
    }
  }
  return usage;
}

function tokenAuditClassificationFor(item, classifications) {
  const providerEntries = classifications?.unknownColors?.[item.provider] || [];
  return providerEntries.find((entry) => {
    if (entry.file && entry.file !== item.file) return false;
    if (entry.value && normalizeHex(entry.value) !== item.value) return false;
    return true;
  }) || null;
}

function summarizeTokenUsage(usage, classifications) {
  const unknown = usage.filter((item) => !item.allowedFile && item.tokenNames.length === 0);
  const knownHardcoded = usage.filter((item) => !item.allowedFile && item.tokenNames.length > 0);
  const allowed = usage.filter((item) => item.allowedFile);
  const classifiedUnknown = unknown.filter((item) => tokenAuditClassificationFor(item, classifications));
  const unclassifiedUnknown = unknown.filter((item) => !tokenAuditClassificationFor(item, classifications));
  const unknownByFile = countBy(unknown, (item) => item.file);
  const unclassifiedUnknownByFile = countBy(unclassifiedUnknown, (item) => item.file);
  const knownByFile = countBy(knownHardcoded, (item) => item.file);
  return {
    total: usage.length,
    allowed: allowed.length,
    knownTokenHardcoded: knownHardcoded.length,
    unknownHardcoded: unknown.length,
    classifiedUnknownHardcoded: classifiedUnknown.length,
    unclassifiedUnknownHardcoded: unclassifiedUnknown.length,
    unknownTopFiles: topEntries(unknownByFile, 10),
    unclassifiedUnknownTopFiles: topEntries(unclassifiedUnknownByFile, 10),
    knownTokenTopFiles: topEntries(knownByFile, 10),
  };
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function topEntries(map, limit) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function renderTokenAuditMarkdown(audit) {
  const sourceRows = audit.sourceOfTruth.results
    .map((item) => `| ${item.webToken} | ${item.webHex || "-"} | ${item.kmpName || "-"} | ${item.kmpHex || "-"} | ${item.status} |`)
    .join("\n");
  const usageRows = Object.entries(audit.usage)
    .map(([provider, summary]) => `| ${provider} | ${summary.total} | ${summary.allowed} | ${summary.knownTokenHardcoded} | ${summary.unknownHardcoded} | ${summary.classifiedUnknownHardcoded} | ${summary.unclassifiedUnknownHardcoded} |`)
    .join("\n");
  const unknownSections = Object.entries(audit.usage)
    .map(([provider, summary]) => {
      const rows = summary.unknownTopFiles.map((item) => `- ${item.key}: ${item.count}`).join("\n") || "- none";
      const unclassifiedRows = summary.unclassifiedUnknownTopFiles.map((item) => `- ${item.key}: ${item.count}`).join("\n") || "- none";
      return `### ${provider} Unknown Hardcoded Color Files\n${rows}\n\n#### ${provider} Unclassified Unknown Hardcoded Color Files\n${unclassifiedRows}`;
    })
    .join("\n\n");
  return `# Slock Token Audit

Generated: ${audit.generatedAt}

## Source Of Truth

Status: ${audit.sourceOfTruth.status}

| Web token | Web hex | KMP name | KMP hex | Status |
| --- | --- | --- | --- | --- |
${sourceRows}

## Hardcoded Usage Summary

Allowed files include palette/token demo surfaces and token definition files. Known-token hardcoding means a real surface used a token hex directly instead of a token name; unknown hardcoding means the color is not in the shared token set.

| Provider | Total | Allowed | Known token hardcoded | Unknown hardcoded | Classified unknown | Unclassified unknown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${usageRows}

${unknownSections}
`;
}

function tokenAudit(flags) {
  assertReactSourceReady("token-audit");
  const androidRepoDir = path.resolve(flags["android-repo-dir"] || process.env.SLOCK_ANDROID_REPO_DIR || defaultAndroidRepoRoot);
  const kmpTokenFile = path.join(androidRepoDir, flags["kmp-token-path"] || defaultKmpTokenPath);
  const sharedTokens = readJson(sharedTokensPath);
  const sharedColors = sharedTokens.colors || {};
  const classifications = fs.existsSync(tokenAuditClassificationPath) ? readJson(tokenAuditClassificationPath) : {};
  const kmpColors = parseKmpSlockColors(kmpTokenFile);
  const results = Object.entries(sharedColors).map(([webToken, webValue]) => {
    const kmpName = tokenKmpColorMap[webToken];
    const webHex = normalizeHex(webValue);
    const kmpHex = kmpColors[kmpName];
    const status = !kmpName ? "missing-kmp-mapping" : !kmpHex ? "missing-kmp-token" : webHex === kmpHex ? "match" : "mismatch";
    return { webToken, webHex, kmpName, kmpHex, status };
  });
  const sourceOfTruthErrors = results.filter((item) => item.status !== "match");
  const reactFiles = walk(srcRoot, (file) => /\.(tsx|ts|css|json)$/.test(file) && !file.includes(`${path.sep}node_modules${path.sep}`));
  const kmpRoot = path.join(androidRepoDir, "compose", "shared", "src", "commonMain", "kotlin", "ai", "slock", "compose");
  const kmpFiles = walk(kmpRoot, (file) => /\.kt$/.test(file));
  const reactUsage = scanHardcodedColorUsage({
    root: reactRepoRoot,
    files: reactFiles,
    allowedFiles: tokenAuditAllowedReactFiles,
    sharedColors,
    label: "react",
  });
  const kmpUsage = scanHardcodedColorUsage({
    root: androidRepoDir,
    files: kmpFiles,
    allowedFiles: tokenAuditAllowedKmpFiles,
    sharedColors,
    label: "kmp",
  });
  const audit = {
    version: 1,
    generatedAt: new Date().toISOString(),
    inputs: {
      sharedTokens: path.relative(repoRoot, sharedTokensPath),
      reactRepoDir: reactRepoRoot,
      androidRepoDir,
      kmpTokenFile: path.relative(androidRepoDir, kmpTokenFile),
    },
    sourceOfTruth: {
      status: sourceOfTruthErrors.length === 0 ? "pass" : "fail",
      mapping: tokenKmpColorMap,
      results,
      errors: sourceOfTruthErrors,
    },
    classifications: {
      path: path.relative(repoRoot, tokenAuditClassificationPath),
      version: classifications.version || 0,
    },
    usage: {
      react: summarizeTokenUsage(reactUsage, classifications),
      kmp: summarizeTokenUsage(kmpUsage, classifications),
    },
    usageSamples: {
      reactUnknown: reactUsage.filter((item) => !item.allowedFile && item.tokenNames.length === 0).slice(0, 50),
      kmpUnknown: kmpUsage.filter((item) => !item.allowedFile && item.tokenNames.length === 0).slice(0, 50),
      reactUnclassifiedUnknown: reactUsage.filter((item) => !item.allowedFile && item.tokenNames.length === 0 && !tokenAuditClassificationFor(item, classifications)).slice(0, 50),
      kmpUnclassifiedUnknown: kmpUsage.filter((item) => !item.allowedFile && item.tokenNames.length === 0 && !tokenAuditClassificationFor(item, classifications)).slice(0, 50),
      reactKnownTokenHardcoded: reactUsage.filter((item) => !item.allowedFile && item.tokenNames.length > 0).slice(0, 50),
      kmpKnownTokenHardcoded: kmpUsage.filter((item) => !item.allowedFile && item.tokenNames.length > 0).slice(0, 50),
    },
  };
  const jsonPath = path.join(artifactRoot, "token-audit.json");
  const markdownPath = path.join(artifactRoot, "token-audit.md");
  writeJson(jsonPath, audit);
  fs.writeFileSync(markdownPath, renderTokenAuditMarkdown(audit));
  console.log(`token-audit: source ${audit.sourceOfTruth.status}; react unknown ${audit.usage.react.unknownHardcoded}; kmp unknown ${audit.usage.kmp.unknownHardcoded}`);
  console.log(`token-audit: wrote ${path.relative(repoRoot, jsonPath)} and ${path.relative(repoRoot, markdownPath)}`);
  if (sourceOfTruthErrors.length > 0 && !flags["allow-token-drift"]) {
    for (const error of sourceOfTruthErrors) {
      console.error(`token-audit: ${error.webToken} ${error.webHex} != ${error.kmpName || "unmapped"} ${error.kmpHex || "missing"}`);
    }
    throw new Error(`Token source-of-truth audit failed with ${sourceOfTruthErrors.length} error(s)`);
  }
  if (flags["strict-usage"]) {
    const usageBudget = classifications?.gate?.usageBudget || {};
    const failures = [];
    for (const provider of ["react", "kmp"]) {
      const summary = audit.usage[provider];
      const budget = usageBudget[provider] || {};
      const maxKnown = budget.maxKnownTokenHardcoded ?? 0;
      const maxUnclassifiedUnknown = budget.maxUnclassifiedUnknownHardcoded ?? 0;
      if (summary.knownTokenHardcoded > maxKnown) {
        failures.push(`${provider} known-token hardcode ${summary.knownTokenHardcoded} > ${maxKnown}`);
      }
      if (summary.unclassifiedUnknownHardcoded > maxUnclassifiedUnknown) {
        failures.push(`${provider} unclassified unknown hardcode ${summary.unclassifiedUnknownHardcoded} > ${maxUnclassifiedUnknown}`);
      }
    }
    if (failures.length > 0) {
      failures.forEach((failure) => console.error(`token-audit: strict usage failed: ${failure}`));
      throw new Error(`Token usage audit failed with ${failures.length} error(s)`);
    }
  }
}

const fixtureDataPath = path.join(sharedVisualRoot, "fixtureData.json");

function kotlinConstName(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

function kotlinObjectName(key) {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function kotlinLiteral(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  throw new Error(`unsupported fixture scalar: ${JSON.stringify(value)}`);
}

function isFlatScalarObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.values(value).every((item) => item === null || typeof item !== "object");
}

function emitKotlinObject(name, value, indent) {
  const pad = "    ".repeat(indent);
  const lines = [`${pad}object ${kotlinObjectName(name)} {`];
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      lines.push(emitKotlinObject(key, item, indent + 1));
    } else if (Array.isArray(item)) {
      if (item.every((entry) => entry === null || typeof entry !== "object")) {
        const rendered = item.map((entry) => kotlinLiteral(entry)).join(", ");
        lines.push(`${"    ".repeat(indent + 1)}val ${kotlinConstName(key)}: List<String> = listOf(${rendered})`);
      } else {
        item.forEach((entry, index) => {
          lines.push(emitKotlinObject(`${key}${index + 1}`, entry, indent + 1));
        });
        // Rows of flat scalar objects also come as one list, so a fixture page
        // can iterate them and the row count/order stays in fixtureData.json.
        if (item.every(isFlatScalarObject)) {
          const rows = item.map((entry) => {
            const fields = Object.entries(entry).map(([field, scalar]) => `${JSON.stringify(field)} to ${kotlinLiteral(scalar)}`);
            return `${"    ".repeat(indent + 2)}mapOf<String, Any?>(${fields.join(", ")}),`;
          });
          lines.push(`${"    ".repeat(indent + 1)}val ${kotlinConstName(key)}: List<Map<String, Any?>> = listOf(`);
          lines.push(...rows);
          lines.push(`${"    ".repeat(indent + 1)})`);
        }
      }
    } else if (item === null) {
      lines.push(`${"    ".repeat(indent + 1)}val ${kotlinConstName(key)}: String? = null`);
    } else if (typeof item === "string") {
      lines.push(`${"    ".repeat(indent + 1)}const val ${kotlinConstName(key)}: String = ${kotlinLiteral(item)}`);
    } else if (typeof item === "number") {
      const kotlinType = Number.isInteger(item) ? (Math.abs(item) > 2147483647 ? "Long" : "Int") : "Double";
      const suffix = kotlinType === "Long" ? "L" : "";
      lines.push(`${"    ".repeat(indent + 1)}const val ${kotlinConstName(key)}: ${kotlinType} = ${item}${suffix}`);
    } else if (typeof item === "boolean") {
      lines.push(`${"    ".repeat(indent + 1)}const val ${kotlinConstName(key)}: Boolean = ${item}`);
    }
  }
  lines.push(`${pad}}`);
  return lines.join("\n");
}

function renderFixtureDataKotlin(fixtureData) {
  const body = ["server", "humans", "agents", "machines", "latestVersions", "channels", "locale", "times", "registerForm", "messages", "files", "homeChannelList"]
    .filter((key) => fixtureData[key] !== undefined)
    .map((key) => emitKotlinObject(key, fixtureData[key], 1))
    .join("\n\n");
  return `package build.raft.app

// GENERATED FILE - DO NOT EDIT.
// Source of truth: packages/visual-testing/shared/fixtureData.json in the React repo.
// Regenerate: slock-visual generate-fixture-data --android-repo-dir /path/to/mobile
// Android visual fixture pages must read identity/copy/time values from this
// object so React and Android captures render identical fixture data.
@Suppress("unused", "MemberVisibilityCanBePrivate")
object VisualFixtureData {
${body}
}
`;
}

function generateFixtureData(flags) {
  const fixtureData = readJson(fixtureDataPath);
  const rendered = renderFixtureDataKotlin(fixtureData);
  const outPath = flags.out
    ? path.resolve(String(flags.out))
    // src/visualFixtureData: compiled into commonMain for the gated visual pages and into
    // commonTest otherwise, so JVM unit tests can render fixtures from it too.
    : path.join(defaultAndroidRepoRoot, "compose", "shared", "src", "visualFixtureData", "kotlin", "build", "raft", "app", "VisualFixtureData.kt");
  if (flags.check) {
    const existing = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : null;
    if (existing === rendered) {
      console.log(`generate-fixture-data: ${outPath} is up to date`);
      return;
    }
    throw new Error(
      `generate-fixture-data: ${outPath} ${existing === null ? "is missing" : "has drifted from fixtureData.json"}. ` +
        "Regenerate with slock-visual generate-fixture-data.",
    );
  }
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, rendered);
  console.log(`generate-fixture-data: wrote ${outPath}`);
}

function usage() {
  console.log(`Usage:
  slock-visual scan [--react-repo-dir /path/to/slock]
  slock-visual validate [--manifest artifacts/visual-testing/visual-testing-cases.json|shared]
  slock-visual token-audit [--react-repo-dir /path/to/slock] [--android-repo-dir ~/AndroidStudioProjects/Slock] [--allow-token-drift] [--strict-usage]
  slock-visual capture --providers react
  slock-visual capture --providers android|ios [--case case.id] --command './capture-provider.sh'
  slock-visual diff [--pairs react__android,react__ios,android__ios] [--case case.id] [--category 'app/home/*'] [--include-pending]
  slock-visual diff [--baseline react] [--current android|ios|android,ios] [--case case.id] [--include-skipped]
  slock-visual overlay [--pairs react__android] [--baseline react] [--current android] [--case case.id] [--alpha 0.5] [--region x,y,width,height] [--region-name runtime]
  slock-visual analyze [--pairs ...|--baseline react --current android,ios] [--model MODEL] [--force] [--skip-model]
  slock-visual report [--pairs ...|--baseline react --current android,ios] [--skip-analysis]
  slock-visual site [--pairs ...|--baseline react --current android,ios] [--skip-analysis] [--site-dir artifacts/visual-testing-site]
  slock-visual publish-gh-pages [--pairs ...|--baseline react --current android,ios] [--repo-dir ../slock-android] [--remote origin] [--branch gh-pages] [--subdir visual-testing] [--dry-run] [--reset-runs] [--skip-analysis] [--allow-partial-publish] [--allow-case-drop] [--allow-degraded-providers ios,...]
  slock-visual generate-fixture-data [--android-repo-dir ~/AndroidStudioProjects/Slock] [--out /path/VisualFixtureData.kt] [--check]
  slock-visual all
  slock-visual clean

Comparison pairs:
  --pairs a__b,c__d             explicit pair list; keys canonicalize by provider
                                precedence react > android > ios > ohos
                                (ios__android -> android__ios)
  --baseline X --current a,b    sugar for --pairs X__a,X__b

Analysis model env:
  MINIMAX_API_KEY / PI_API_KEY  use the pi SDK (@earendil-works/pi-ai) directly; unset -> codex CLI fallback
  PI_MODEL                      pi model id (default MiniMax-M3.1-Flash-Preview); --model wins
  PI_PROVIDER                   pi provider id (default minimax)

External provider env:
  SLOCK_VISUAL_PROVIDER
  SLOCK_VISUAL_CASE_ID
  SLOCK_VISUAL_VARIANT_ID
  SLOCK_VISUAL_CASE_JSON
  SLOCK_VISUAL_RESULT_DIR
`);
}

async function main() {
  const { command, flags } = parseArgs(process.argv);
  switch (command) {
    case "scan":
      scanReact();
      break;
    case "validate":
      validate(flags);
      break;
    case "token-audit":
      tokenAudit(flags);
      break;
    case "capture":
      capture(flags);
      break;
    case "diff":
      diff(flags);
      break;
    case "overlay":
      overlay(flags);
      break;
    case "analyze":
      await analyze(flags);
      break;
    case "report":
      await report(flags);
      break;
    case "site":
      await site(flags);
      break;
    case "publish-gh-pages":
      await publishGhPages(flags);
      break;
    case "all":
      scanReact();
      validate(flags);
      capture(flags);
      diff(flags);
      await report(flags);
      break;
    case "generate-fixture-data":
      generateFixtureData(flags);
      break;
    case "clean":
      clean();
      break;
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      usage();
      throw new Error(`Unknown command: ${command}`);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`visual-testing: ${message}`);
  process.exitCode = 1;
}
