import { expect, test } from "bun:test";
import { parseFilter } from "../../server/filter";

test("parses eq filters", () => {
  expect(parseFilter("doc_id=eq.123")).toEqual({ column: "doc_id", value: "123" });
  expect(parseFilter("email=eq.a=b.c")).toEqual({ column: "email", value: "a=b.c" });
});

test("no filter", () => {
  expect(parseFilter(undefined)).toBeUndefined();
  expect(parseFilter("")).toBeUndefined();
});

test("rejects unsupported or unsafe filters", () => {
  expect(parseFilter("id=gt.5")).toBeNull();
  expect(parseFilter('"id"=eq.5')).toBeNull();
  expect(parseFilter("id; drop table x=eq.1")).toBeNull();
  expect(parseFilter(42)).toBeNull();
});
