import { access, readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";
import { stripBom } from "../utils/text.ts";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export async function processFileArguments(fileArgs: string[]): Promise<ProcessedFiles> {
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

		try {
			await access(absolutePath);
		} catch {
			console.error(chalk.red(`Error: File not found: ${absolutePath}`));
			process.exit(1);
		}

		const stats = await stat(absolutePath);
		if (stats.size === 0) {
			continue;
		}

		const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);

		if (mimeType) {
			const content = await readFile(absolutePath);
			images.push({ type: "image", mimeType, data: content.toString("base64") });
			text += `<file name="${absolutePath}"></file>\n`;
		} else {
			try {
				const content = stripBom(await readFile(absolutePath, "utf-8"));
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
				process.exit(1);
			}
		}
	}

	return { text, images };
}
