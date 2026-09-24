import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mobileServerSelectorPolygon } from "../src/components/layout/mobileServerSelectorGeometry";

const sidebarSource = readFileSync(new URL("../src/components/layout/Sidebar.tsx", import.meta.url), "utf8");
const stylesheetSource = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
const geometrySource = readFileSync(new URL("../src/components/layout/mobileServerSelectorGeometry.ts", import.meta.url), "utf8");

test("mobile server selector preserves its dimensions while vectorizing the slanted surface", () => {
  const classMatch = sidebarSource.match(/className="(mobile-server-selector-vector relative[^"]*)"/);
  assert.ok(classMatch, "mobile server selector should opt into its dedicated vector surface");

  const className = classMatch[1];
  for (const originalSurfaceClass of [
    "border-2",
    "border-transparent",
    "bg-transparent",
    "px-3",
    "py-1",
    "text-soft-signal",
  ]) {
    assert.match(className, new RegExp(`(?:^|\\s)${originalSurfaceClass.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(?:\\s|$)`));
  }

  assert.doesNotMatch(className, /tilt-neg-2|will-change-transform|shadow-brutal/);
  assert.doesNotMatch(sidebarSource, /mobile-server-selector-vector-shadow-hover/);
  assert.match(sidebarSource, /className="mobile-server-selector-content"/);
  assert.match(
    sidebarSource,
    /className="mobile-server-selector-vector-surface"[\s\S]*?className="mobile-server-selector-vector-shadow"[\s\S]*?className="mobile-server-selector-vector-face"/,
  );
  assert.match(geometrySource, /MOBILE_SERVER_SELECTOR_TILT_RADIANS = -2 \* Math\.PI \/ 180/);
  assert.match(sidebarSource, /new ResizeObserver\(measure\)/);
  assert.match(sidebarSource, /points=\{mobileServerSelectorPolygon\(size\.width, size\.height, 0\)\}/);

  assert.match(
    stylesheetSource,
    /\.mobile-server-selector-vector-surface polygon\s*\{[^}]*shape-rendering:\s*geometricPrecision;/s,
  );
  assert.match(stylesheetSource, /\.mobile-server-selector-vector-face\s*\{[^}]*fill:\s*#000;/s);
  assert.match(stylesheetSource, /\.mobile-server-selector-vector-shadow\s*\{[^}]*fill:\s*#141111;/s);
  assert.match(stylesheetSource, /\.mobile-server-selector-content\s*\{[^}]*rotate:\s*-2deg;/s);
  const vectorRules = stylesheetSource.match(/\.mobile-server-selector-vector-surface\s*\{[\s\S]*?\.scrollbar-none/);
  assert.ok(vectorRules, "vector surface rules should be present");
  assert.doesNotMatch(vectorRules[0], /clip-path|transition:|:hover|transform:|transform-box|translateZ|translate3d|backface-visibility|transform-style|will-change|drop-shadow/);

  assert.match(
    stylesheetSource,
    /@media\s*\(max-height:\s*600px\)\s*\{[^}]*\.mobile-server-selector-vector-surface\s*\{[^}]*display:\s*none;[^}]*\}[\s\S]*?\.mobile-server-selector-content\s*\{[^}]*rotate:\s*none;/,
  );
});

test("vector surface keeps the exact -2deg angle across dynamic server-name widths", () => {
  const parsePoints = (points: string) => points.split(" ").map((point) => point.split(",").map(Number));

  for (const width of [80, 168, 248]) {
    const face = parsePoints(mobileServerSelectorPolygon(width, 36, 0));
    const shadow = parsePoints(mobileServerSelectorPolygon(width, 36, 2));
    const topEdgeDegrees = Math.atan2(face[1][1] - face[0][1], face[1][0] - face[0][0]) * 180 / Math.PI;
    assert.ok(Math.abs(topEdgeDegrees + 2) < 1e-10, `width ${width} should retain a -2deg top edge`);

    const shadowDeltaX = shadow[0][0] - face[0][0];
    const shadowDeltaY = shadow[0][1] - face[0][1];
    assert.ok(Math.abs(shadowDeltaX - 2.0685806475) < 1e-9);
    assert.ok(Math.abs(shadowDeltaY - 1.9289826606) < 1e-9);
  }
});
