#!/usr/bin/env bun
import "./bun/sandbox-env-setup.ts";
import { setupCli } from "./cli/setup.ts";
import { main } from "./main.ts";

setupCli();
main(process.argv.slice(2));
