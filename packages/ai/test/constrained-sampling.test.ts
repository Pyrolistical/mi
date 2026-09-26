import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	appendGrammarToolInputJsonDelta,
	makeStrictJsonSchema,
	resolveJsonSchemaStrictSampling,
} from "../src/api/constrained-sampling.ts";
import type { Tool } from "../src/types.ts";

function makeTool(overrides: Partial<Tool> = {}): Tool {
	return {
		name: "sample_tool",
		description: "Sample tool",
		parameters: Type.Object({ payload: Type.String() }, { additionalProperties: false }),
		...overrides,
	};
}

describe("constrained tool sampling", () => {
	it("derives strict provider schemas without changing tool definitions", () => {
		const parameters = Type.Object({
			path: Type.String(),
			offset: Type.Optional(Type.Number()),
			metadata: Type.Object({ enabled: Type.Optional(Type.Boolean()) }),
			nullable: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		});

		const strict = makeStrictJsonSchema(parameters);

		expect(parameters).not.toHaveProperty("additionalProperties");
		expect(parameters.required).toEqual(["path", "metadata"]);
		expect(strict).toMatchObject({
			additionalProperties: false,
			required: ["path", "offset", "metadata", "nullable"],
			properties: {
				offset: { anyOf: [{ type: "number" }, { type: "null" }] },
				metadata: {
					additionalProperties: false,
					required: ["enabled"],
					properties: { enabled: { anyOf: [{ type: "boolean" }, { type: "null" }] } },
				},
				nullable: { anyOf: [{ type: "string" }, { type: "null" }] },
			},
		});
	});

	it("falls back or rejects schemas that cannot be safely converted", () => {
		const cases: Array<{ parameters: Tool["parameters"]; error: string }> = [
			{
				parameters: Type.Object({ metadata: Type.Object({}, { additionalProperties: Type.String() }) }),
				error: "additionalProperties is unsupported",
			},
			{
				parameters: Type.Intersect([Type.Object({ a: Type.String() }), Type.Object({ b: Type.Number() })]),
				error: "allOf schemas are unsupported",
			},
			{
				parameters: Type.Object({
					value: Type.Union([Type.Object({ nested: Type.String() }), Type.Null()]),
				}),
				error: "object and array unions are unsupported",
			},
			{
				parameters: {
					type: "object",
					properties: { child: { $ref: "https://example.com/child.json" } },
					required: ["child"],
				} as Tool["parameters"],
				error: "$ref schemas are unsupported",
			},
		];

		for (const { parameters, error } of cases) {
			const tool: Tool = {
				...makeTool(),
				parameters,
				constrainedSampling: { type: "json_schema", strict: "prefer" },
			};

			expect(() => makeStrictJsonSchema(parameters)).toThrow(error);
			expect(resolveJsonSchemaStrictSampling(tool, true)).toBeUndefined();

			tool.constrainedSampling = { type: "json_schema", strict: "require" };
			expect(() => resolveJsonSchemaStrictSampling(tool, true)).toThrow(error);
		}
	});

	it("keeps grammar input JSON deltas append-only", () => {
		const buffer = { input: "", started: false, closed: false };
		const first = appendGrammarToolInputJsonDelta(buffer, "payload", 'a"', false);
		const second = appendGrammarToolInputJsonDelta(buffer, "payload", 'a"\nb', true);

		expect(JSON.parse(`${first}${second}`)).toEqual({ payload: 'a"\nb' });
		expect(appendGrammarToolInputJsonDelta(buffer, "payload", 'a"\nb', true)).toBeUndefined();
		expect(() => appendGrammarToolInputJsonDelta(buffer, "payload", "changed", true)).toThrow(
			'grammar tool input for property "payload" changed after it was closed',
		);
	});
});
