// Which pushed files are copies of common libraries (bundledLibraries.ts,
// `bundled-library`), and what the warning tells the agent to load instead.
// Proves: a library's build name is found, with the version in it; a name a
// page's own code could have needs the banner; only a file's first comment is
// a banner (a bundle carrying a license comment further in is no copy); the
// address is the pinned jsDelivr file for the kind, else the package's page.
// The push path (inline bytes, storage, carried-over files) is
// scrollLock.api.test.ts's.
import assert from "node:assert/strict";
import { bundledLibraryWarning, libraryCopyOf } from "./bundledLibraries";

const found = (path: string, head: string | null = null) => {
  const copy = libraryCopyOf(path, head);
  return copy === null ? null : { title: copy.library.title, version: copy.version, byBanner: copy.byBanner };
};
const messageOf = (path: string, head: string | null = null) => {
  const copy = libraryCopyOf(path, head);
  assert.ok(copy, path);
  return bundledLibraryWarning(path, copy).message;
};

test("a library's own build names are found, with the version the name carries", () => {
  assert.deepEqual(found("vendor/jquery-3.7.1.min.js"), { title: "jQuery", version: "3.7.1", byBanner: false });
  assert.deepEqual(found("react-dom.production.min.js"), { title: "ReactDOM", version: null, byBanner: false });
  assert.deepEqual(found("js/React.production.min.js"), { title: "React", version: null, byBanner: false });
  assert.deepEqual(found("chart.umd.min.js"), { title: "Chart.js", version: null, byBanner: false });
  assert.deepEqual(found("three.module.js"), { title: "three.js", version: null, byBanner: false });
  assert.deepEqual(found("d3.v7.min.js"), { title: "D3", version: null, byBanner: false });
  assert.deepEqual(found("plotly-2.27.0.min.js"), { title: "Plotly", version: "2.27.0", byBanner: false });
  assert.deepEqual(found("css/bootstrap.min.css"), { title: "Bootstrap", version: null, byBanner: false });
  assert.deepEqual(found("katex.min.css"), { title: "KaTeX", version: null, byBanner: false });
});

test("a page's own file is no copy by its name: app code, a name its code could have, a build config, another library", () => {
  for (const path of ["app.js", "chart.js", "three.js", "highlight.js", "tailwind.config.js", "tailwind.css", "jquery-ui.min.js", "vendor/tiny-lib.min.js", "vuex.js"]) {
    assert.equal(found(path), null, path);
  }
});

test("the banner a build starts with finds a copy under any name, with its version", () => {
  assert.deepEqual(found("chart.js", "/*!\n * Chart.js v4.4.1\n * https://www.chartjs.org\n */\n!function(t,e){"), { title: "Chart.js", version: "4.4.1", byBanner: true });
  assert.deepEqual(found("vendor.js", "/*! jQuery v3.7.1 | (c) OpenJS Foundation and other contributors | jquery.org/license */\n!function(e,t){"), { title: "jQuery", version: "3.7.1", byBanner: true });
  assert.deepEqual(found("lib/r.js", "/** @license React v17.0.2\n * react-dom.production.min.js\n *\n * Copyright (c) Facebook, Inc."), { title: "ReactDOM", version: "17.0.2", byBanner: true });
  assert.deepEqual(found("lib/d.js", "// https://d3js.org v7.8.5 Copyright 2010-2023 Mike Bostock\n(function (global, factory) {"), { title: "D3", version: "7.8.5", byBanner: true });
  assert.deepEqual(found("styles/b.css", '@charset "UTF-8";/*!\n * Bootstrap  v5.3.2 (https://getbootstrap.com/)\n */'), { title: "Bootstrap", version: "5.3.2", byBanner: true });
  // A first comment that is no banner leaves the copy to its name.
  assert.deepEqual(found("jquery-3.6.0.js", "/*! not a banner */"), { title: "jQuery", version: "3.6.0", byBanner: false });
});

test("only the file's first comment is a banner: a page's bundle with a library's license further in isn't a copy", () => {
  assert.equal(found("assets/index-4f2a9c.js", "const app = document.querySelector('#app');\n/*! jQuery v3.7.1 | jquery.org/license */"), null);
  assert.equal(found("assets/index-4f2a9c.js", "/* my app */\n/** @license React v17.0.2\n * react.production.min.js */"), null);
});

test("the warning names the pinned jsDelivr file for the kind, else where the versions are", () => {
  assert.match(messageOf("vendor/jquery-3.7.1.min.js"), /^By its name, this looks like a copy of jQuery 3\.7\.1: point the page's src \(or href\) at https:\/\/cdn\.jsdelivr\.net\/npm\/jquery@3\.7\.1\/dist\/jquery\.min\.js and delete this file\./);
  assert.match(messageOf("b.css", "/*!\n * Bootstrap  v5.3.2 (https://getbootstrap.com/)\n */"), /^This is a copy of Bootstrap 5\.3\.2: point the page's src \(or href\) at https:\/\/cdn\.jsdelivr\.net\/npm\/bootstrap@5\.3\.2\/dist\/css\/bootstrap\.min\.css /);
  assert.match(messageOf("chart.js", "/*!\n * Chart.js v4.4.1\n */"), /at https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js@4\.4\.1 and delete/);
  assert.match(messageOf("three.module.js"), /point the page's src \(or href\) at a library CDN, pinned to the version you use \(its versions: https:\/\/www\.jsdelivr\.com\/package\/npm\/three\), and delete this file/);
  assert.match(messageOf("three.module.js"), /monthly upload quota/);
  // Tailwind's v4 Play CDN is on jsDelivr; cdn.tailwindcss.com only has v3.
  assert.match(messageOf("tailwindcss-4.1.3.js"), /at https:\/\/cdn\.jsdelivr\.net\/npm\/@tailwindcss\/browser@4\.1\.3 and/);
  assert.match(messageOf("tailwind-3.4.1.js"), /at https:\/\/cdn\.tailwindcss\.com\/3\.4\.1 and/);
});
