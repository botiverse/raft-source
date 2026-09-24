import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

function sourceRoot(): string {
  const tmp = resolve(repoRoot, ".stryker-tmp");
  if (!existsSync(tmp)) return resolve(repoRoot, "src");
  const backup = readdirSync(tmp).find((entry) => entry.startsWith("backup-"));
  return backup ? resolve(tmp, backup, "src") : resolve(repoRoot, "src");
}

function readSource(path: string): string {
  return readFileSync(resolve(sourceRoot(), path), "utf8");
}

test("Sidebar sortable graph supports pointer, touch, and keyboard dragging", () => {
  const source = readSource("components/layout/Sidebar.tsx");

  assert.match(source, /KeyboardSensor,/);
  assert.match(source, /PointerSensor,/);
  assert.match(source, /TouchSensor,/);
  assert.match(source, /sortableKeyboardCoordinates,/);
  assert.match(
    source,
    /const dndSensors = useSensors\(\s*useSensor\(PointerSensor, \{ activationConstraint: \{ distance: 6 \} \}\),\s*useSensor\(TouchSensor, \{ activationConstraint: \{ delay: 500, tolerance: 10 \} \}\),\s*useSensor\(KeyboardSensor, \{ coordinateGetter: sortableKeyboardCoordinates \}\),\s*\);/,
  );
  assert.equal(source.split("sensors={dndSensors}").length - 1, 1);
  assert.match(source, /SidebarDndContainer/);
  assert.match(source, /handleSidebarDragOver/);
  assert.match(source, /handleSidebarDragEnd/);
  assert.match(source, /<DragOverlay dropAnimation=\{null\}>/);
});
