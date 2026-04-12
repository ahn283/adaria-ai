import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ALL_LABELS } from "./start.js";

const execFileAsync = promisify(execFile);

export interface JobStatus {
  label: string;
  running: boolean;
  pid: number | null;
  lastExitStatus: number | null;
}

export async function getJobStatus(label: string): Promise<JobStatus> {
  try {
    const { stdout } = await execFileAsync("launchctl", ["list"]);
    // `launchctl list` is tab-separated: `<pid>\t<exit>\t<label>`. Use
    // exact field match on column 3 so `com.adaria-ai.daemon` can't be
    // substring-matched against a longer future label like
    // `com.adaria-ai.daemon-replica` (M1 CLI review MED #2).
    const line = stdout
      .split("\n")
      .find((l) => l.trim().split(/\s+/)[2] === label);
    if (!line) {
      return { label, running: false, pid: null, lastExitStatus: null };
    }
    const parts = line.trim().split(/\s+/);
    const pidStr = parts[0];
    const exitStr = parts[1];
    const pid =
      pidStr === "-" || pidStr === undefined ? null : parseInt(pidStr, 10);
    const lastExitStatus =
      exitStr === "-" || exitStr === undefined ? null : parseInt(exitStr, 10);
    return {
      label,
      running: pid !== null,
      pid,
      lastExitStatus,
    };
  } catch {
    return { label, running: false, pid: null, lastExitStatus: null };
  }
}

export async function runStatus(): Promise<void> {
  const labels = ALL_LABELS;

  for (const label of labels) {
    const status = await getJobStatus(label);
    if (status.running) {
      console.log(`${label}: running (PID ${String(status.pid)})`);
    } else if (status.lastExitStatus !== null) {
      console.log(
        `${label}: stopped (last exit ${String(status.lastExitStatus)})`,
      );
    } else {
      console.log(`${label}: not loaded`);
    }
  }
}
