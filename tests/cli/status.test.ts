import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as ChildProcess from "node:child_process";

// Mock child_process.execFile so no real launchctl runs.
const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcess>(
    "node:child_process",
  );
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: string[],
      cb: (
        err: Error | null,
        stdout: { stdout: string; stderr: string } | null,
      ) => void,
    ) => {
      execFileMock(cmd, args, cb);
    },
  };
});

function mockLaunchctlListOutput(output: string): void {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      cb: (
        err: Error | null,
        stdout: { stdout: string; stderr: string } | null,
      ) => void,
    ) => {
      cb(null, { stdout: output, stderr: "" });
    },
  );
}

function mockLaunchctlListError(): void {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      cb: (err: Error | null) => void,
    ) => {
      cb(new Error("launchctl failed"));
    },
  );
}

const { getJobStatus } = await import("../../src/cli/status.js");

describe("getJobStatus", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("returns running=true with pid when the job appears in launchctl list", async () => {
    mockLaunchctlListOutput(
      "PID\tStatus\tLabel\n" +
        "12345\t0\tcom.adaria-ai.daemon\n" +
        "-\t0\tcom.other.thing\n",
    );
    const status = await getJobStatus("com.adaria-ai.daemon");
    expect(status.running).toBe(true);
    expect(status.pid).toBe(12345);
    expect(status.lastExitStatus).toBe(0);
  });

  it("returns not-loaded when the label is missing", async () => {
    mockLaunchctlListOutput("PID\tStatus\tLabel\n-\t0\tcom.other.thing\n");
    const status = await getJobStatus("com.adaria-ai.daemon");
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
    expect(status.lastExitStatus).toBeNull();
  });

  it("reports last exit code when the job is stopped with a recorded status", async () => {
    mockLaunchctlListOutput(
      "PID\tStatus\tLabel\n-\t1\tcom.adaria-ai.daemon\n",
    );
    const status = await getJobStatus("com.adaria-ai.daemon");
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
    expect(status.lastExitStatus).toBe(1);
  });

  it("does not substring-match a longer label (M1 CLI review MED #2)", async () => {
    mockLaunchctlListOutput(
      "PID\tStatus\tLabel\n999\t0\tcom.adaria-ai.daemon-replica\n",
    );
    const status = await getJobStatus("com.adaria-ai.daemon");
    expect(status.running).toBe(false);
  });

  it("returns not-loaded when launchctl itself errors", async () => {
    mockLaunchctlListError();
    const status = await getJobStatus("com.adaria-ai.daemon");
    expect(status.running).toBe(false);
    expect(status.lastExitStatus).toBeNull();
  });
});
