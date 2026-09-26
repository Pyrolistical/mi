function color(open: number): (text: string) => string {
	return (text) => `\x1b[${open}m${text}\x1b[39m`;
}

export const red = color(31);
export const green = color(32);
export const yellow = color(33);
export const blue = color(34);
export const magenta = color(35);
export const cyan = color(36);
export const gray = color(90);
