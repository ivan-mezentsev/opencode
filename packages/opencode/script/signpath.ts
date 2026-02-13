#!/usr/bin/env bun

import { sign } from "../../../script/signpath.ts"

for (const artifactId of process.env.INPUT_ARTIFACTS!.split("\n")) {
  await sign({
    outputDirectory: process.env.OUTPUT_ARTIFACT_DIRECTORY!,
    artifactId: artifactId.trim(),
  })
}
