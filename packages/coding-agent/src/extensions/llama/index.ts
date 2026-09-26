import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { createLlamaProvider } from "./provider.ts";

export default function llamaExtension(pi: ExtensionAPI): void {
	pi.registerProvider(createLlamaProvider());
}
