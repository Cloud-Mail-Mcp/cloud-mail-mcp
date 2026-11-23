import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app";
import { requireRole, requireUser } from "../auth";
import { build, checkForUpdates, requestUpdate, updaterState } from "../updates";

export async function systemRoutes(
  app: FastifyInstance,
  { db, config, masterKeyInfo, settings }: AppDeps,
) {
  const auth = requireUser(db);
  const owner = [auth, requireRole("owner", "admin")];

  /** Read-only facts about this instance, shown on the Settings page. */
  app.get("/api/v1/system", { preHandler: auth }, async () => ({
    dataDir: config.dataDir,
    masterKey: masterKeyInfo,
    version: build.version,
    revision: build.revision,
    repo: build.repo || null,
    channel: build.channel,
    updater: await updaterState(),
  }));

  app.get("/api/v1/system/updates", { preHandler: auth }, async (req) => {
    const { force } = z.object({ force: z.coerce.boolean().optional() }).parse(req.query);
    const general = await settings.get("general");
    if (!general.checkForUpdates && !force) return { disabled: true };
    return checkForUpdates(force);
  });

  app.post("/api/v1/system/update", { preHandler: owner }, async (req, reply) => {
    const { channel } = z
      .object({ channel: z.enum(["stable", "edge"]).optional() })
      .parse(req.body ?? {});
    const state = await updaterState();
    if (!state.online) {
      return reply.code(409).send({
        error:
          "The updater isn't running, so update from the command line instead (shown on this page).",
      });
    }
    const r = await requestUpdate(
      req.user.email,
      channel ? (channel === "edge" ? "edge" : "latest") : undefined,
    );
    reply.code(202);
    return { requested: r.id };
  });
}
