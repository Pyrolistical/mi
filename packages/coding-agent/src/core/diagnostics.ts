export interface ResourceCollision {
	resourceType: "extension" | "skill" | "prompt";
	name: string;
	winnerPath: string;
	loserPath: string;
	winnerSource?: string;
	loserSource?: string;
}

export interface ResourceDiagnostic {
	type: "warning" | "error" | "collision";
	message: string;
	path?: string;
	collision?: ResourceCollision;
}
