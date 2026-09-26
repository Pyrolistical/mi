function color(open: number): (text: string) => string {
	return (text) => (Bun.enableANSIColors ? `\x1b[${open}m${text}\x1b[39m` : text);
}

export const red = color(31);
export const yellow = color(33);
export const gray = color(90);
