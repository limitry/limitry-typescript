/**
 * Auto-paging, as OpenAI's SDK pages (owner, 2026-11-22). A list answers
 * one page on the wire, `{ items, nextCursor }`; its method returns a
 * PagePromise, which is two things at once:
 *
 *   const page = await client.workspace.members.list();   // the first page
 *   page.items; page.hasNextPage(); await page.getNextPage();
 *
 *   for await (const member of client.workspace.members.list()) { … }
 *                                                          // every item
 *
 * Each next page is the same call with `cursor` set to the last page's
 * `nextCursor`, and the call's options (its signal, timeout, headers)
 * hold for every page.
 */

/** A list's answer on the wire. */
export type PageBody<Item> = { items: Item[]; nextCursor: string | null };

/** One page of a list, and the way to the next. */
export class Page<Item> implements AsyncIterable<Item> {
  /** This page's items. */
  items: Item[];
  /** The cursor for the next page; null on the last one. */
  nextCursor: string | null;
  readonly #next: ((cursor: string) => PagePromise<Item>) | null;

  constructor(
    body: PageBody<Item>,
    next: ((cursor: string) => PagePromise<Item>) | null,
  ) {
    // The answer's own fields first, so a list that adds one keeps it.
    Object.assign(this, body);
    this.items = body.items;
    this.nextCursor = body.nextCursor ?? null;
    this.#next = next;
  }

  /** Whether another page follows this one. */
  hasNextPage(): boolean {
    return this.#next !== null && typeof this.nextCursor === "string";
  }

  /** The next page; throws when this is the last one (see hasNextPage). */
  getNextPage(): Promise<Page<Item>> {
    if (!this.hasNextPage()) {
      return Promise.reject(
        new Error("No next page: check hasNextPage() first"),
      );
    }
    return this.#next!(this.nextCursor!);
  }

  /** This page and every page after it. */
  async *iterPages(): AsyncGenerator<Page<Item>> {
    yield this;
    let page = this.hasNextPage() ? await this.getNextPage() : null;
    while (page) {
      yield page;
      page = page.hasNextPage() ? await page.getNextPage() : null;
    }
  }

  /** Every item, from this page on, fetching each next page as it goes. */
  async *[Symbol.asyncIterator](): AsyncGenerator<Item> {
    for await (const page of this.iterPages()) yield* page.items;
  }
}

/**
 * What a list method returns: awaited, the first page; iterated with
 * `for await`, every item of every page.
 */
export class PagePromise<Item>
  implements Promise<Page<Item>>, AsyncIterable<Item>
{
  readonly #page: Promise<Page<Item>>;
  readonly [Symbol.toStringTag] = "PagePromise";

  constructor(page: Promise<Page<Item>>) {
    this.#page = page;
  }

  then<A = Page<Item>, B = never>(
    onFulfilled?: ((page: Page<Item>) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.#page.then(onFulfilled, onRejected);
  }

  catch<B = never>(
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<Page<Item> | B> {
    return this.#page.catch(onRejected);
  }

  finally(onFinally?: (() => void) | null): Promise<Page<Item>> {
    return this.#page.finally(onFinally);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Item> {
    yield* await this.#page;
  }
}

/**
 * The pages of a list: `fetch(cursor)` makes the call for one page (no
 * cursor for the first). `paged` false for a list that takes no
 * cursor: its one page has no next one.
 */
export function pages<Item>(
  fetch: (cursor: string | undefined) => Promise<PageBody<Item>>,
  paged: boolean,
): PagePromise<Item> {
  const load = (cursor: string | undefined): PagePromise<Item> =>
    new PagePromise(
      fetch(cursor).then((body) => new Page(body, paged ? load : null)),
    );
  return load(undefined);
}
