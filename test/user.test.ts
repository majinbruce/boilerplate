import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers.ts";
import type { App } from "../src/app.ts";

/**
 * None of these reach Postgres: validation and auth both reject the request
 * before the handler runs. That is the point of doing them as lifecycle hooks
 * rather than as code inside the handler.
 */
describe("user routes", () => {
  let app: App;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects an unauthenticated list request", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/users" });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ statusCode: -1 });
  });

  it("rejects a malformed create body and reports every bad field at once", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/users",
      payload: { name: "a", email: "not-an-email", password: "short" },
    });

    expect(res.statusCode).toBe(400);

    const body = res.json<{ message: string; details: { field: string }[] }>();

    expect(body.message).toBe("Validation failed");
    expect([...new Set(body.details.map((d) => d.field))].sort()).toEqual([
      "email",
      "name",
      "password",
    ]);
  });

  /**
   * The cases that need an authenticated caller (path validation behind the
   * guard, and role gating) moved to test/integration/, because a session is
   * now a row in Postgres rather than a signature this process can mint.
   */

  it("rejects a malformed JSON body with 400, not 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/users",
      headers: { "content-type": "application/json" },
      payload: "{ not json",
    });

    expect(res.statusCode).toBe(400);
  });
});
