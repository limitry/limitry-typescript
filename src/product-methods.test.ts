import { describe, expect, it, vi } from "vitest";

/** A product's own methods on the client (./product/index.ts `productMethods`). */
const state = vi.hoisted(() => ({ names: ["hello"] }));
vi.mock("./product/index.ts", () => ({
  productMethods: (client: { workspace: object }) =>
    Object.fromEntries(
      state.names.map((name) => [
        name,
        () =>
          `hi from a client with ${Object.keys(client.workspace).length > 0 ? "resources" : "nothing"}`,
      ]),
    ),
}));

import { createClient } from "./index.ts";

describe("productMethods", () => {
  it("sit on the client beside the generated methods", () => {
    const client = createClient({ token: "sk_x" }) as unknown as {
      hello: () => string;
      workspace: { get: unknown };
    };
    expect(client.hello()).toBe("hi from a client with resources");
    expect(typeof client.workspace.get).toBe("function");
  });

  it("may not take a name the client already has", () => {
    state.names = ["workspace"];
    expect(() => createClient({ token: "sk_x" })).toThrow(
      'productMethods: "workspace" is already a client method',
    );
    state.names = ["hello"];
  });
});
