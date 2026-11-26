import type { VoiceInstallState } from "../api/types";
import { Bar } from "../design/ui";

/** Megabytes, whole from 10 up and with one decimal below. */
const mb = (bytes: number) => {
  const m = bytes / 1e6;
  return m >= 10 ? String(Math.round(m)) : m.toFixed(1);
};

/** Downloads smaller than this are its small files before the model, too quick for a bar. */
const BAR_FROM = 1e6;

/**
 * How a voice's install is going, in its two named steps: getting the voice ready (its code), then the model's
 * download as a bar with MB done of MB in all, as the launcher reports them.
 */
export function VoiceInstallProgress({ now }: { now?: VoiceInstallState }) {
  const going = now?.state === "installing" ? now : undefined;
  if (going?.step === "download" && going.total && going.total >= BAR_FROM) {
    const loaded = going.loaded ?? 0;
    return (
      <span className="vs-progress" role="status">
        <span>
          Downloading the voice: {mb(loaded)} MB of {mb(going.total)} MB
        </span>
        <Bar value={loaded / going.total} label="Voice download" />
      </span>
    );
  }
  return (
    <span className="vs-progress" role="status">
      <span>Getting the voice ready…</span>
    </span>
  );
}
