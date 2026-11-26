import { useState } from "react";
import { PrimaryButton } from "../design/Buttons";
import { GetSetUp } from "../setup/GetSetUp";

/** Step 1: Get set up, what this computer needs and a button for each; Next once an agent is signed in. */
export function SetupStep({ onNext }: { onNext: () => void }) {
  const [ready, setReady] = useState(false);
  return (
    <>
      <section className="fr-card" aria-labelledby="fr-h">
        <div className="fr-head">
          <h1 id="fr-h">Get set up</h1>
          <p>What this computer needs to make a video with a voice. Each thing that is missing has a button that fixes it.</p>
        </div>
        <GetSetUp onReady={setReady} />
      </section>
      <div className="fr-foot">
        <span className="fr-hint">{ready ? "Your agent is ready." : "Next once an agent is signed in."}</span>
        <PrimaryButton className="fr-next" disabled={!ready} onClick={onNext}>
          Next
        </PrimaryButton>
      </div>
    </>
  );
}
