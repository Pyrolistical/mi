import { access, readFile, stat } from "node:fs/promises";
import type { MediaContent } from "@earendil-works/pi-ai";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { detectSupportedMediaMimeTypeFromFile, toMediaContent } from "../utils/mime.ts";
import { stripBom } from "../utils/text.ts";
import { red } from "../utils/colors.ts";

export interface ProcessedFiles {
	text: string;
	images: MediaContent[];
}

export async function processFileArguments(fileArgs: string[]): Promise<ProcessedFiles> {
	let text = "";
	const images: MediaContent[] = [];

	for (const fileArg of fileArgs) {
		const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

		try {
			await access(absolutePath);
		} catch {
			console.error(red(`Error: File not found: ${absolutePath}`));
			process.exit(1);
		}

		const stats = await stat(absolutePath);
		if (stats.size === 0) {
			continue;
		}

		const mimeType = await detectSupportedMediaMimeTypeFromFile(absolutePath);

		if (mimeType) {
			const content = await readFile(absolutePath);
			images.push(toMediaContent(content.toString("base64"), mimeType));
			text += `<file name="${absolutePath}"></file>\n`;
		} else {
			try {
				const content = stripBom(await readFile(absolutePath, "utf-8"));
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(red(`Error: Could not read file ${absolutePath}: ${message}`));
				process.exit(1);
			}
		}
	}

	return { text, images };
}
