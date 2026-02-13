#!/usr/bin/env bun

import { $ } from "bun"
import { sign } from "../../../script/signpath.ts"

const artifacts: Array<[string, string]> = JSON.parse(process.env.INPUT_ARTIFACTS!)

for (const [artifactId, path] of artifacts) {
  await sign({
    outputDirectory: process.env.OUTPUT_ARTIFACT_DIRECTORY!,
    artifactId: artifactId.trim(),
  })

  await $`cp -r ${process.env.OUTPUT_ARTIFACT_DIRECTORY!}/* ${path}/..`
}
