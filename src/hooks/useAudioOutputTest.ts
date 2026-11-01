import { useRef, useState, type MutableRefObject } from "react";
import { audioTestOutput, type AudioOutputSelection } from "../tauri";

/** Own the stereo test's feedback state and its left/right timers. */
export function useAudioOutputTest(
  setBusy: (busy: boolean) => void,
  setError: (error: string | null) => void,
  resumeOnClose: MutableRefObject<boolean>,
  onTestStarted: () => void,
) {
  const [testing, setTesting] = useState(false);
  const [testChannel, setTestChannel] = useState<"left" | "right" | null>(null);
  const testTimers = useRef<number[]>([]);
  const clearTestTimers = () => {
    for (const timer of testTimers.current) window.clearTimeout(timer);
    testTimers.current = [];
  };
  const resetTest = () => {
    setTesting(false);
    setTestChannel(null);
  };
  const testPair = async (next: AudioOutputSelection, saveSelection: (selection: AudioOutputSelection) => void) => {
    setBusy(true);
    setTesting(true);
    setError(null);
    clearTestTimers();
    setTestChannel(null);
    try {
      await audioTestOutput(next);
      onTestStarted();
      saveSelection(next);
      setTestChannel("left");
      testTimers.current = [
        window.setTimeout(() => setTestChannel("right"), 400),
        window.setTimeout(() => {
          setTestChannel(null);
          setTesting(false);
          setBusy(false);
        }, 900),
      ];
    } catch (cause) {
      resumeOnClose.current = false;
      setError(String(cause));
      setTesting(false);
      setBusy(false);
    }
  };
  return { testing, testChannel, setTestChannel, clearTestTimers, resetTest, testPair };
}
