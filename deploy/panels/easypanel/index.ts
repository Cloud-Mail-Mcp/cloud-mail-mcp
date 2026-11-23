// Easypanel template (see meta.yaml). Lives in easypanel-io/templates, not built with this repo.
import { Output, randomPassword, Services } from "~templates-utils";
import { Input } from "./meta";

export function generate(input: Input): Output {
  const services: Services = [];
  const databasePassword = randomPassword();

  services.push({
    type: "postgres",
    data: {
      serviceName: input.databaseServiceName,
      password: databasePassword,
    },
  });

  services.push({
    type: "app",
    data: {
      serviceName: input.appServiceName,
      source: { type: "image", image: input.appServiceImage },
      domains: [{ host: "$(EASYPANEL_DOMAIN)", port: 8787 }],
      env: [
        `DATABASE_URL=postgres://postgres:${databasePassword}@$(PROJECT_NAME)_${input.databaseServiceName}:5432/$(PROJECT_NAME)?sslmode=disable`,
        "TRUST_PROXY=true",
        "SECURE_COOKIES=true",
      ].join("\n"),
      mounts: [{ type: "volume", name: "data", mountPath: "/data" }],
    },
  });

  return { services };
}
