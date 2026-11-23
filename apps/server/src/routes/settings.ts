import { type SettingKey, settingDefs } from "@mailmcp/core";
import { blobStoreFromConfig, testBlobStore } from "@mailmcp/storage";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../app";
import { requireRole, requireUser } from "../auth";

const KeyParams = z.object({
  key: z.enum(Object.keys(settingDefs) as [SettingKey, ...SettingKey[]]),
});

export async function settingsRoutes(app: FastifyInstance, { db, settings, config }: AppDeps) {
  const auth = requireUser(db);
  const admin = [auth, requireRole("owner", "admin")];

  app.get("/api/v1/settings/:key", { preHandler: auth }, async (req) => {
    const { key } = KeyParams.parse(req.params);
    return settings.getPublic(key);
  });

  app.put("/api/v1/settings/:key", { preHandler: admin }, async (req) => {
    const { key } = KeyParams.parse(req.params);
    return settings.put(key, req.body, { orgId: req.user.orgId, userId: req.user.id });
  });

  /** Test storage settings (as submitted, merged with stored secrets) without saving. */
  app.post("/api/v1/settings/storage/test", { preHandler: admin }, async (req) => {
    const current = await settings.get("storage");
    const body = (req.body ?? {}) as { s3?: { secretAccessKey?: string } };
    const merged = settingDefs.storage.schema.parse({
      ...body,
      s3: {
        ...(body.s3 ?? {}),
        secretAccessKey: body.s3?.secretAccessKey || current.s3.secretAccessKey,
      },
    });
    try {
      await testBlobStore(blobStoreFromConfig(merged, config.dataDir));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: { message: (err as Error).message } };
    }
  });
}
