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

  it("rejects an invalid uuid in the path", async () => {
    const token = app.signToken({
      id: "00000000-0000-4000-8000-000000000000",
      email: "admin@example.com",
      role: "admin",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/users/not-a-uuid",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(400);
  });

  it("blocks a non-admin from deleting, after authenticating them", async () => {
    const token = app.signToken({
      id: "00000000-0000-4000-8000-000000000000",
      email: "user@example.com",
      role: "user",
    });

    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/users/00000000-0000-4000-8000-000000000001",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
  });

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
