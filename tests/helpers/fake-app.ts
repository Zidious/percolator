import type { HerdrApp } from '../../src/herdr/app.ts';

/** In-memory `HerdrApp`: records `newSpace` calls as `[name, folder]`; `fail(message)` makes it throw. */
export class FakeHerdrApp implements HerdrApp {
  calls: [string, string][] = [];
  /** id returned by `newSpace` */
  spaceId = 'space-1';
  #failure: string | undefined;

  fail(message: string): void {
    this.#failure = message;
  }

  async newSpace(name: string, folder: string): Promise<string> {
    this.calls.push([name, folder]);
    if (this.#failure !== undefined) throw new Error(this.#failure);
    return this.spaceId;
  }
}
