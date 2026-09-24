// Raft Visual Testing homepage app.
// Inlined into the generated index.html by siteHomeHtml (packages/visual-testing/src/cli.mjs);
// the case data is embedded as JSON in the #vt-data script tag at build time.
(function () {
  var DATA = JSON.parse(document.getElementById("vt-data").textContent);
  var SURFACE_ORDER = ["ui", "library", "home", "channel", "thread", "members", "tasks", "settings", "auth", "navigation", "screens"];
  var BG_MODES = ["", "white", "dark"];
  var ICONS = {
    caret: '<svg class="sb-caret" width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M2 3.2h6L5 7.6z"/></svg>',
    folder: '<svg class="sb-glyph" width="13" height="13" viewBox="0 0 14 14" fill="currentColor"><path d="M1.4 3.4h3.4l1 1.2h6.8v6.6H1.4z" opacity=".85"/></svg>',
    component: '<svg class="sb-glyph" width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2" y="2" width="10" height="10" rx="1.6"/><circle cx="7" cy="7" r="1.5" fill="currentColor" stroke="none"/></svg>',
    search: '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="5.5" cy="5.5" r="4"/><path d="M8.6 8.6L12 12"/></svg>',
    zoomIn: '<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="6" cy="6" r="4"/><path d="M9.2 9.2L13 13"/><path d="M6 4v4M4 6h4"/></svg>',
    zoomOut: '<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="6" cy="6" r="4"/><path d="M9.2 9.2L13 13"/><path d="M4 6h4"/></svg>',
    reset: '<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12.6 7.5a5.1 5.1 0 1 1-1.6-3.7"/><path d="M12.9 2.4v3.1h-3.1"/></svg>',
    bg: '<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="7.5" cy="7.5" r="5.2"/><path d="M7.5 2.3a5.2 5.2 0 0 1 0 10.4z" fill="currentColor" stroke="none"/></svg>',
    fit: '<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5.4V2.4h3M13 5.4V2.4h-3M2 9.6v3h3M13 9.6v3h-3"/></svg>',
    menu: '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>',
    copy: '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="4.6" y="4.1" width="7" height="8.4" rx="1.4"/><path d="M9.4 4.1V2.9A1.4 1.4 0 0 0 8 1.5H3.9a1.4 1.4 0 0 0-1.4 1.4v6.2a1.4 1.4 0 0 0 1.4 1.4h.7"/></svg>',
    check: '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 7.6l3 3 5.8-6.4"/></svg>'
  };

  var tree = document.getElementById("vt-tree");
  var searchInput = document.getElementById("vt-search");
  var overview = document.getElementById("vt-overview");
  var stageWrap = document.getElementById("vt-stage-wrap");
  var stage = document.getElementById("vt-stage");
  var canvas = document.getElementById("vt-canvas");
  var storyTitle = document.getElementById("vt-story-title");
  var compTabsBox = document.getElementById("vt-comptabs");
  var toolsBox = document.getElementById("vt-tools");
  var toolsSep = document.getElementById("vt-tools-sep");
  var addons = document.getElementById("vt-addons");
  var addonResizer = document.getElementById("vt-addon-resizer");
  var addonTabbar = document.getElementById("vt-addon-tabbar");
  var addonBody = document.getElementById("vt-addon-body");
  var runsBox = document.getElementById("vt-runs");
  var menuBtn = document.getElementById("vt-menu");
  var backdrop = document.getElementById("vt-backdrop");
  var brandHome = document.getElementById("vt-brand-home");

  var caseById = {};
  var rowById = {};
  var selectedId = null;
  var compTab = null;
  // One-shot tab request consumed by the next renderCase (matrix cell click
  // preselects a provider's raw tab instead of the side-by-side default).
  var pendingCompTab = null;
  var addonTab = "metrics";
  var zoom = 1;
  var bgIndex = 0;
  var actualSize = false;
  // Overview scroll position, saved when leaving the waterfall so browser
  // Back restores it instead of jumping to the top (task #384).
  var overviewScrollTop = 0;

  function statusKind(status) {
    if (status === "different") return "different";
    if (status === "missing" || status === "error") return "missing";
    if (status === "pass" || status === "basic-pass" || status === "same") return "pass";
    return "other";
  }
  function pct(value, digits) {
    if (typeof value !== "number") return null;
    return (value * 100).toFixed(digits === undefined ? 1 : digits) + "%";
  }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function svgSpan(markup) {
    var span = document.createElement("span");
    span.style.display = "inline-flex";
    span.innerHTML = markup;
    return span.firstChild;
  }
  function tc(value) {
    value = String(value || "");
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
  }
  function providerTitle(value) {
    value = String(value || "");
    if (value.toLowerCase() === "ios") return "iOS";
    if (value.toLowerCase() === "ohos") return "OHOS";
    return tc(value);
  }
  // Provider accent identity (spec: provider-pair-first, Goal 5): a small dot
  // in the provider's fixed accent (--provider-<id> in home.css; unknown
  // providers fall back to --faint). Corner badges on side-by-side images are
  // baked in by the CLI compositor, so accents live on site chrome only.
  function providerDot(provider) {
    var dot = el("span", "sb-provdot");
    dot.style.background = "var(--provider-" + String(provider || "").toLowerCase() + ", var(--faint))";
    return dot;
  }
  function anchorId(id) {
    return String(id).replace(/[^a-zA-Z0-9]+/g, "-");
  }
  function dims(w, h) {
    return (w && h) ? (w + " x " + h) : "-";
  }

  // ----- pair-first data model (spec: provider-pair-first, task #430) -----
  // New runs embed DATA.pairs plus per-case providers{}/pairs{} indexes. Old
  // published runs (vt-data without `pairs`) are adapted right here — this
  // block is the ONLY reader of the legacy primary/extras fields; everything
  // below renders from the pair model.
  (function adoptLegacyData() {
    if (DATA.pairs && DATA.pairs.length) return;
    var comps = (DATA.comparisons && DATA.comparisons.length)
      ? DATA.comparisons
      : [{ baseline: DATA.baseline, current: DATA.current, comparison: DATA.baseline + "__" + DATA.current, summary: DATA.summary || {}, analysisSummary: DATA.analysisSummary || {} }];
    DATA.pairs = comps.map(function (c) {
      var leftLabel = c.baselineLabel || tc(c.baseline);
      var rightLabel = c.currentLabel || providerTitle(c.current);
      return {
        key: c.comparison || (c.baseline + "__" + c.current),
        leftProvider: c.baseline,
        rightProvider: c.current,
        leftLabel: leftLabel,
        rightLabel: rightLabel,
        label: leftLabel + " ↔ " + rightLabel,
        class: (c.baseline === "react" || c.current === "react") ? "baseline" : "cross-platform",
        summary: c.summary || {},
        analysisSummary: c.analysisSummary || {}
      };
    });
    (DATA.cases || []).forEach(function (item) {
      if (item.pairs) return;
      var providers = {};
      var pairs = {};
      function addProvider(provider, image) {
        if (!provider || (providers[provider] && providers[provider].status === "captured")) return;
        providers[provider] = { status: image ? "captured" : "missing", image: image || null };
      }
      addProvider(DATA.baseline, item.baselineImage);
      addProvider(DATA.current, item.currentImage);
      pairs[DATA.pairs[0].key] = {
        leftProvider: DATA.baseline,
        rightProvider: DATA.current,
        status: item.status,
        similarity: item.similarity,
        rgbSimilarity: item.rgbSimilarity,
        sideBySideImage: item.sideBySideImage,
        metrics: item.metrics,
        analysis: item.analysis
      };
      (item.comparisons || []).forEach(function (c) {
        addProvider(c.current, c.currentImage);
        pairs[c.comparison || (DATA.baseline + "__" + c.current)] = {
          leftProvider: DATA.baseline,
          rightProvider: c.current,
          status: c.status,
          similarity: c.similarity,
          rgbSimilarity: c.rgbSimilarity,
          sideBySideImage: c.sideBySideImage,
          metrics: c.metrics,
          analysis: c.analysis
        };
      });
      item.providers = providers;
      item.pairs = pairs;
    });
  })();

  var pairDefs = DATA.pairs || [];
  var pairByKey = {};
  pairDefs.forEach(function (def) {
    if (!def.leftLabel) def.leftLabel = providerTitle(def.leftProvider);
    if (!def.rightLabel) def.rightLabel = providerTitle(def.rightProvider);
    pairByKey[def.key] = def;
  });

  // URL keys are normalized to the canonical order here; everywhere else a
  // pair's ends come from its entry, never from parsing the key.
  function canonicalPairKey(raw) {
    raw = String(raw || "");
    if (!raw) return null;
    if (pairByKey[raw]) return raw;
    var parts = raw.split("__");
    if (parts.length === 2) {
      var flipped = parts[1] + "__" + parts[0];
      if (pairByKey[flipped]) return flipped;
    }
    return null;
  }

  function queryParam(query, name) {
    var parts = String(query || "").split("&");
    for (var i = 0; i < parts.length; i += 1) {
      var kv = parts[i].split("=");
      if (kv[0] === name) return decodeURIComponent(kv.slice(1).join("=") || "");
    }
    return null;
  }
  function comparisonKeyFromLocation() {
    var match = /^#case\/[^?]*\?(.*)$/.exec(location.hash || "");
    var key = match ? queryParam(match[1], "comparison") : null;
    return key || queryParam((location.search || "").replace(/^\?/, ""), "comparison");
  }

  var selectedPairKey = canonicalPairKey(comparisonKeyFromLocation()) || (pairDefs[0] && pairDefs[0].key) || null;

  function selectedPair() {
    return pairByKey[selectedPairKey] || pairDefs[0] || null;
  }
  function casePairEntry(item) {
    return (item && item.pairs && item.pairs[selectedPairKey]) || null;
  }
  function caseProviderEntry(item, provider) {
    return (item && item.providers && item.providers[provider]) || null;
  }
  // Declared renderer fallbacks (task #441): capability facts captured from
  // the SLOCK_RICHTEXT_CAPS marker. Attribution only -- badges never change
  // pass/fail counting (acceptance stays with case policy).
  function divergenceLabel(d) {
    if (d && typeof d === "object") return String(d.id || d.description || "divergence");
    return String(d);
  }
  function providerDeclaredFallbacks(entry) {
    var meta = entry && entry.metadata;
    if (!meta) return null;
    var falseCaps = [];
    var caps = meta.richTextCapabilities || {};
    for (var key in caps) {
      if (Object.prototype.hasOwnProperty.call(caps, key) && caps[key] === false) falseCaps.push(key);
    }
    var divergences = meta.declaredDivergences || [];
    if (!falseCaps.length && !divergences.length) return null;
    return { falseCaps: falseCaps, divergences: divergences };
  }
  function pairDeclaredCount(pair) {
    if (!pair) return 0;
    var count = 0;
    (DATA.cases || []).forEach(function (item) {
      var left = providerDeclaredFallbacks(caseProviderEntry(item, pair.leftProvider));
      var right = providerDeclaredFallbacks(caseProviderEntry(item, pair.rightProvider));
      if (left || right) count += 1;
    });
    return count;
  }

  // ----- copy-id buttons (task #366) -----
  function fallbackCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (error) {
      return false;
    }
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return fallbackCopy(text); }
      );
    }
    return Promise.resolve(fallbackCopy(text));
  }
  // tagName "span" is used inside .sb-wcard (a <button>) where a nested
  // <button> would be invalid HTML; stopPropagation keeps the card click
  // from firing when the copy control is used.
  function copyIdButton(id, tagName) {
    var btn = document.createElement(tagName || "button");
    if (btn.tagName === "BUTTON") btn.type = "button";
    else { btn.setAttribute("role", "button"); btn.tabIndex = 0; }
    btn.className = "sb-copy";
    btn.title = "Copy id: " + id;
    btn.setAttribute("aria-label", "Copy case id");
    btn.innerHTML = ICONS.copy;
    var revertTimer = null;
    function activate(event) {
      event.stopPropagation();
      event.preventDefault();
      copyText(id).then(function (ok) {
        btn.innerHTML = ok ? ICONS.check : ICONS.copy;
        btn.classList.toggle("ok", Boolean(ok));
        btn.title = ok ? "Copied" : btn.title;
        if (revertTimer) clearTimeout(revertTimer);
        revertTimer = setTimeout(function () {
          btn.innerHTML = ICONS.copy;
          btn.classList.remove("ok");
          btn.title = "Copy id: " + id;
        }, 1000);
      });
    }
    btn.addEventListener("click", activate);
    btn.addEventListener("keydown", function (event) {
      if (btn.tagName !== "BUTTON" && (event.key === "Enter" || event.key === " ")) activate(event);
    });
    return btn;
  }

  // ----- mobile drawer (task #365b) -----
  var mobileQuery = window.matchMedia ? window.matchMedia("(max-width: 767px)") : { matches: false };
  function openDrawer() {
    document.body.classList.add("drawer-open");
    if (backdrop) backdrop.hidden = false;
  }
  function closeDrawer() {
    document.body.classList.remove("drawer-open");
    if (backdrop) backdrop.hidden = true;
  }
  if (menuBtn) {
    menuBtn.addEventListener("click", function () {
      if (document.body.classList.contains("drawer-open")) closeDrawer();
      else openDrawer();
    });
  }
  if (backdrop) backdrop.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeDrawer();
  });
  // Crossing the breakpoint back to desktop deactivates the drawer CSS but
  // would otherwise leave body.drawer-open set and the backdrop covering the
  // page — close the drawer whenever we leave the mobile layout.
  function onMobileQueryChange(event) {
    if (!event.matches) closeDrawer();
  }
  if (mobileQuery.addEventListener) mobileQuery.addEventListener("change", onMobileQueryChange);
  else if (mobileQuery.addListener) mobileQuery.addListener(onMobileQueryChange);

  // ----- runs footer -----
  (DATA.runs || []).forEach(function (run) {
    var link = document.createElement("a");
    link.className = "sb-run";
    link.href = run.href;
    link.appendChild(el("code", null, run.runId));
    var subject = el("span", "subj", run.commitSubject || (run.baseline + " vs " + run.current));
    subject.title = (run.commitSubject || "") + (run.generatedAt ? " · " + run.generatedAt : "");
    link.appendChild(subject);
    runsBox.appendChild(link);
  });
  if (!(DATA.runs || []).length) runsBox.appendChild(el("div", "subj", "No runs recorded"));

  // ----- sidebar tree -----
  function caseLabel(item) {
    return item.title && item.title !== item.id ? item.title : item.id.replace(/^components\./, "");
  }
  var groups = {};
  (DATA.cases || []).forEach(function (item) {
    caseById[item.id] = item;
    var key = item.surface || "other";
    (groups[key] = groups[key] || []).push(item);
  });
  var groupKeys = Object.keys(groups).sort(function (a, b) {
    var ia = SURFACE_ORDER.indexOf(a); if (ia === -1) ia = SURFACE_ORDER.length;
    var ib = SURFACE_ORDER.indexOf(b); if (ib === -1) ib = SURFACE_ORDER.length;
    return (ia - ib) || a.localeCompare(b);
  });
  if (!groupKeys.length) {
    tree.appendChild(el("div", "sb-empty", "No case-level data embedded for this run."));
  }
  var orderedCases = [];

  // Similarity/status trailer on a tree row, bound to the selected pair.
  function decorateTreeRow(row, item) {
    var old = row.querySelector(".sb-pct");
    if (old) old.parentNode.removeChild(old);
    old = row.querySelector(".sb-dot");
    if (old) old.parentNode.removeChild(old);
    var entry = casePairEntry(item) || {};
    var p = pct(entry.similarity);
    if (p) row.appendChild(el("span", "sb-pct", p));
    row.appendChild(el("span", "sb-dot " + statusKind(entry.status)));
  }
  function updateTreeRows() {
    Object.keys(rowById).forEach(function (id) {
      decorateTreeRow(rowById[id], caseById[id]);
    });
  }

  function makeLeafRow(item, leafName) {
    var row = el("button", "sb-row");
    row.type = "button";
    row.dataset.caseId = item.id;
    row.title = caseLabel(item) + " · " + item.id;
    row.appendChild(svgSpan(ICONS.component));
    row.appendChild(el("span", "name", leafName));
    decorateTreeRow(row, item);
    row.addEventListener("click", function () { selectCase(item.id, true); });
    rowById[item.id] = row;
    orderedCases.push(item);
    return row;
  }

  // Storybook-style title folding, applied inside every surface group:
  // siblings whose titles share a leading word-prefix (>= 3 of them) fold
  // into a folder named by that prefix, with the prefix stripped from the
  // leaf names. The partition is recursive so maximal prefixes win — e.g.
  // "Settings Administration ..." x3 becomes its own "Settings
  // Administration" folder next to a shorter "Settings" folder for the
  // rest, and "Raft UI ..." folds to a single "Raft UI" folder.
  function labelWords(item) {
    return caseLabel(item).split(/\s+/).filter(Boolean);
  }
  // items all share their first "len" words; returns maximal buckets
  // [{ len, items }] such that every bucket keeps >= 3 members (or is the
  // level-"len" remainder for members that could not extend further).
  function partitionByPrefix(items, len) {
    var buckets = [];
    var remain = [];
    var byWord = {};
    items.forEach(function (item) {
      var words = labelWords(item);
      // needs one more prefix word AND a non-empty leaf name after it
      if (words.length >= len + 2) (byWord[words[len]] = byWord[words[len]] || []).push(item);
      else remain.push(item);
    });
    Object.keys(byWord).forEach(function (word) {
      var sub = byWord[word];
      if (sub.length >= 3) {
        buckets = buckets.concat(partitionByPrefix(sub, len + 1));
      } else {
        remain = remain.concat(sub);
      }
    });
    if (remain.length) buckets.push({ len: len, items: remain });
    return buckets;
  }
  function foldGroupItems(items) {
    var byFirst = {};
    var nodes = [];
    items.forEach(function (item) {
      var words = labelWords(item);
      var key = words.length >= 2 ? words[0].toLowerCase() : "";
      (byFirst[key] = byFirst[key] || []).push(item);
    });
    Object.keys(byFirst).forEach(function (first) {
      var bucket = byFirst[first];
      if (!first || bucket.length < 3) {
        bucket.forEach(function (item) { nodes.push({ type: "leaf", name: caseLabel(item), item: item }); });
        return;
      }
      partitionByPrefix(bucket, 1).forEach(function (part) {
        var folderName = labelWords(part.items[0]).slice(0, part.len).join(" ").replace(/[\s\-·:–—]+$/, "");
        if (part.items.length < 3 && part.len === 1) {
          // level-1 remainder too small for a folder of its own
          part.items.forEach(function (item) { nodes.push({ type: "leaf", name: caseLabel(item), item: item }); });
          return;
        }
        var leaves = part.items.map(function (item) {
          var name = labelWords(item).slice(part.len).join(" ");
          return { type: "leaf", name: name || caseLabel(item), item: item };
        });
        leaves.sort(function (a, b) { return a.name.localeCompare(b.name); });
        nodes.push({ type: "folder", name: folderName, leaves: leaves });
      });
    });
    nodes.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return nodes;
  }

  groupKeys.forEach(function (key) {
    var group = el("div", "sb-group");
    group.dataset.surface = key;
    var head = el("button", "sb-group-head");
    head.type = "button";
    head.appendChild(svgSpan(ICONS.caret));
    head.appendChild(svgSpan(ICONS.folder));
    head.appendChild(el("span", "gname", key));
    head.appendChild(el("span", "count", String(groups[key].length)));
    head.addEventListener("click", function () { group.classList.toggle("closed"); });
    group.appendChild(head);
    groups[key].sort(function (a, b) { return caseLabel(a).localeCompare(caseLabel(b)); });
    foldGroupItems(groups[key]).forEach(function (node) {
      if (node.type === "leaf") {
        group.appendChild(makeLeafRow(node.item, node.name));
        return;
      }
      var folder = el("div", "sb-folder");
      var folderHead = el("button", "sb-folder-head");
      folderHead.type = "button";
      folderHead.title = node.name;
      folderHead.appendChild(svgSpan(ICONS.caret));
      folderHead.appendChild(svgSpan(ICONS.folder));
      folderHead.appendChild(el("span", "fname", node.name));
      folderHead.appendChild(el("span", "count", String(node.leaves.length)));
      folderHead.addEventListener("click", function () { folder.classList.toggle("closed"); });
      folder.appendChild(folderHead);
      node.leaves.forEach(function (leaf) { folder.appendChild(makeLeafRow(leaf.item, leaf.name)); });
      group.appendChild(folder);
    });
    tree.appendChild(group);
  });

  // ----- search filter -----
  function caseMatchesQuery(item, query) {
    if (!query) return true;
    return (item.id + " " + item.title + " " + item.category + " " + item.surface).toLowerCase().indexOf(query) !== -1;
  }
  searchInput.addEventListener("input", function () {
    var query = searchInput.value.trim().toLowerCase();
    Array.prototype.forEach.call(tree.querySelectorAll(".sb-group"), function (group) {
      var groupVisible = 0;
      Array.prototype.forEach.call(group.querySelectorAll(".sb-row"), function (row) {
        var match = caseMatchesQuery(caseById[row.dataset.caseId], query);
        row.style.display = match ? "" : "none";
        if (match) groupVisible += 1;
      });
      Array.prototype.forEach.call(group.querySelectorAll(".sb-folder"), function (folder) {
        var folderVisible = 0;
        Array.prototype.forEach.call(folder.querySelectorAll(".sb-row"), function (row) {
          if (row.style.display !== "none") folderVisible += 1;
        });
        folder.style.display = folderVisible ? "" : "none";
        if (query) folder.classList.remove("closed");
      });
      group.style.display = groupVisible ? "" : "none";
      if (query) group.classList.remove("closed");
    });
    applyMatrixFilter();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "/" && document.activeElement !== searchInput) {
      event.preventDefault();
      searchInput.focus();
    }
  });

  // ----- resizable sidebar -----
  (function () {
    var resizer = document.getElementById("vt-resizer");
    var sidebar = document.querySelector(".sb-sidebar");
    if (!resizer || !sidebar) return;
    var DEFAULT_W = 236, MIN_W = 180, MAX_W = 480;
    var STORE_KEY = "vtSidebarWidth";
    function applyWidth(width) {
      document.documentElement.style.setProperty("--sbw", width + "px");
    }
    var stored = NaN;
    try { stored = Number(localStorage.getItem(STORE_KEY)); } catch (error) { /* storage disabled */ }
    if (Number.isFinite(stored) && stored >= MIN_W && stored <= MAX_W) applyWidth(Math.round(stored));
    var startX = 0;
    var startW = DEFAULT_W;
    resizer.addEventListener("pointerdown", function (event) {
      event.preventDefault();
      resizer.setPointerCapture(event.pointerId);
      startX = event.clientX;
      startW = sidebar.getBoundingClientRect().width;
      resizer.classList.add("dragging");
      document.body.classList.add("sb-resizing");
    });
    resizer.addEventListener("pointermove", function (event) {
      if (!resizer.hasPointerCapture(event.pointerId)) return;
      applyWidth(Math.max(MIN_W, Math.min(MAX_W, Math.round(startW + event.clientX - startX))));
    });
    function endDrag(event) {
      if (!resizer.hasPointerCapture(event.pointerId)) return;
      resizer.releasePointerCapture(event.pointerId);
      resizer.classList.remove("dragging");
      document.body.classList.remove("sb-resizing");
      var width = Math.round(sidebar.getBoundingClientRect().width);
      try { localStorage.setItem(STORE_KEY, String(width)); } catch (error) { /* storage disabled */ }
    }
    resizer.addEventListener("pointerup", endDrag);
    resizer.addEventListener("pointercancel", endDrag);
    resizer.addEventListener("dblclick", function () {
      applyWidth(DEFAULT_W);
      try { localStorage.removeItem(STORE_KEY); } catch (error) { /* storage disabled */ }
    });
  })();

  // ----- resizable sidebar footer / runs panel -----
  (function () {
    var resizer = document.getElementById("vt-foot-resizer");
    var foot = document.querySelector(".sb-foot");
    if (!resizer || !foot) return;
    var DEFAULT_H = 190, MIN_H = 96, MAX_H = 520;
    var STORE_KEY = "vtSidebarFooterHeight";
    function maxHeight() {
      return Math.max(MIN_H, Math.min(MAX_H, Math.round(window.innerHeight * 0.65)));
    }
    function applyHeight(height) {
      document.documentElement.style.setProperty("--sbfh", Math.max(MIN_H, Math.min(maxHeight(), height)) + "px");
    }
    var stored = NaN;
    try { stored = Number(localStorage.getItem(STORE_KEY)); } catch (error) { /* storage disabled */ }
    if (Number.isFinite(stored) && stored >= MIN_H && stored <= maxHeight()) applyHeight(Math.round(stored));
    var startY = 0;
    var startH = DEFAULT_H;
    resizer.addEventListener("pointerdown", function (event) {
      event.preventDefault();
      resizer.setPointerCapture(event.pointerId);
      startY = event.clientY;
      startH = foot.getBoundingClientRect().height || DEFAULT_H;
      resizer.classList.add("dragging");
      document.body.classList.add("sb-foot-resizing");
    });
    resizer.addEventListener("pointermove", function (event) {
      if (!resizer.hasPointerCapture(event.pointerId)) return;
      applyHeight(Math.round(startH - (event.clientY - startY)));
    });
    function endDrag(event) {
      if (!resizer.hasPointerCapture(event.pointerId)) return;
      resizer.releasePointerCapture(event.pointerId);
      resizer.classList.remove("dragging");
      document.body.classList.remove("sb-foot-resizing");
      var height = Math.round(foot.getBoundingClientRect().height);
      try { localStorage.setItem(STORE_KEY, String(height)); } catch (error) { /* storage disabled */ }
    }
    resizer.addEventListener("pointerup", endDrag);
    resizer.addEventListener("pointercancel", endDrag);
    resizer.addEventListener("dblclick", function () {
      document.documentElement.style.removeProperty("--sbfh");
      try { localStorage.removeItem(STORE_KEY); } catch (error) { /* storage disabled */ }
    });
    window.addEventListener("resize", function () {
      var current = Math.round(foot.getBoundingClientRect().height);
      if (current > maxHeight()) applyHeight(current);
    });
  })();

  // ----- resizable / collapsible selected-case bottom inspector -----
  (function () {
    if (!addonResizer || !addons) return;
    var DEFAULT_H = 260, MIN_H = 120, MAX_H = 760;
    var HEIGHT_KEY = "vtAddonHeight";
    var COLLAPSED_KEY = "vtAddonCollapsed";
    function maxHeight() {
      return Math.max(MIN_H, Math.min(MAX_H, Math.round(window.innerHeight * 0.72)));
    }
    function clampHeight(height) {
      return Math.max(MIN_H, Math.min(maxHeight(), Math.round(height)));
    }
    function applyHeight(height) {
      document.documentElement.style.setProperty("--sbah", clampHeight(height) + "px");
    }
    function currentHeight() {
      var stored = NaN;
      try { stored = Number(localStorage.getItem(HEIGHT_KEY)); } catch (error) { /* storage disabled */ }
      return addons.classList.contains("collapsed")
        ? (Number.isFinite(stored) && stored >= MIN_H ? stored : DEFAULT_H)
        : (addons.getBoundingClientRect().height || DEFAULT_H);
    }
    function setCollapsed(collapsed) {
      addons.classList.toggle("collapsed", Boolean(collapsed));
      addonResizer.title = collapsed
        ? "Double-click to expand details panel"
        : "Drag to resize details panel · double-click to reset";
      try { localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0"); } catch (error) { /* storage disabled */ }
      var toggle = addonTabbar && addonTabbar.querySelector("[data-addon-toggle]");
      if (toggle) {
        toggle.title = collapsed ? "Expand details panel" : "Collapse details panel";
        toggle.setAttribute("aria-label", toggle.title);
        toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      }
    }
    var stored = NaN;
    try { stored = Number(localStorage.getItem(HEIGHT_KEY)); } catch (error) { /* storage disabled */ }
    if (Number.isFinite(stored) && stored >= MIN_H && stored <= maxHeight()) applyHeight(stored);
    var storedCollapsed = false;
    try { storedCollapsed = localStorage.getItem(COLLAPSED_KEY) === "1"; } catch (error) { /* storage disabled */ }
    setCollapsed(storedCollapsed);
    var startY = 0;
    var startH = DEFAULT_H;
    addonResizer.addEventListener("pointerdown", function (event) {
      event.preventDefault();
      addonResizer.setPointerCapture(event.pointerId);
      if (addons.classList.contains("collapsed")) setCollapsed(false);
      startY = event.clientY;
      startH = currentHeight();
      addonResizer.classList.add("dragging");
      document.body.classList.add("sb-addon-resizing");
    });
    addonResizer.addEventListener("pointermove", function (event) {
      if (!addonResizer.hasPointerCapture(event.pointerId)) return;
      applyHeight(startH - (event.clientY - startY));
    });
    function endDrag(event) {
      if (!addonResizer.hasPointerCapture(event.pointerId)) return;
      addonResizer.releasePointerCapture(event.pointerId);
      addonResizer.classList.remove("dragging");
      document.body.classList.remove("sb-addon-resizing");
      var height = Math.round(addons.getBoundingClientRect().height);
      if (!addons.classList.contains("collapsed")) {
        try { localStorage.setItem(HEIGHT_KEY, String(clampHeight(height))); } catch (error) { /* storage disabled */ }
      }
    }
    addonResizer.addEventListener("pointerup", endDrag);
    addonResizer.addEventListener("pointercancel", endDrag);
    addonResizer.addEventListener("dblclick", function () {
      if (addons.classList.contains("collapsed")) {
        setCollapsed(false);
        return;
      }
      applyHeight(DEFAULT_H);
      try {
        localStorage.removeItem(HEIGHT_KEY);
        localStorage.setItem(COLLAPSED_KEY, "0");
      } catch (error) { /* storage disabled */ }
    });
    window.addEventListener("resize", function () {
      if (addons.classList.contains("collapsed")) return;
      var height = Math.round(addons.getBoundingClientRect().height);
      if (height > maxHeight()) applyHeight(height);
    });
    window.__slockSetAddonCollapsed = setCollapsed;
  })();

  // ----- waterfall overview grid -----
  function renderOverviewWaterfall() {
    var waterfall = document.getElementById("vt-waterfall");
    if (!waterfall) return;
    waterfall.innerHTML = "";
    var pair = selectedPair();
    var items = orderedCases.length ? orderedCases : (DATA.cases || []);
    items.forEach(function (item) {
      var entry = casePairEntry(item) || {};
      var card = el("button", "sb-wcard");
      card.type = "button";
      card.title = caseLabel(item) + " · " + item.id;
      // Name + info bar sits at the TOP of the card, above the preview (#384).
      var meta = el("div", "meta");
      meta.appendChild(el("span", "name", caseLabel(item)));
      meta.appendChild(copyIdButton(item.id, "span"));
      var p = pct(entry.similarity);
      if (p) meta.appendChild(el("span", "sb-pct", p));
      meta.appendChild(el("span", "sb-dot " + statusKind(entry.status)));
      card.appendChild(meta);
      var left = pair && caseProviderEntry(item, pair.leftProvider);
      var right = pair && caseProviderEntry(item, pair.rightProvider);
      var src = entry.sideBySideImage || (left && left.image) || (right && right.image);
      if (src) {
        var img = document.createElement("img");
        img.loading = "lazy";
        img.decoding = "async";
        img.alt = caseLabel(item) + " side-by-side";
        img.src = encodeURI(src);
        card.appendChild(img);
      } else {
        card.appendChild(el("div", "noimg", "No capture"));
      }
      card.addEventListener("click", function () { selectCase(item.id, true); });
      waterfall.appendChild(card);
    });
  }
  function setStatValue(key, text) {
    var node = document.querySelector('.sb-stat .val[data-stat="' + key + '"]');
    if (node) node.textContent = text;
  }
  // Re-renders the summary metric tiles for the selected pair (the initial
  // server-rendered values mirror the first pair).
  function renderOverviewStats(pair) {
    var summary = (pair && pair.summary) || {};
    var analysis = (pair && pair.analysisSummary) || {};
    var pass = Number(summary.same || 0) + Number(summary.pass || 0) + Number(summary["basic-pass"] || 0);
    setStatValue("total", String(Number(summary.total || 0)));
    setStatValue("pass", String(pass));
    setStatValue("different", String(Number(summary.different || 0)));
    setStatValue("missing", String(Number(summary.missing || 0)));
    setStatValue("ai", Number(analysis.ready || 0) + "/" + Number(analysis.total || 0));
    renderDeclaredStat(pair);
  }
  // "Declared N" mini-stat: cases in the selected pair with declared
  // renderer fallbacks on either end. Client-computed; not a defect count.
  function renderDeclaredStat(pair) {
    var stats = document.querySelector(".sb-stats");
    if (!stats) return;
    var count = pairDeclaredCount(pair);
    var tile = document.getElementById("vt-stat-declared");
    if (!count) { if (tile) tile.remove(); return; }
    if (!tile) {
      tile = el("div", "sb-stat");
      tile.id = "vt-stat-declared";
      tile.appendChild(el("div", "lbl", "Declared"));
      tile.appendChild(el("div", "val"));
      stats.appendChild(tile);
    }
    tile.querySelector(".val").textContent = String(count);
  }

  // ----- overview mode: Grid | Matrix (spec PR-2, task #430) -----
  var viewSwitch = document.getElementById("vt-viewswitch");
  var matrixWrap = document.getElementById("vt-matrixwrap");
  var waterfallBox = document.getElementById("vt-waterfall");
  var matrixRowById = {};
  var MODE_STORE_KEY = "vtOverviewMode";
  // Matrix columns come from the top-level providers def; cells read the
  // per-case providers{} index — never derived from pairs, so a capture
  // shows up even when every pair diff touching it failed.
  var providerDefs = (DATA.providers && DATA.providers.length) ? DATA.providers : (function () {
    var ids = [];
    pairDefs.forEach(function (def) {
      [def.leftProvider, def.rightProvider].forEach(function (id) {
        if (id && ids.indexOf(id) === -1) ids.push(id);
      });
    });
    return ids.map(function (id) { return { id: id, label: providerTitle(id) }; });
  })();
  var overviewMode = (function () {
    if (queryParam((location.search || "").replace(/^\?/, ""), "view") === "matrix") return "matrix";
    try { if (sessionStorage.getItem(MODE_STORE_KEY) === "matrix") return "matrix"; } catch (error) { /* storage disabled */ }
    return "grid";
  })();
  function buildViewSwitch() {
    if (!viewSwitch) return;
    viewSwitch.innerHTML = "";
    [["grid", "Grid"], ["matrix", "Matrix"]].forEach(function (mode) {
      var button = el("button", "sb-pairtab", mode[1]);
      button.type = "button";
      button.dataset.mode = mode[0];
      button.title = mode[0] === "matrix" ? "Matrix overview: cases x providers" : "Grid overview";
      if (mode[0] === overviewMode) button.classList.add("active");
      button.addEventListener("click", function () { setOverviewMode(mode[0]); });
      viewSwitch.appendChild(button);
    });
  }
  function setOverviewMode(mode) {
    if (mode === overviewMode) return;
    overviewMode = mode;
    try { sessionStorage.setItem(MODE_STORE_KEY, mode); } catch (error) { /* storage disabled */ }
    Array.prototype.forEach.call(viewSwitch.children, function (child) {
      child.classList.toggle("active", child.dataset.mode === mode);
    });
    renderOverviewBody();
    syncLocation(true);
  }
  function renderOverviewBody() {
    var matrix = overviewMode === "matrix";
    if (matrixWrap) matrixWrap.hidden = !matrix;
    if (waterfallBox) waterfallBox.hidden = matrix;
    if (matrix) renderOverviewMatrix();
    else renderOverviewWaterfall();
  }
  // Provider capture dot: green = raw capture exists, red = missing/error.
  // Pair status coloring stays on the row header dot (grid semantics).
  function providerDotKind(entry) {
    return entry && entry.status === "captured" && entry.image ? "pass" : "missing";
  }
  // Opens a case on one provider's RAW image tab. When the selected pair
  // lacks that provider, switch to its react__<provider> pair (else the
  // first pair containing it) so a left/right tab can host the image.
  function openCaseForProvider(id, provider) {
    var pair = selectedPair() || {};
    if (pair.leftProvider !== provider && pair.rightProvider !== provider) {
      var candidates = pairDefs.filter(function (def) {
        return def.leftProvider === provider || def.rightProvider === provider;
      });
      var target = candidates.filter(function (def) {
        return def.leftProvider === "react" || def.rightProvider === "react";
      })[0] || candidates[0];
      if (target) {
        selectedPairKey = target.key;
        updatePairSwitcher();
        updateTreeRows();
        pair = target;
      }
    }
    pendingCompTab = pair.leftProvider === provider ? "left" : (pair.rightProvider === provider ? "right" : null);
    selectCase(id, true);
  }
  // Matrix column widths: user-draggable (task #456), persisted. Key 0 is
  // the case column; provider columns key by provider id so widths survive
  // provider-set changes.
  var MATRIX_COL_STORE_KEY = "vtMatrixColWidths";
  var matrixColWidths = (function () {
    try { return JSON.parse(localStorage.getItem(MATRIX_COL_STORE_KEY)) || {}; } catch (error) { return {}; }
  })();
  function matrixColWidth(key, fallback) {
    var value = Number(matrixColWidths[key]);
    return value > 0 ? value : fallback;
  }
  function clampMatrixWidth(key, value) {
    var lo = key === "case" ? 160 : 110;
    var hi = key === "case" ? 560 : 480;
    return Math.max(lo, Math.min(hi, value));
  }
  function saveMatrixColWidth(key, value) {
    matrixColWidths[key] = value;
    try { localStorage.setItem(MATRIX_COL_STORE_KEY, JSON.stringify(matrixColWidths)); } catch (error) { /* storage disabled */ }
  }
  // Attaches a drag handle to a matrix header cell. Width applies to the
  // <col> element so the whole column follows; double-click resets.
  function attachMatrixColResizer(th, colEl, key) {
    if (mobileQuery.matches) return;
    var grip = el("span", "sb-colgrip");
    grip.title = "Drag to resize · double-click to reset";
    grip.addEventListener("dblclick", function (event) {
      event.preventDefault();
      delete matrixColWidths[key];
      try { localStorage.setItem(MATRIX_COL_STORE_KEY, JSON.stringify(matrixColWidths)); } catch (error) { /* ignore */ }
      colEl.style.width = "";
    });
    grip.addEventListener("mousedown", function (event) {
      event.preventDefault();
      var startX = event.clientX;
      var startW = th.getBoundingClientRect().width;
      document.body.classList.add("sb-col-resizing");
      function onMove(e) {
        var width = clampMatrixWidth(key, Math.round(startW + (e.clientX - startX)));
        colEl.style.width = width + "px";
      }
      function onUp(e) {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.classList.remove("sb-col-resizing");
        saveMatrixColWidth(key, clampMatrixWidth(key, Math.round(startW + (e.clientX - startX))));
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    th.appendChild(grip);
  }
  function renderOverviewMatrix() {
    if (!matrixWrap) return;
    matrixWrap.innerHTML = "";
    matrixRowById = {};
    var table = el("table", "sb-matrix");
    var colgroup = document.createElement("colgroup");
    var caseCol = document.createElement("col");
    // table-layout is fixed (predictable drag behavior); give the case
    // column its previous natural default so unresized layout looks the same.
    caseCol.style.width = matrixColWidth("case", 340) + "px";
    colgroup.appendChild(caseCol);
    var providerCols = {};
    providerDefs.forEach(function (def) {
      var col = document.createElement("col");
      if (matrixColWidth(def.id, 0)) col.style.width = matrixColWidth(def.id, 0) + "px";
      providerCols[def.id] = col;
      colgroup.appendChild(col);
    });
    table.appendChild(colgroup);
    var thead = document.createElement("thead");
    var headRow = document.createElement("tr");
    var caseTh = el("th", "rowhead", "Case");
    attachMatrixColResizer(caseTh, caseCol, "case");
    headRow.appendChild(caseTh);
    providerDefs.forEach(function (def) {
      var th = document.createElement("th");
      var head = el("span", "sb-provhead");
      head.appendChild(providerDot(def.id));
      head.appendChild(el("span", null, def.label || providerTitle(def.id)));
      th.appendChild(head);
      attachMatrixColResizer(th, providerCols[def.id], def.id);
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = document.createElement("tbody");
    var pair = selectedPair() || {};
    var items = orderedCases.length ? orderedCases : (DATA.cases || []);
    items.forEach(function (item) {
      var tr = document.createElement("tr");
      tr.dataset.caseId = item.id;
      var head = el("th", "rowhead");
      var inner = el("div", "rowheadin");
      var name = el("span", "name", caseLabel(item));
      name.title = caseLabel(item) + " · " + item.id;
      inner.appendChild(name);
      inner.appendChild(copyIdButton(item.id, "span"));
      inner.appendChild(el("span", "sb-dot " + statusKind((casePairEntry(item) || {}).status)));
      var diffBtn = el("button", "sb-mdiff", "Diff");
      diffBtn.type = "button";
      diffBtn.title = "Open " + (pair.label || "pair") + " side-by-side";
      diffBtn.addEventListener("click", function () { selectCase(item.id, true); });
      inner.appendChild(diffBtn);
      head.appendChild(inner);
      tr.appendChild(head);
      providerDefs.forEach(function (def) {
        var td = document.createElement("td");
        var entry = caseProviderEntry(item, def.id);
        if (entry && entry.image) {
          var cell = el("button", "sb-mcell");
          cell.type = "button";
          cell.title = (def.label || providerTitle(def.id)) + " capture · " + caseLabel(item);
          cell.appendChild(el("span", "sb-dot " + providerDotKind(entry)));
          var declared = providerDeclaredFallbacks(entry);
          if (declared) {
            cell.classList.add("declared");
            cell.title += " · declared fallback: " + declared.falseCaps.concat(declared.divergences.map(divergenceLabel)).join(", ");
            cell.appendChild(el("span", "sb-ai-tag", "declared"));
          }
          var img = document.createElement("img");
          img.loading = "lazy";
          img.decoding = "async";
          img.alt = caseLabel(item) + " (" + (def.label || providerTitle(def.id)) + ")";
          img.src = encodeURI(entry.image);
          cell.appendChild(img);
          cell.addEventListener("click", function () { openCaseForProvider(item.id, def.id); });
          td.appendChild(cell);
        } else {
          var miss = el("div", "sb-mcell miss");
          miss.appendChild(el("span", "sb-dot " + providerDotKind(entry)));
          miss.appendChild(el("span", "lbl", "No capture"));
          td.appendChild(miss);
        }
        tr.appendChild(td);
      });
      matrixRowById[item.id] = tr;
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    matrixWrap.appendChild(table);
    applyMatrixFilter();
  }
  function applyMatrixFilter() {
    var query = searchInput.value.trim().toLowerCase();
    Object.keys(matrixRowById).forEach(function (id) {
      matrixRowById[id].style.display = caseMatchesQuery(caseById[id], query) ? "" : "none";
    });
  }

  // ----- global pair switcher (toolbar, persistent) -----
  var pairSwitch = document.getElementById("vt-pairswitch");
  function buildPairSwitcher() {
    if (!pairSwitch) return;
    pairSwitch.innerHTML = "";
    if (pairDefs.length < 2) { pairSwitch.hidden = true; return; }
    pairSwitch.hidden = false;
    pairDefs.forEach(function (def) {
      // End dots carry each end's provider accent so a pair reads at a
      // glance (e.g. black·React ↔ Android·green).
      var button = el("button", "sb-pairtab");
      button.appendChild(providerDot(def.leftProvider));
      button.appendChild(el("span", null, def.label));
      button.appendChild(providerDot(def.rightProvider));
      button.type = "button";
      button.dataset.pairKey = def.key;
      button.title = def.label + " (" + def.key + ")";
      if (def.key === selectedPairKey) button.classList.add("active");
      button.addEventListener("click", function () { setPair(def.key); });
      pairSwitch.appendChild(button);
    });
  }
  function updatePairSwitcher() {
    if (!pairSwitch) return;
    Array.prototype.forEach.call(pairSwitch.children, function (child) {
      child.classList.toggle("active", child.dataset.pairKey === selectedPairKey);
    });
  }
  // Everything on screen derives from selectedPairKey: tree rows, overview
  // tiles + waterfall, case tabs, metrics/AI addons, and the URL.
  function renderForPair() {
    updateTreeRows();
    if (selectedId && caseById[selectedId]) {
      buildCompTabs(caseById[selectedId]);
      buildAddons(caseById[selectedId]);
    } else {
      renderOverviewStats(selectedPair());
      renderOverviewBody();
    }
  }
  function setPair(key) {
    if (!pairByKey[key] || key === selectedPairKey) return;
    selectedPairKey = key;
    updatePairSwitcher();
    renderForPair();
    syncLocation(true);
  }

  // ----- toolbar tools -----
  function iconBtn(icon, title) {
    var button = el("button", "sb-iconbtn");
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.appendChild(svgSpan(icon));
    return button;
  }
  var zoomLbl = el("span", "sb-zoomlbl", "100%");
  var zoomOutBtn = iconBtn(ICONS.zoomOut, "Zoom out");
  var zoomInBtn = iconBtn(ICONS.zoomIn, "Zoom in");
  var resetBtn = iconBtn(ICONS.reset, "Reset zoom");
  var bgBtn = iconBtn(ICONS.bg, "Toggle background");
  var fitBtn = iconBtn(ICONS.fit, "Actual size / fit");
  function applyZoom() { stage.style.transform = "scale(" + zoom + ")"; zoomLbl.textContent = Math.round(zoom * 100) + "%"; }
  function applyBg() { if (BG_MODES[bgIndex]) canvas.dataset.bg = BG_MODES[bgIndex]; else canvas.removeAttribute("data-bg"); bgBtn.classList.toggle("on", bgIndex !== 0); }
  function applyFit() { stage.classList.toggle("actual", actualSize); fitBtn.classList.toggle("on", actualSize); }
  zoomOutBtn.addEventListener("click", function () { zoom = Math.max(0.2, Math.round((zoom - 0.2) * 100) / 100); applyZoom(); });
  zoomInBtn.addEventListener("click", function () { zoom = Math.min(3, Math.round((zoom + 0.2) * 100) / 100); applyZoom(); });
  resetBtn.addEventListener("click", function () { zoom = 1; applyZoom(); });
  bgBtn.addEventListener("click", function () { bgIndex = (bgIndex + 1) % BG_MODES.length; applyBg(); });
  fitBtn.addEventListener("click", function () { actualSize = !actualSize; applyFit(); });
  [zoomOutBtn, zoomLbl, zoomInBtn, resetBtn, el("span", "sb-sep"), bgBtn, fitBtn].forEach(function (node) { toolsBox.appendChild(node); });

  // ----- comparison tabs + stage -----
  // Four stable tabs bound to the selected pair: <Left>, <Right>,
  // Side-by-side, Overlay. Raw provider images come from the per-case
  // providers{} index; pair artifacts from the pairs{} index.
  function compTabDefs(item) {
    var pair = selectedPair() || {};
    var entry = casePairEntry(item) || {};
    var left = caseProviderEntry(item, pair.leftProvider) || {};
    var right = caseProviderEntry(item, pair.rightProvider) || {};
    return [
      { key: "left", label: pair.leftLabel || "Left", src: left.image, provider: pair.leftProvider },
      { key: "right", label: pair.rightLabel || "Right", src: right.image, provider: pair.rightProvider },
      { key: "side", label: "Side-by-side", src: entry.sideBySideImage },
      {
        key: "overlay",
        label: "Overlay",
        overlay: Boolean(left.image && right.image),
        leftLabel: pair.leftLabel || "Left",
        rightLabel: pair.rightLabel || "Right",
        leftSrc: left.image,
        rightSrc: right.image,
        metrics: entry.metrics
      }
    ];
  }
  function tabAvailable(tab) { return tab.overlay ? tab.overlay : Boolean(tab.src); }

  function buildOverlayPanel(item, def) {
    var bl = def.leftLabel;
    var cur = def.rightLabel;
    var m = def.metrics || {};
    var w = m.comparisonWidth || m.baselineWidth || m.currentWidth || 0;
    var h = m.comparisonHeight || m.baselineHeight || m.currentHeight || 0;
    var details = document.createElement("details");
    details.className = "overlayComparison";
    details.open = true;
    details.setAttribute("data-overlay-comparison", "");
    details.dataset.baselineSrc = def.leftSrc;
    details.dataset.currentSrc = def.rightSrc;
    if (w) details.dataset.overlayWidth = String(w);
    if (h) details.dataset.overlayHeight = String(h);
    var canvasNote = (w && h) ? ("Canvas " + w + "x" + h) : "Canvas auto";
    details.innerHTML =
      '<summary>Overlay comparison · ' + bl + ' under ' + cur + '</summary>' +
      '<div class="overlayControls">' +
        '<label>Mode <select data-overlay-mode>' +
          '<option value="blend">Blend</option>' +
          '<option value="difference">Difference</option>' +
          '<option value="split">Split drag</option>' +
          '<option value="align">Align drag</option>' +
        '</select></label>' +
        '<label>' + bl + ' opacity <input data-overlay-baseline-opacity type="range" min="0" max="100" value="100"></label>' +
        '<code data-overlay-baseline-opacity-value>100%</code>' +
        '<label>' + cur + ' opacity <input data-overlay-opacity type="range" min="0" max="100" value="50"></label>' +
        '<code data-overlay-opacity-value>50%</code>' +
        '<label>Snap <input data-overlay-snap type="checkbox" checked></label>' +
        '<button type="button" data-overlay-reset>Reset</button>' +
        '<span class="cropInfo">Split <code data-overlay-split-value>50%</code></span>' +
        '<span class="cropInfo">Offset <code data-overlay-offset-value>0px, 0px</code></span>' +
        '<span class="cropInfo" data-overlay-status>' + canvasNote + '</span>' +
      '</div>' +
      '<div class="overlayCanvasWrap"><canvas data-overlay-canvas aria-label="' + item.id + ' overlay comparison"></canvas></div>';
    return details;
  }

  function renderStage(item, key) {
    stage.innerHTML = "";
    var def = compTabDefs(item).filter(function (t) { return t.key === key; })[0];
    if (!def) { stage.appendChild(el("div", "sb-missing", "No content.")); return; }
    if (def.overlay) {
      var panel = buildOverlayPanel(item, def);
      stage.appendChild(panel);
      if (window.__slockInitOverlayComparison) window.__slockInitOverlayComparison(panel);
      return;
    }
    if (!def.src) { stage.appendChild(el("div", "sb-missing", "No " + def.label + " capture available for this case.")); return; }
    var card = el("div", "sb-card");
    var img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = item.id + " (" + def.label + ")";
    img.src = encodeURI(def.src);
    card.appendChild(img);
    stage.appendChild(card);
  }

  function buildCompTabs(item) {
    compTabsBox.innerHTML = "";
    var defs = compTabDefs(item);
    var available = defs.filter(tabAvailable);
    // Keep the current tab across pair switches when it still has content;
    // fresh case entry (compTab null) prefers the pair's side-by-side.
    var preferred = defs.filter(function (t) { return t.key === compTab && tabAvailable(t); })[0]
      || defs.filter(function (t) { return t.key === "side" && tabAvailable(t); })[0]
      || defs.filter(function (t) { return t.key === "overlay" && tabAvailable(t); })[0]
      || available[0];
    compTab = preferred ? preferred.key : null;
    defs.forEach(function (def) {
      // Raw provider tabs carry the provider's accent dot; the pair-level
      // Side-by-side/Overlay tabs stay plain.
      var button = el("button", "sb-comptab");
      if (def.provider) button.appendChild(providerDot(def.provider));
      button.appendChild(el("span", null, def.label));
      button.type = "button";
      if (!tabAvailable(def)) { button.disabled = true; }
      else {
        button.addEventListener("click", function () {
          compTab = def.key;
          Array.prototype.forEach.call(compTabsBox.children, function (child) { child.classList.remove("active"); });
          button.classList.add("active");
          renderStage(item, def.key);
        });
      }
      if (def.key === compTab) button.classList.add("active");
      compTabsBox.appendChild(button);
    });
    if (compTab) renderStage(item, compTab);
    else stage.appendChild(el("div", "sb-missing", "No captures available for this case."));
  }

  // ----- addons -----
  function metricRow(label, value, kind) {
    var tr = document.createElement("tr");
    tr.appendChild(el("th", null, label));
    var td = el("td", "num" + (kind ? " " + kind : ""), value == null ? "-" : value);
    tr.appendChild(td);
    return tr;
  }
  function renderAddonBody(item) {
    addonBody.innerHTML = "";
    var pairDef = selectedPair() || {};
    var entry = casePairEntry(item) || {};
    if (addonTab === "metrics") {
      var m = entry.metrics;
      if (!m || (m.pixelPerfectSimilarity == null && m.rgbSimilarity == null)) {
        addonBody.appendChild(el("div", "sb-addon-empty", "No comparison metrics for this case (status: " + (entry.status || "missing") + ")."));
        return;
      }
      if (pairDefs.length > 1) addonBody.appendChild(el("div", "sb-mtable-title", pairDef.label));
      var table = el("table", "sb-mtable");
      var body = document.createElement("tbody");
      body.appendChild(metricRow("Pixel-perfect similarity", pct(m.pixelPerfectSimilarity, 2), statusKind(entry.status)));
      body.appendChild(metricRow("RGB similarity", pct(m.rgbSimilarity, 2)));
      body.appendChild(metricRow("Pixel mismatch", pct(m.pixelMismatchRatio, 2)));
      body.appendChild(metricRow("Comparison size", dims(m.comparisonWidth, m.comparisonHeight)));
      // Metrics JSON keeps baseline*/current* field names: baseline = left
      // end, current = right end of the canonical pair.
      body.appendChild(metricRow("Left size (" + pairDef.leftLabel + ")", dims(m.baselineWidth, m.baselineHeight)));
      body.appendChild(metricRow("Right size (" + pairDef.rightLabel + ")", dims(m.currentWidth, m.currentHeight)));
      table.appendChild(body);
      addonBody.appendChild(table);
      return;
    }
    if (addonTab === "variant") {
      if (!item.variants || !item.variants.length) {
        addonBody.appendChild(el("div", "sb-addon-empty", "No variant metadata declared for this case."));
        return;
      }
      item.variants.forEach(function (variant) {
        var block = el("div", "sb-variant");
        block.appendChild(el("div", "vname", variant.name));
        if (variant.props && Object.keys(variant.props).length) {
          var table = el("table", "sb-props");
          var head = document.createElement("tr");
          head.appendChild(el("th", null, "Prop"));
          head.appendChild(el("th", null, "Value"));
          table.appendChild(head);
          Object.keys(variant.props).forEach(function (propKey) {
            var tr = document.createElement("tr");
            tr.appendChild(el("td", null, propKey));
            var value = variant.props[propKey];
            tr.appendChild(el("td", null, typeof value === "string" ? value : JSON.stringify(value)));
            table.appendChild(tr);
          });
          block.appendChild(table);
        }
        addonBody.appendChild(block);
      });
      return;
    }
    if (addonTab === "ai") {
      function appendAiBlock(title, analysis) {
        var block = el("div", "sb-ai-block");
        block.appendChild(el("div", "sb-mtable-title", title));
        if (!analysis || analysis.status !== "ready") {
          block.appendChild(el("div", "sb-addon-empty", analysis && analysis.error ? analysis.error : "AI analysis pending."));
          addonBody.appendChild(block);
          return;
        }
        var meta = el("div", "sb-ai-meta");
        var source = [];
        if (analysis.analysisProvider) source.push("provider " + analysis.analysisProvider);
        if (analysis.analysisModel) source.push("model " + analysis.analysisModel);
        meta.textContent = [analysis.severity || "unknown"].concat(source).join(" · ");
        block.appendChild(meta);
        function list(label, values) {
          if (!values || !values.length) return;
          block.appendChild(el("div", "sb-ai-label", label));
          var ul = document.createElement("ul");
          values.forEach(function (value) { ul.appendChild(el("li", null, value)); });
          block.appendChild(ul);
        }
        list("Summary", analysis.summary || []);
        list("Likely causes", analysis.likelyCauses || []);
        // Known intentional divergences observed by the model: rendered
        // muted, tagged, and separate from summary — these are not defects.
        if (analysis.intentional && analysis.intentional.length) {
          var intentionalLabel = el("div", "sb-ai-label", "Intentional");
          intentionalLabel.appendChild(el("span", "sb-ai-tag", "intentional"));
          block.appendChild(intentionalLabel);
          var intentionalList = document.createElement("ul");
          intentionalList.className = "sb-ai-muted";
          analysis.intentional.forEach(function (value) { intentionalList.appendChild(el("li", null, value)); });
          block.appendChild(intentionalList);
        }
        list("Suggested fixes", analysis.suggestedFixes || []);
        if (analysis.suggestedOwner) block.appendChild(el("div", "sb-ai-owner", "Owner: " + analysis.suggestedOwner));
        addonBody.appendChild(block);
      }
      appendAiBlock(pairDef.label || "AI diff notes", entry.analysis);
      return;
    }
    // info
    var kv = el("dl", "sb-kv");
    function pair(term, value, mono) {
      kv.appendChild(el("dt", null, term));
      var dd = el("dd");
      if (mono) { var code = el("code", null, value); dd.appendChild(code); } else { dd.textContent = value; }
      kv.appendChild(dd);
    }
    pair("ID", item.id, true);
    pair("Surface", item.surface);
    pair("Category", item.category);
    pair("Capture type", item.captureType || "-");
    kv.appendChild(el("dt", null, "Status"));
    var statusDd = el("dd");
    var wrap = el("span", "sb-status-inline");
    wrap.appendChild(el("span", "sb-dot " + statusKind(entry.status)));
    wrap.appendChild(el("span", null, entry.status || "missing"));
    statusDd.appendChild(wrap);
    kv.appendChild(statusDd);
    addonBody.appendChild(kv);
    // Declared renderer fallbacks per provider (task #441) -- facts from the
    // capability marker; attribution only.
    providerDefs.forEach(function (def) {
      var declared = providerDeclaredFallbacks(caseProviderEntry(item, def.id));
      if (!declared) return;
      var label = el("div", "sb-ai-label", (def.label || providerTitle(def.id)) + " declared fallback");
      label.appendChild(el("span", "sb-ai-tag", "declared"));
      addonBody.appendChild(label);
      var list = document.createElement("ul");
      list.className = "sb-ai-muted";
      declared.falseCaps.forEach(function (cap) { list.appendChild(el("li", null, cap + " = false")); });
      declared.divergences.forEach(function (d) {
        var text = (d && typeof d === "object" && d.description)
          ? divergenceLabel(d) + " — " + String(d.description)
          : divergenceLabel(d);
        list.appendChild(el("li", null, text));
      });
      addonBody.appendChild(list);
    });
    if (item.note) addonBody.appendChild(el("div", "sb-note", item.note));
  }
  function buildAddons(item) {
    addonTabbar.innerHTML = "";
    [["metrics", "Metrics"], ["ai", "AI"], ["variant", "Variant"], ["info", "Info"]].forEach(function (entry) {
      var button = el("button", "sb-addon-tab", entry[1]);
      button.type = "button";
      if (entry[0] === addonTab) button.classList.add("active");
      button.addEventListener("click", function () {
        addonTab = entry[0];
        Array.prototype.forEach.call(addonTabbar.children, function (child) { child.classList.remove("active"); });
        button.classList.add("active");
        renderAddonBody(item);
      });
      addonTabbar.appendChild(button);
    });
    addonTabbar.appendChild(el("span", "sb-addon-tabspacer"));
    var toggle = el("button", "sb-addon-toggle");
    toggle.type = "button";
    toggle.dataset.addonToggle = "1";
    toggle.innerHTML = '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5l3.5 3.5L10 5"/></svg>';
    toggle.addEventListener("click", function () {
      if (window.__slockSetAddonCollapsed) window.__slockSetAddonCollapsed(!addons.classList.contains("collapsed"));
    });
    addonTabbar.appendChild(toggle);
    if (window.__slockSetAddonCollapsed) window.__slockSetAddonCollapsed(addons.classList.contains("collapsed"));
    renderAddonBody(item);
  }

  // ----- selection -----
  function renderCase(item) {
    storyTitle.innerHTML = "";
    storyTitle.appendChild(el("span", "t", item.title && item.title !== item.id ? item.title : item.id));
    storyTitle.appendChild(el("span", "i", item.id));
    storyTitle.appendChild(copyIdButton(item.id, "button"));
    zoom = 1; actualSize = false; bgIndex = 0;
    applyZoom(); applyFit(); applyBg();
    // Fresh case entry lands on the selected pair's side-by-side unless a
    // matrix cell requested a specific raw tab; pair switches inside a case
    // keep the tab (buildCompTabs directly).
    compTab = pendingCompTab;
    pendingCompTab = null;
    buildCompTabs(item);
    buildAddons(item);
  }

  // ----- URL state -----
  // The comparison key lives in exactly ONE place per the spec: top-level
  // ?comparison= on the overview, hash-internal #case/<id>?comparison= on a
  // case. The overview mode (?view=matrix) always lives in the top-level
  // search. Other query params are preserved either way.
  function comparisonSearch(includeComparison) {
    var params = (location.search || "").replace(/^\?/, "").split("&").filter(function (kv) {
      var name = kv.split("=")[0];
      return kv && name !== "comparison" && name !== "view";
    });
    if (includeComparison && pairDefs.length > 1 && selectedPairKey) params.push("comparison=" + encodeURIComponent(selectedPairKey));
    if (overviewMode === "matrix") params.push("view=matrix");
    return params.length ? "?" + params.join("&") : "";
  }
  function routeForCase(id) {
    var suffix = pairDefs.length > 1 && selectedPairKey ? "?comparison=" + encodeURIComponent(selectedPairKey) : "";
    return "#case/" + encodeURIComponent(id) + suffix;
  }

  function updateRoute(hash, replace) {
    var url = location.pathname + comparisonSearch(!hash) + (hash || "");
    if (location.pathname + (location.search || "") + (location.hash || "") === url) return;
    try {
      if (replace) history.replaceState(null, "", url);
      else history.pushState(null, "", url);
    } catch (error) {
      // file:// reports can still mutate location.hash directly.
      location.hash = hash || "";
    }
  }

  // Re-writes the current URL (canonical pair key included) in place.
  function syncLocation(replace) {
    updateRoute(selectedId ? routeForCase(selectedId) : "", replace);
  }

  function navigateOverview(replace) {
    showOverview();
    updateRoute("", replace);
    if (mobileQuery.matches) closeDrawer();
  }

  function selectCase(id, updateHash) {
    var item = caseById[id];
    if (!item) return;
    if (selectedId && rowById[selectedId]) rowById[selectedId].classList.remove("active");
    selectedId = id;
    var row = rowById[id];
    if (row) {
      row.classList.add("active");
      var folder = row.closest(".sb-folder");
      if (folder) folder.classList.remove("closed");
      var group = row.closest(".sb-group");
      if (group) group.classList.remove("closed");
      if (row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
    }
    // Remember where the overview was scrolled to so browser Back can restore
    // it. Only capture when leaving the overview (not when switching between
    // cases, where the canvas is showing the stage instead).
    if (!overview.hidden && canvas) overviewScrollTop = canvas.scrollTop;
    overview.hidden = true;
    stageWrap.hidden = false;
    toolsBox.hidden = false;
    toolsSep.hidden = false;
    if (addonResizer) addonResizer.hidden = false;
    addons.hidden = false;
    if (viewSwitch) viewSwitch.hidden = true;
    renderCase(item);
    if (mobileQuery.matches) closeDrawer();
    if (updateHash) updateRoute(routeForCase(id), false);
  }

  function showOverview() {
    overview.hidden = false;
    stageWrap.hidden = true;
    toolsBox.hidden = true;
    toolsSep.hidden = true;
    if (addonResizer) addonResizer.hidden = true;
    addons.hidden = true;
    storyTitle.innerHTML = "";
    storyTitle.appendChild(el("span", "t", "Overview"));
    compTabsBox.innerHTML = "";
    if (viewSwitch) viewSwitch.hidden = false;
    renderOverviewStats(selectedPair());
    renderOverviewBody();
    if (selectedId && rowById[selectedId]) rowById[selectedId].classList.remove("active");
    selectedId = null;
    // Restore the saved overview scroll position (e.g. after browser Back).
    // Defer to the next frame so the just-unhidden waterfall has laid out
    // before we set scrollTop, otherwise the container is still 0-height.
    if (canvas) {
      var target = overviewScrollTop;
      window.requestAnimationFrame(function () { canvas.scrollTop = target; });
    }
  }

  // Derives the full view state (pair + case) from the URL; non-canonical or
  // unknown ?comparison= keys are rewritten in place to the canonical key of
  // the first matching pair.
  function applyLocation() {
    var key = canonicalPairKey(comparisonKeyFromLocation()) || (pairDefs[0] && pairDefs[0].key) || null;
    if (key !== selectedPairKey) {
      selectedPairKey = key;
      updatePairSwitcher();
      updateTreeRows();
    }
    var match = /^#case\/([^?]+)/.exec(location.hash || "");
    var id = match ? decodeURIComponent(match[1]) : null;
    if (id && caseById[id]) selectCase(id, false);
    else showOverview();
    syncLocation(true);
  }
  if (brandHome) brandHome.addEventListener("click", function (event) {
    event.preventDefault();
    navigateOverview(false);
  });
  buildPairSwitcher();
  buildViewSwitch();
  window.addEventListener("hashchange", applyLocation);
  window.addEventListener("popstate", applyLocation);
  applyLocation();
})();
