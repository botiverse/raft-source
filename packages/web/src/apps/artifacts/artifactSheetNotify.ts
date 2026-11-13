import { createContext, useState } from "react";

/**
 * Who a box's Send notifies, for the bottom sheet it is in (#148): on touch there is no tooltip, so
 * a sheet holding a comment box says it under its title, as the sheet's accessible description
 * (aria-describedby). The names are data, not helper text: the line is in ink
 * (SHEET_NOTIFY_CLASS), not DrawerDescription's grey. The sheet provides the setter
 * (`useSheetNotify`); the box (ArtifactCommentBox) tells it on a phone, and null when it goes.
 */
export const SheetNotifyContext = createContext<((text: string | null) => void) | null>(null);

/** The sheet's notify line under its title: DrawerDescription's size, in ink. */
export const SHEET_NOTIFY_CLASS = "text-pretty font-sans text-callout text-foreground";

/** A sheet's notify line: what its box last told, and the setter to provide. */
export function useSheetNotify(): [string | null, (text: string | null) => void] {
  return useState<string | null>(null);
}
