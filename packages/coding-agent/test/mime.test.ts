import { describe, expect, it } from "bun:test";
import { detectSupportedMediaMimeType } from "../src/utils/mime.ts";

describe("detectSupportedMediaMimeType", () => {
	it.each([
		["000000186674797069736f6d0000020069736f6d6d703432", "video/mp4"],
		["00000014667479707174202000000000717420", "video/quicktime"],
		["1a45dfa39f4286810142f7810142f2810442f381084282847765626d", "video/webm"],
		["1a45dfa3a34286810142f7810142f2810442f381084282886d6174726f736b61", "video/x-matroska"],
		["5249464600000000415649204c495354", "video/x-msvideo"],
	])("detects %s as %s", (hex, mimeType) => {
		expect(detectSupportedMediaMimeType(Buffer.from(hex, "hex"))).toBe(mimeType);
	});
});
