import { useEffect, useState, type MutableRefObject } from "react";
import { startPlayerStatusPolling } from "../playerStatusPolling";
import { playerPlay, playerStatus, playerStop, type PlayerStatus } from "../tauri";

/** Stop for output routing and monitor digital levels while the dialog is open. */
export function useAudioRoutingSession(
  open: boolean,
  testing: boolean,
  resumeOnClose: MutableRefObject<boolean>,
  setBusy: (busy: boolean) => void,
  setError: (error: string | null) => void,
  onPlayerStatusChange: (status: PlayerStatus) => void,
) {
  const [outputLevels, setOutputLevels] = useState({ left: 0, right: 0 });
  useEffect(() => {
    if (open) {
      setBusy(true);
      setError(null);
      const stopForRoutingChange = async () => {
        try {
          const current = await playerStatus();
          resumeOnClose.current = current.loaded && current.playing;
          onPlayerStatusChange(current);
          // Stop rather than pause so a later resume starts at the loop start.
          if (current.loaded) onPlayerStatusChange(await playerStop());
        } catch (cause) {
          setError(String(cause));
        } finally {
          setBusy(false);
        }
      };
      void stopForRoutingChange();
      return;
    }
    const shouldResume = resumeOnClose.current;
    resumeOnClose.current = false;
    if (shouldResume) playerPlay().then(onPlayerStatusChange).catch(() => {});
  }, [open, onPlayerStatusChange, resumeOnClose, setBusy, setError]);

  useEffect(() => {
    if (!open) return;
    return startPlayerStatusPolling(() => (status) => {
      setOutputLevels({
        left: status.playing || testing ? status.output_left_level_pct : 0,
        right: status.playing || testing ? status.output_right_level_pct : 0,
      });
      onPlayerStatusChange(status);
    }, 100);
  }, [open, onPlayerStatusChange, testing]);
  return outputLevels;
}
