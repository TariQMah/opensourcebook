import { useId, useState } from "react";
import { useAppData } from "../../app/context";
import { useLoad } from "../../app/useLoad";
import { Switch } from "../../design/ui";
import { SectionHead } from "./SectionHead";

/** Settings › Videos: how much of this computer drawing a video may take. */
export function VideosSettings() {
  const heading = useId();
  const { client } = useAppData();
  const drawing = useLoad(() => client.drawing(), [client]);
  const [faster, setFaster] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const on = faster ?? drawing.data?.faster ?? false;
  async function flip(next: boolean) {
    setBusy(true);
    setFailed(false);
    try {
      setFaster((await client.setDrawing(next)).faster);
    } catch {
      setFailed(true);
    }
    setBusy(false);
  }
  return (
    <section className="sx-sec" aria-labelledby={heading}>
      <SectionHead id={heading} title="Videos">
        How much of this computer drawing a video may take.
      </SectionHead>
      <div className="card sx-row">
        <span className="sx-two">
          <b>Use more of my computer to make videos faster</b>
          <span>
            {on
              ? "Videos draw with most of this computer, as fast as it can. Other apps may be slow meanwhile, so it suits a video you start and walk away from."
              : "Videos draw with about half of this computer, after your own apps, so it stays usable meanwhile. A video takes a little longer."}{" "}
            Only one video draws at a time.
          </span>
        </span>
        <Switch checked={on} disabled={busy || (drawing.loading && !drawing.data)} label="Use more of my computer to make videos faster" onChange={(next) => void flip(next)} />
      </div>
      {failed && (
        <p className="sx-banner warn" role="status">
          That didn't save. Try again.
        </p>
      )}
    </section>
  );
}
