import { describe, expect, it } from "vitest";

import { shouldEngage } from "./ragGate";
import type { RagFileContext } from "./ragRouter";

const files = (names: string[]): RagFileContext[] =>
	names.map((name, index) => ({ id: `f_${index}`, name, chunkCount: 5 }));

describe("ragGate.shouldEngage", () => {
	it("returns false when there are no files", () => {
		expect(shouldEngage("summarize my file", [])).toBe(false);
	});

	it("returns false for pure greetings", () => {
		expect(shouldEngage("hi", files(["auth.py"]))).toBe(false);
		expect(shouldEngage("hello", files(["auth.py"]))).toBe(false);
		expect(shouldEngage("how are you", files(["auth.py"]))).toBe(false);
	});

	it("returns false for math/general knowledge with files present", () => {
		expect(shouldEngage("what is 2+2", files(["auth.py"]))).toBe(false);
		expect(shouldEngage("explain photosynthesis", files(["auth.py"]))).toBe(false);
	});

	it("returns true when query names an uploaded file", () => {
		expect(shouldEngage("show me auth.py", files(["auth.py"]))).toBe(true);
		expect(shouldEngage("what's in the authentication file", files(["authentication.py"]))).toBe(
			true
		);
	});

	it("returns true for content-verb queries with files present", () => {
		expect(shouldEngage("summarize", files(["auth.py"]))).toBe(true);
		expect(shouldEngage("give me the login function", files(["auth.py"]))).toBe(true);
		expect(shouldEngage("explain the code", files(["auth.py"]))).toBe(true);
		expect(shouldEngage("what does this file do", files(["auth.py"]))).toBe(true);
		expect(shouldEngage("walk me through", files(["auth.py"]))).toBe(true);
	});

	it("returns true for file/doc reference words", () => {
		expect(shouldEngage("from my upload", files(["x.pdf"]))).toBe(true);
		expect(shouldEngage("in the document", files(["x.pdf"]))).toBe(true);
		expect(shouldEngage("what's in my file", files(["x.pdf"]))).toBe(true);
	});

	it("returns true for code identifiers that match file content keywords", () => {
		expect(shouldEngage("explain authenticate function", files(["auth.py"]))).toBe(true);
	});

	it("returns false for unrelated identifiers when no file matches", () => {
		expect(shouldEngage("write me a poem about cats", files(["auth.py"]))).toBe(false);
	});

	it("returns true for inventory-style meta queries", () => {
		expect(shouldEngage("what files do I have", files(["auth.py"]))).toBe(true);
		expect(shouldEngage("list my uploads", files(["auth.py"]))).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(shouldEngage("SUMMARIZE AUTH.PY", files(["auth.py"]))).toBe(true);
		expect(shouldEngage("Hi", files(["auth.py"]))).toBe(false);
	});
});
