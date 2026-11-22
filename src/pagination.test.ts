import { describe, expect, expectTypeOf, it } from "vitest";

import { createClient, Page, type Schemas } from "./index.ts";

/** Auto-paging (./pagination.ts): a list is a page, and every item. */
function members(pages: string[][]) {
  const cursors: (string | null)[] = [];
  const client = createClient({
    token: "sk_x",
    fetch: async (request) => {
      const cursor = new URL(request.url).searchParams.get("cursor");
      cursors.push(cursor);
      const at = cursor === null ? 0 : Number(cursor);
      return Response.json({
        items: pages[at]!.map((id) => ({ id })),
        nextCursor: at + 1 < pages.length ? String(at + 1) : null,
      });
    },
  });
  return { client, cursors };
}

describe("lists", () => {
  it("await to the first page, with the way to the next", async () => {
    const { client, cursors } = members([["a", "b"], ["c"]]);
    const page = await client.workspace.members.list({ limit: 2 });
    expect(page).toBeInstanceOf(Page);
    expectTypeOf(page.items).toEqualTypeOf<Schemas["Member"][]>();
    expect(page.items.map((m) => m.id)).toEqual(["a", "b"]);
    expect(page.nextCursor).toBe("1");
    expect(page.hasNextPage()).toBe(true);
    const next = await page.getNextPage();
    expect(next.items.map((m) => m.id)).toEqual(["c"]);
    expect(next.hasNextPage()).toBe(false);
    await expect(next.getNextPage()).rejects.toThrow("No next page");
    expect(cursors).toEqual([null, "1"]);
  });

  it("iterate every item of every page, the call's input kept", async () => {
    const { client, cursors } = members([["a", "b"], ["c"], ["d"]]);
    const ids: string[] = [];
    for await (const member of client.workspace.members.list({ limit: 2 })) {
      ids.push(member.id);
    }
    expect(ids).toEqual(["a", "b", "c", "d"]);
    expect(cursors).toEqual([null, "1", "2"]);
    const page = await client.workspace.members.list();
    const pages: number[] = [];
    for await (const each of page.iterPages()) pages.push(each.items.length);
    expect(pages).toEqual([2, 1, 1]);
  });

  it("without a cursor field, have one page", async () => {
    const client = createClient({
      token: "sk_x",
      fetch: async () =>
        Response.json({ items: [{ id: "we_1" }], nextCursor: "x" }),
    });
    const page = await client.workspace.webhookEndpoints.list();
    expect(page.hasNextPage()).toBe(false);
  });
});
