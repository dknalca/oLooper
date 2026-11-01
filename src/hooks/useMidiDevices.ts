import { useEffect, useState } from "react";
import {
  midiConnectedInput, midiConnectedOutput, midiConnect, midiConnectOutput, midiDisconnect,
  midiDisconnectOutput, midiListInputs, midiListOutputs, type MidiAction, type MidiInputInfo, type MidiOutputInfo,
} from "../tauri";

/** Own the device list, selection and connect/disconnect feedback in the dialog. */
export function useMidiDevices(
  open: boolean,
  inputId: string | null,
  outputId: string | null,
  onInputIdChange: (id: string | null) => void,
  onOutputIdChange: (id: string | null) => void,
  onLearningChange: (action: MidiAction | null) => void,
) {
  const [devices, setDevices] = useState<MidiInputInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MidiOutputInfo[]>([]);
  const [connected, setConnected] = useState<MidiInputInfo | null>(null);
  const [connectedOutput, setConnectedOutput] = useState<MidiOutputInfo | null>(null);
  const [selectedId, setSelectedId] = useState(inputId ?? "");
  const [selectedOutputId, setSelectedOutputId] = useState(outputId ?? "");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshDevices = async () => {
    setLoading(true);
    setError(null);
    try {
      const [available, active, outputs, activeOutput] = await Promise.all([midiListInputs(), midiConnectedInput(), midiListOutputs(), midiConnectedOutput()]);
      setDevices(available);
      setConnected(active);
      setOutputDevices(outputs);
      setConnectedOutput(activeOutput);
      setSelectedId((current) => {
        if (current && available.some((device) => device.id === current)) return current;
        if (inputId && available.some((device) => device.id === inputId)) return inputId;
        return active?.id ?? available[0]?.id ?? "";
      });
      setSelectedOutputId((current) => current && outputs.some((device) => device.id === current)
        ? current : outputId && outputs.some((device) => device.id === outputId) ? outputId : activeOutput?.id ?? "");
    } catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    if (open) void refreshDevices();
    else onLearningChange(null);
  }, [open]);
  useEffect(() => { setSelectedOutputId(outputId ?? ""); }, [outputId]);

  const connect = async () => {
    if (!selectedId) return;
    setBusy(true); setError(null);
    try {
      const device = await midiConnect(selectedId);
      setConnected(device);
      onInputIdChange(device.id);
      onLearningChange(null);
    } catch (reason) { setError(String(reason)); setConnected(null); }
    finally { setBusy(false); }
  };
  const disconnect = async () => {
    setBusy(true); setError(null); onLearningChange(null);
    try {
      await midiDisconnect();
      setConnected(null);
      onInputIdChange(null);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const connectOutput = async () => {
    setBusy(true); setError(null);
    try {
      if (selectedOutputId) {
        const output = await midiConnectOutput(selectedOutputId);
        setConnectedOutput(output);
        onOutputIdChange(output.id);
      } else {
        await midiDisconnectOutput();
        setConnectedOutput(null);
        onOutputIdChange(null);
      }
    } catch (reason) { setError(String(reason)); setConnectedOutput(null); }
    finally { setBusy(false); }
  };

  return { devices, outputDevices, connected, connectedOutput, selectedId, setSelectedId,
    selectedOutputId, setSelectedOutputId,
    loading, busy, error, refreshDevices, connect, disconnect, connectOutput };
}
