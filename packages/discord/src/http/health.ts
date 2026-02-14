import { HttpLayerRouter, HttpServerResponse } from "@effect/platform"
import { BunHttpServer } from "@effect/platform-bun"
import { Context, Effect, Layer } from "effect"
import { AppConfig } from "../config"
import { DiscordClient } from "../discord/client"
import { SessionStore } from "../session/store"

export declare namespace HealthServer {
  export interface Service {
    readonly started: true
  }
}

export class HealthServer extends Context.Tag("@discord/HealthServer")<HealthServer, HealthServer.Service>() {
  static readonly layer = Layer.scoped(
    HealthServer,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const client = yield* DiscordClient
      const sessions = yield* SessionStore
      const startedAt = Date.now()

      const routes = HttpLayerRouter.use((router) =>
        Effect.all([
          router.add(
            "GET",
            "/healthz",
            Effect.gen(function* () {
              const activeSessions = yield* sessions.listActive().pipe(
                Effect.catchAll(() => Effect.succeed([])),
                Effect.map((rows) => rows.length),
              )
              return HttpServerResponse.unsafeJson({
                ok: true,
                uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
                discordReady: client.isReady(),
                activeSessions,
              })
            }),
          ),
          router.add(
            "GET",
            "/readyz",
            Effect.sync(() => {
              const ready = client.isReady()
              return HttpServerResponse.unsafeJson({ ok: ready, discordReady: ready }, { status: ready ? 200 : 503 })
            }),
          ),
        ]),
      )

      const server = HttpLayerRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provide(
          BunHttpServer.layer({
            hostname: config.healthHost,
            port: config.healthPort,
          }),
        ),
      )

      yield* Layer.launch(server).pipe(Effect.forkScoped)

      yield* Effect.logInfo("Health server started").pipe(
        Effect.annotateLogs({ event: "health.server.started", host: config.healthHost, port: config.healthPort }),
      )

      return {
        started: true as const,
      }
    }),
  )
}
