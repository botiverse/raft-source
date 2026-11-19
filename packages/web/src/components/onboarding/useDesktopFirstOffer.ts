import { useCallback, useState } from "react";
import { useDesktopDownloadView } from "../settings/DesktopDownloadOptions";
import type { DesktopDownloadView } from "../settings/DesktopDownloadOptions";
import type { DesktopTarget } from "../../utils/desktopDownload";

export type DesktopFirstOffer = {
  view: DesktopDownloadView;
  /** This device has a Desktop build and the person has not asked for the commands. */
  offered: boolean;
  /** The installer link was clicked on this page: it says it is waiting for the computer. */
  waiting: boolean;
  downloaded: (target: DesktopTarget) => void;
  useCommand: () => void;
};

/** The offer's state for the computer step: whether it shows, and its two ways out (each also the step's action event). */
export function useDesktopFirstOffer(onChoose?: (way: "download_app" | "install_myself") => void): DesktopFirstOffer {
  const view = useDesktopDownloadView();
  const [commandInstead, setCommandInstead] = useState(false);
  const useCommand = useCallback(() => {
    setCommandInstead(true);
    onChoose?.("install_myself");
  }, [onChoose]);
  const [waiting, setWaiting] = useState(false);
  const downloaded = useCallback(() => {
    setWaiting(true);
    onChoose?.("download_app");
  }, [onChoose]);
  return { view, offered: !commandInstead && !!view.recommended, waiting, downloaded, useCommand };
}
