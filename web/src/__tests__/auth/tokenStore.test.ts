import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetTokenStoreForTests,
  clearBearerToken,
  getBearerToken,
  setBearerToken,
  subscribeToken,
} from "../../auth/tokenStore";

beforeEach(() => {
  __resetTokenStoreForTests();
});

describe("tokenStore", () => {
  it("starts empty", () => {
    expect(getBearerToken()).toBeNull();
  });

  it("set then get round-trips the token", () => {
    setBearerToken("abc");
    expect(getBearerToken()).toBe("abc");
  });

  it("clearBearerToken removes the token", () => {
    setBearerToken("abc");
    clearBearerToken();
    expect(getBearerToken()).toBeNull();
  });

  it("notifies subscribers when the token changes", () => {
    const events: (string | null)[] = [];
    subscribeToken((t) => events.push(t));
    setBearerToken("first");
    setBearerToken("second");
    clearBearerToken();
    expect(events).toEqual(["first", "second", null]);
  });

  it("does not notify subscribers when the token is unchanged", () => {
    const events: (string | null)[] = [];
    subscribeToken((t) => events.push(t));
    setBearerToken("same");
    setBearerToken("same");
    expect(events).toEqual(["same"]);
  });

  it("unsubscribe stops further notifications", () => {
    const events: (string | null)[] = [];
    const unsubscribe = subscribeToken((t) => events.push(t));
    setBearerToken("one");
    unsubscribe();
    setBearerToken("two");
    expect(events).toEqual(["one"]);
  });
});
