import { beforeEach, describe, expect, test, vi } from "bun:test";
import { readClipboardImage } from "../src/utils/clipboard-image.ts";

const mocks = {
	command: vi.fn<(command: string, args: string[], options?: unknown) => Promise<Buffer | undefined>>(),
};

vi.mock("../src/utils/clipboard-command.ts", () => ({ runClipboardCommand: mocks.command }));

function commandResult(stdout: Buffer, status = 0): Buffer | undefined {
	return status === 0 ? stdout : undefined;
}

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

describe("readClipboardImage", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.command.mockResolvedValue(commandResult(Buffer.alloc(0), 1));
	});

	for (const [backend, command, env] of [
		["wayland", "wl-paste", { WAYLAND_DISPLAY: "1", DISPLAY: ":0" }],
		["x11", "xclip", { DISPLAY: ":0" }],
	] as const) {
		test.each([true, false])(`${backend}: command image present=%s stops fallback`, async (present) => {
			mocks.command.mockImplementation(async (name, args) => {
				expect(name).toBe(command);
				const listing = args.includes("--list-types") || args.includes("TARGETS");
				return commandResult(listing ? Buffer.from(present ? "text/plain\nimage/png\n" : "text/plain\n") : png);
			});
			expect(await readClipboardImage({ platform: "linux", env })).toEqual(
				present ? { bytes: png, mimeType: "image/png" } : null,
			);
			expect(mocks.command).toHaveBeenCalledTimes(present ? 2 : 1);
		});
	}

	test("X11 does not probe image types when TARGETS fails", async () => {
		mocks.command.mockImplementation(async (_command, args) =>
			args.includes("TARGETS") ? undefined : Buffer.from("hello"),
		);
		expect(await readClipboardImage({ platform: "linux", env: { DISPLAY: ":0" } })).toBeNull();
		expect(mocks.command).toHaveBeenCalledTimes(1);
		expect(mocks.command).toHaveBeenCalledWith(
			"xclip",
			["-selection", "clipboard", "-t", "TARGETS", "-o"],
			{ timeoutMs: 1000 },
		);
	});

	test("X11 does not probe unadvertised image types", async () => {
		mocks.command.mockImplementation(async (_command, args) => {
			if (args.includes("TARGETS")) return Buffer.from("image/png\n");
			if (args.includes("image/png")) return undefined;
			return Buffer.from("hello");
		});
		expect(await readClipboardImage({ platform: "linux", env: { DISPLAY: ":0" } })).toBeNull();
		expect(mocks.command.mock.calls.map(([, args]) => args[3])).toEqual(["TARGETS", "image/png"]);
	});

	test("Wayland: falls back to X11 after wl-paste fails", async () => {
		mocks.command.mockImplementation(async (command, args) => {
			if (command === "wl-paste") return commandResult(Buffer.alloc(0), 1);
			return commandResult(args.includes("TARGETS") ? Buffer.from("image/png\n") : Buffer.from(png));
		});
		expect(await readClipboardImage({ platform: "linux", env: { WAYLAND_DISPLAY: "1" } })).toEqual({
			bytes: png,
			mimeType: "image/png",
		});
	});

	test.each(["darwin"] as const)("%s: returns null without running commands", async (platform) => {
		expect(await readClipboardImage({ platform, env: {} })).toBeNull();
		expect(mocks.command).not.toHaveBeenCalled();
	});

	test("Termux does not read image clipboards", async () => {
		expect(await readClipboardImage({ platform: "linux", env: { TERMUX_VERSION: "0.119" } })).toBeNull();
		expect(mocks.command).not.toHaveBeenCalled();
	});
});
