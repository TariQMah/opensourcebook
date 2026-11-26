import { useId } from "react";
import { useThisComputer } from "../../app/thisComputer";
import { GetSetUp } from "../../setup/GetSetUp";
import { SectionHead } from "./SectionHead";

/**
 * Settings › Get set up: the same list first-time setup shows (a coding agent, its sign-in, ffmpeg and a voice, each
 * with the button that fixes it), to come back to any time. Its buttons are the launcher's, so only the browser on
 * this computer has them.
 */
export function SetupSection() {
  const heading = useId();
  const here = useThisComputer();
  return (
    <section className="sx-sec" aria-labelledby={heading}>
      <SectionHead id={heading} title="Get set up">
        What this computer needs to make a video with a voice. Each thing that is missing has a button that fixes it.
      </SectionHead>
      {here ? (
        <GetSetUp />
      ) : (
        <div className="card sx-rows">
          <section className="sx-arow">
            <p>Only in the browser on the computer Open Sourcebook runs on.</p>
          </section>
        </div>
      )}
    </section>
  );
}
