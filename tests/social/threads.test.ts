/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { afterEach, describe, it, expect, vi } from "vitest";
import { ThreadsClient } from "../../src/social/threads.js";

const config = { accessToken: "test-token", userId: "test-user" };

describe("ThreadsClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validates 500 char limit", () => {
    const client = new ThreadsClient(config);
    expect(client.validateContent("Hello Threads!").valid).toBe(true);
  });

  it("rejects text exceeding 500 chars", () => {
    const client = new ThreadsClient(config);
    expect(client.validateContent("x".repeat(501)).valid).toBe(false);
  });

  it("post() runs the create-container then publish two-step flow", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "container-1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "thread-9" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ThreadsClient(config);
    const result = await client.post({ text: "Hello Threads" });

    expect(result.success).toBe(true);
    expect(result.postId).toBe("thread-9");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [createUrl, createInit] = fetchMock.mock.calls[0]!;
    expect(String(createUrl)).toContain("/test-user/threads");
    expect((createInit as RequestInit).method).toBe("POST");
    const createBody = (createInit as RequestInit).body as URLSearchParams;
    expect(createBody.get("text")).toBe("Hello Threads");
    expect(createBody.get("media_type")).toBe("TEXT");
    expect(createBody.get("access_token")).toBe("test-token");

    const [publishUrl, publishInit] = fetchMock.mock.calls[1]!;
    expect(String(publishUrl)).toContain("/test-user/threads_publish");
    const publishBody = (publishInit as RequestInit).body as URLSearchParams;
    expect(publishBody.get("creation_id")).toBe("container-1");
  });

  it("post() returns failure when container creation fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response("bad request", { status: 400 }),
      ),
    );
    const client = new ThreadsClient(config);
    const result = await client.post({ text: "Hello" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Container creation failed");
  });
});
