import { brand } from "./brand.ts";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  API_KEY_ENV,
  APIError,
  BASE_URL_ENV,
  PermissionDeniedError,
  USER_AGENT,
  VERSION,
  DEFAULT_BASE_URL,
  TOKEN_ENV,
  createClient,
  unwrap,
  type Schemas,
} from "./index.ts";

const workspace: Schemas["Workspace"] = {
  id: "w1",
  name: "Acme",
  slug: "acme",
  createdAt: "2026-11-22T00:00:00.000Z",
};

function fakeFetch(handler: (request: Request) => Response) {
  const requests: Request[] = [];
  const fetch = async (request: Request) => {
    requests.push(request);
    return handler(request);
  };
  return { fetch, requests };
}

describe("createClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const sent = async (options: Parameters<typeof createClient>[0]) => {
    const { fetch, requests } = fakeFetch(() => Response.json(workspace));
    await createClient({ ...options, fetch }).GET("/workspace");
    return requests[0].headers.get("authorization");
  };

  it("sends apiKey, or token, as the bearer credential", async () => {
    expect(await sent({ apiKey: "sk_key" })).toBe("Bearer sk_key");
    // token takes an API key too, as it did before apiKey existed.
    expect(await sent({ token: "sk_key" })).toBe("Bearer sk_key");
    expect(await sent({ token: "pat_x" })).toBe("Bearer pat_x");
    expect(() => createClient({ apiKey: "sk_a", token: "pat_b" })).toThrow(
      "pass apiKey or token, not both",
    );
  });

  it("reads <NAME>_API_KEY, then <NAME>_TOKEN, when neither is passed", async () => {
    vi.stubEnv(API_KEY_ENV, "sk_from_env");
    vi.stubEnv(TOKEN_ENV, "pat_from_env");
    expect(await sent({})).toBe("Bearer sk_from_env");
    // A credential you pass wins over either variable.
    expect(await sent({ token: "pat_passed" })).toBe("Bearer pat_passed");
    vi.stubEnv(API_KEY_ENV, "");
    expect(await sent({})).toBe("Bearer pat_from_env");
    vi.stubEnv(TOKEN_ENV, "");
    expect(() => createClient({})).toThrow(API_KEY_ENV);
  });

  it("targets the product's API by default and sends the bearer token", async () => {
    const { fetch, requests } = fakeFetch(() => Response.json(workspace));
    const api = createClient({ token: "sk_x", workspace: "acme", fetch });
    const { data } = await api.GET("/workspace");
    expect(data).toEqual(workspace);
    expectTypeOf(data).toEqualTypeOf<Schemas["Workspace"] | undefined>();
    expect(DEFAULT_BASE_URL).toBe(`https://api.${brand.domain}`);
    expect(requests[0].url).toBe(`${DEFAULT_BASE_URL}/v1/workspace`);
    expect(requests[0].headers.get("authorization")).toBe("Bearer sk_x");
    expect(requests[0].headers.get("x-workspace")).toBe("acme");
  });

  it("honours a custom origin (trailing slash tolerated) and a per-call X-Workspace", async () => {
    const { fetch, requests } = fakeFetch(() => Response.json(workspace));
    const api = createClient({
      token: "pat_x",
      workspace: "acme",
      baseURL: "http://localhost:8787/",
      fetch,
    });
    await api.GET("/workspace", { headers: { "x-workspace": "beta" } });
    expect(requests[0].url).toBe("http://localhost:8787/v1/workspace");
    expect(requests[0].headers.get("x-workspace")).toBe("beta");
    // No workspace configured → no header (the /user surface never needs one).
    const bare = createClient({ token: "pat_x", fetch });
    await bare.GET("/user/me");
    expect(requests[1].headers.has("x-workspace")).toBe(false);
  });

  it("reads <NAME>_BASE_URL when baseURL is not passed", async () => {
    const { fetch, requests } = fakeFetch(() => Response.json(workspace));
    vi.stubEnv(BASE_URL_ENV, "http://localhost:9000");
    await createClient({ token: "sk_x", fetch }).GET("/workspace");
    expect(requests[0].url).toBe("http://localhost:9000/v1/workspace");
    await createClient({ token: "sk_x", fetch, baseURL: "http://b" }).GET(
      "/workspace",
    );
    expect(requests[1].url).toBe("http://b/v1/workspace");
  });

  it("sends defaultHeaders and its User-Agent, a call's own headers winning", async () => {
    const { fetch, requests } = fakeFetch(() => Response.json(workspace));
    const api = createClient({
      token: "sk_x",
      fetch,
      defaultHeaders: { "x-team": "core", "x-trace": "a" },
    });
    await api.workspace.get({ headers: { "x-trace": "b" } });
    expect(requests[0].headers.get("x-team")).toBe("core");
    expect(requests[0].headers.get("x-trace")).toBe("b");
    expect(USER_AGENT).toBe(`${brand.name}-node/${VERSION}`);
    expect(requests[0].headers.get("user-agent")).toBe(USER_AGENT);
  });

  it("sends X-Environment only when an environment is given (a call may name its own)", async () => {
    const { fetch, requests } = fakeFetch(() => Response.json(workspace));
    const live = createClient({
      token: "pat_x",
      workspace: "acme",
      environment: "live",
      fetch,
    });
    await live.GET("/workspace");
    expect(requests[0].headers.get("x-environment")).toBe("live");
    await live.GET("/workspace", { headers: { "x-environment": "test" } });
    expect(requests[1].headers.get("x-environment")).toBe("test");
    // None given → no header: the API acts in the product's default.
    await createClient({ token: "pat_x", workspace: "acme", fetch }).GET(
      "/workspace",
    );
    expect(requests[2].headers.has("x-environment")).toBe(false);
  });

  it("unwrap returns data, or throws an APIError (a subclass per status) carrying the envelope", async () => {
    const { fetch } = fakeFetch((request) =>
      request.url.endsWith("/workspace")
        ? Response.json(workspace)
        : Response.json(
            {
              error: {
                code: "forbidden",
                message: "Not a member",
                requestId: "req_1",
              },
            },
            { status: 403 },
          ),
    );
    const api = createClient({ token: "pat_x", workspace: "acme", fetch });
    expect(unwrap(await api.GET("/workspace"))).toEqual(workspace);
    const failure = await api.GET("/workspace/audit-events").catch(() => null);
    expect(failure).not.toBeNull();
    let thrown: unknown;
    try {
      unwrap(failure!);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDeniedError);
    expect(thrown).toBeInstanceOf(APIError);
    const apiError = thrown as APIError;
    expect(apiError.status).toBe(403);
    expect(apiError.code).toBe("forbidden");
    expect(apiError.message).toBe("Not a member");
    expect(apiError.requestId).toBe("req_1");
  });
});
