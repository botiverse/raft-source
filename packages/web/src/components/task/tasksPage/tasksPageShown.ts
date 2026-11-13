import { createContext } from "react";

/**
 * Whether the Tasks page is on screen: false on a phone while a task covers
 * it (TasksRoute keeps it mounted underneath). Its counts are not refreshed
 * meanwhile; they are when it shows again. Apart from useTasksPageData so
 * TasksRoute, in the first download, doesn't take the page's data layer with it.
 */
export const TasksPageShownContext = createContext(true);
