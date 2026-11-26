import { useState } from "react";
import { useApi } from "../app/context";
import { useThisComputer } from "../app/thisComputer";

/**
 * "Show job files": opens the folder a job works in (a video's sources, what was read from them, the agent's work) in
 * this computer's file manager. Only in the browser on this computer, and only for a job the engine says has one.
 */
export function JobFiles({ jobId }: { jobId: string }) {
  const client = useApi();
  const here = useThisComputer();
  const [opening, setOpening] = useState(false);
  const [problem, setProblem] = useState<string>();
  if (!here) return null;
  const show = async () => {
    setOpening(true);
    setProblem(undefined);
    try {
      await client.showJobFiles(jobId);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "The folder could not be opened.");
    } finally {
      setOpening(false);
    }
  };
  return (
    <div className="itnote quiet">
      <button className="mini" type="button" disabled={opening} onClick={() => void show()}>
        Show job files
      </button>
      {problem && <span role="status">{problem}</span>}
    </div>
  );
}
