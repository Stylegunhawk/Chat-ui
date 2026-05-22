import { describe, it, expect } from "vitest";
import { buildSrcdoc } from "./buildSrcdoc";

describe("buildSrcdoc", () => {
	it("wraps bare HTML in head/body with base tag", () => {
		const result = buildSrcdoc("<!doctype html><html><head></head><body>hi</body></html>", "ch1");
		expect(result).toContain('<base target="_blank">');
		expect(result).toContain("chatui.preview.error");
	});

	it("detects SVG and wraps it in an HTML page", () => {
		const result = buildSrcdoc('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', "ch2");
		expect(result).toContain("<!doctype html>");
		expect(result).toContain("<svg");
	});

	it("injects base tag into existing head", () => {
		const html = "<!doctype html><html><head><title>T</title></head><body></body></html>";
		const result = buildSrcdoc(html, "ch3");
		expect(result.indexOf('<base target="_blank">')).toBeGreaterThan(
			result.indexOf("<head>")
		);
	});
});
