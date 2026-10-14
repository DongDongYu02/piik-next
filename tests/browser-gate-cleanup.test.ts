import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupRun } from "../scripts/browser-gate-harness";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.mocked(spawn).mockReset(); });

it.runIf(process.platform === "win32")("closes an owned child when Windows tree termination is unavailable", async () => {
  vi.useFakeTimers();
  const owned = Object.assign(new EventEmitter(), {
    pid: 1234, exitCode: null as number | null, signalCode: null as string | null,
    kill: vi.fn((_signal: string) => { owned.exitCode = 0; owned.emit("exit", 0); return true; }),
  });
  vi.mocked(spawn).mockImplementation(() => {
    const helper = Object.assign(new EventEmitter(), {
      stdout: { resume() {} }, stderr: { resume() {} }, kill: vi.fn(),
    });
    setTimeout(() => helper.emit("exit", 1), 1);
    return helper as unknown as ChildProcessWithoutNullStreams;
  });
  const completion = cleanupRun({ cdp: null, chrome: null, native: null,
    server: owned as unknown as ChildProcessWithoutNullStreams, profile: null, ports: [] });
  await vi.advanceTimersByTimeAsync(2_100);
  const result = await completion;
  expect(spawn).toHaveBeenCalledWith("taskkill.exe", ["/PID", "1234", "/T", "/F"], expect.anything());
  expect(owned.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  expect(result.serverClosed).toBe(true);
  expect(result.portsClosed).toBe(true);
});
