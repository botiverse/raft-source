import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

type Rgba = [number, number, number, number];

export async function expectCssColor(
  page: Page,
  actual: string | null,
  expected: string,
): Promise<void> {
  expect(actual).not.toBeNull();
  const colors = await page.evaluate(
    ({ actualColor, expectedColor }) => {
      const toRgba = (color: string): Rgba => {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("Unable to create canvas context for color normalization");
        }
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data) as Rgba;
      };

      return {
        actual: toRgba(actualColor),
        expected: toRgba(expectedColor),
      };
    },
    { actualColor: actual!, expectedColor: expected },
  );

  expect(colors.actual).toEqual(colors.expected);
}
